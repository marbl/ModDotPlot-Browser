//! Narrow, worker-oriented WebAssembly API for moddotplot-rs.

#[cfg(test)]
use moddotplot_core::hash::HashAlgorithm;
use moddotplot_core::{
    CompositionIndex, CompositionIndexBuilder, DEFAULT_COMPOSITION_BLOCK_SIZE, FastaParser,
    FrozenAxis, KmerTileRequest, MatrixTile, PackedSequence,
    ScientificConfig as CoreScientificConfig, ScientificConfigIdentity, SparseCorrectionPolicy,
    TileRequest, build_axis_range, compute_frozen_tile, compute_frozen_tile_adaptive,
    compute_kmer_tile,
};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::rc::Rc;
use wasm_bindgen::prelude::*;

const MAX_CACHED_AXIS_BYTES: usize = 192 * 1024 * 1024;
const MAX_PREPARED_AXIS_BYTES: usize = 384 * 1024 * 1024;
const MAX_WASM_SESSION_BYTES: usize = 3 * 1024 * 1024 * 1024;
const MAX_PENDING_PREPARATION_TILE_BYTES: usize = 16 * 1024 * 1024;
const MAX_TILE_EDGE: usize = 256;

/// Core-owned immutable configuration used by browser preparation and tile requests.
#[wasm_bindgen(js_name = ScientificConfig)]
pub struct BrowserScientificConfig {
    inner: CoreScientificConfig,
}

#[wasm_bindgen(js_class = ScientificConfig)]
impl BrowserScientificConfig {
    /// Constructs one production quality tier from user-controlled values.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error if the k-mer length or register count is invalid.
    #[wasm_bindgen(constructor)]
    pub fn new(k: u8, register_count: usize, sparse_correction: bool) -> Result<Self, JsError> {
        let inner = CoreScientificConfig::production_default(k, register_count, sparse_correction)
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(Self { inner })
    }

    /// Stable hexadecimal digest covering every scientific field.
    #[wasm_bindgen(getter)]
    pub fn digest(&self) -> String {
        format!("{:016x}", self.inner.digest())
    }

    /// Scientific-contract schema version.
    #[wasm_bindgen(getter)]
    pub fn version(&self) -> u16 {
        self.inner.version()
    }

    /// Canonical k-mer length.
    #[wasm_bindgen(getter)]
    pub fn k(&self) -> u8 {
        self.inner.k()
    }

    /// OPH register count.
    #[wasm_bindgen(getter)]
    pub fn register_count(&self) -> usize {
        self.inner.register_count()
    }

    /// HLL precision selected by the core release configuration.
    #[wasm_bindgen(getter)]
    pub fn hll_precision(&self) -> u8 {
        self.inner.hll_precision()
    }

    /// Low-bit candidate width.
    #[wasm_bindgen(getter)]
    pub fn b_bits(&self) -> u8 {
        self.inner.b_bits()
    }

    /// Winner verification width.
    #[wasm_bindgen(getter)]
    pub fn verification_bits(&self) -> u8 {
        self.inner.verification_bits()
    }

    /// Exact sparse-core retention cap; zero means disabled.
    #[wasm_bindgen(getter)]
    pub fn sparse_core_cap(&self) -> usize {
        self.inner.sparse_core_cap()
    }

    /// Stable production hash identifier.
    #[wasm_bindgen(getter)]
    pub fn hash_algorithm(&self) -> String {
        self.inner.hash_algorithm().as_str().to_owned()
    }

    /// Public deterministic hash seed, encoded losslessly for JavaScript.
    #[wasm_bindgen(getter)]
    pub fn hash_seed(&self) -> String {
        self.inner.hash_seed().to_string()
    }

    /// OPH resemblance estimator identifier.
    #[wasm_bindgen(getter)]
    pub fn estimator(&self) -> String {
        self.inner.oph_estimator().as_str().to_owned()
    }

    /// ANI floor used by optional sparse correction.
    #[wasm_bindgen(getter)]
    pub fn ani_floor(&self) -> f64 {
        self.inner.ani_floor()
    }

    /// Sparse match-detection probability target.
    #[wasm_bindgen(getter)]
    pub fn minimum_detection_probability(&self) -> f64 {
        self.inner.minimum_detection_probability()
    }

    /// Fixed-point scale of the identity channel.
    #[wasm_bindgen(getter)]
    pub fn identity_scale(&self) -> u16 {
        self.inner.identity_scale()
    }

    /// Missing-value sentinel of the identity channel.
    #[wasm_bindgen(getter)]
    pub fn missing_identity(&self) -> u16 {
        self.inner.missing_identity()
    }
}

#[derive(Clone, Debug, Serialize)]
struct SequenceMetadata {
    index: usize,
    name: String,
    length: u64,
}

struct PreparedComparison {
    x: FrozenAxis,
    y: Option<FrozenAxis>,
    x_index: usize,
    y_index: usize,
    domain_length: u64,
    config: CoreScientificConfig,
}

struct ComparisonPreparation {
    x_index: usize,
    y_index: usize,
    domain_length: u64,
    resolution: usize,
    config: CoreScientificConfig,
    axis: u8,
    x_next_bin: usize,
    y_next_bin: usize,
    progressive_tiles: bool,
    progressive_tile_origins: Option<HashSet<(usize, usize)>>,
    x_parts: Vec<FrozenAxis>,
    y_parts: Vec<FrozenAxis>,
}

struct PendingPreparationTile {
    x: usize,
    y: usize,
    inner: MatrixTile,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ComparisonContext {
    x_index: usize,
    y_index: usize,
    domain_length: u64,
    k: u8,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct AxisCacheKey {
    sequence_index: usize,
    resolution: usize,
    start: usize,
    count: usize,
    scientific_identity: ScientificConfigIdentity,
}

struct AxisCacheEntry {
    axis: Rc<FrozenAxis>,
    bytes: usize,
    last_used: u64,
}

fn validate_axis_cache_identity(
    key: AxisCacheKey,
    config: CoreScientificConfig,
) -> Result<(), &'static str> {
    if key.scientific_identity == config.identity() {
        Ok(())
    } else {
        Err("zoom-axis cache key does not match its scientific configuration")
    }
}

/// Stateful compute session owned by one dedicated browser worker.
#[wasm_bindgen]
pub struct ComputeSession {
    parser: Option<FastaParser>,
    sequences: Vec<PackedSequence>,
    comparison: Option<ComparisonContext>,
    prepared_levels: BTreeMap<usize, PreparedComparison>,
    preparation: Option<ComparisonPreparation>,
    pending_preparation_tiles: VecDeque<PendingPreparationTile>,
    pending_preparation_tile_bytes: usize,
    axis_cache: HashMap<AxisCacheKey, AxisCacheEntry>,
    cache_recency: BTreeMap<u64, AxisCacheKey>,
    cache_clock: u64,
    axis_cache_bytes: usize,
    composition_indices: HashMap<usize, CompositionIndex>,
    composition_builders: HashMap<usize, CompositionIndexBuilder>,
}

#[wasm_bindgen]
impl ComputeSession {
    /// Creates an empty session.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        console_error_panic_hook::set_once();
        Self {
            parser: None,
            sequences: Vec::new(),
            comparison: None,
            prepared_levels: BTreeMap::new(),
            preparation: None,
            pending_preparation_tiles: VecDeque::new(),
            pending_preparation_tile_bytes: 0,
            axis_cache: HashMap::new(),
            cache_recency: BTreeMap::new(),
            cache_clock: 0,
            axis_cache_bytes: 0,
            composition_indices: HashMap::new(),
            composition_builders: HashMap::new(),
        }
    }

    /// Starts one FASTA file. Multiple files can be appended to the same session.
    ///
    /// # Errors
    ///
    /// Returns an error if another FASTA stream is already active.
    pub fn begin_fasta(&mut self) -> Result<(), JsError> {
        if self.parser.is_some() {
            return Err(JsError::new("a FASTA stream is already active"));
        }
        self.parser = Some(FastaParser::new());
        Ok(())
    }

    /// Pushes one raw FASTA byte chunk and returns metadata for records completed by it.
    ///
    /// # Errors
    ///
    /// Returns an error if no stream is active, the FASTA is malformed, or JavaScript
    /// metadata serialization fails.
    pub fn push_fasta_chunk(&mut self, chunk: &[u8]) -> Result<JsValue, JsError> {
        let parser = self
            .parser
            .as_mut()
            .ok_or_else(|| JsError::new("begin_fasta must be called first"))?;
        let completed = parser
            .push_chunk(chunk)
            .map_err(|error| JsError::new(&error.to_string()))?;
        self.append_records(completed)
    }

    /// Finishes the active FASTA file and returns final record metadata.
    ///
    /// # Errors
    ///
    /// Returns an error if no stream is active, the final FASTA record is invalid, or
    /// JavaScript metadata serialization fails.
    pub fn finish_fasta(&mut self) -> Result<JsValue, JsError> {
        let parser = self
            .parser
            .take()
            .ok_or_else(|| JsError::new("no FASTA stream is active"))?;
        let completed = parser
            .finish()
            .map_err(|error| JsError::new(&error.to_string()))?;
        self.append_records(completed)
    }

    /// Returns metadata for every loaded record.
    ///
    /// # Errors
    ///
    /// Returns an error if JavaScript metadata serialization fails.
    pub fn sequences(&self) -> Result<JsValue, JsError> {
        let metadata = self.metadata_for_range(0, self.sequences.len());
        serde_wasm_bindgen::to_value(&metadata).map_err(|error| JsError::new(&error.to_string()))
    }

    /// Estimates application-owned Rust/Wasm bytes currently retained by the session.
    ///
    /// Allocator metadata, temporary peak allocations, JavaScript buffers, and GPU
    /// textures are intentionally excluded.
    pub fn estimated_memory_bytes(&self) -> usize {
        let mut bytes = estimated_sequence_bytes(&self.sequences, self.sequences.capacity());
        for prepared in self.prepared_levels.values() {
            bytes = bytes
                .saturating_add(std::mem::size_of::<PreparedComparison>())
                .saturating_add(prepared.x.estimated_heap_bytes());
            if let Some(y) = &prepared.y {
                bytes = bytes.saturating_add(y.estimated_heap_bytes());
            }
        }
        if let Some(preparation) = &self.preparation {
            bytes = bytes.saturating_add(std::mem::size_of::<ComparisonPreparation>());
            if let Some(origins) = &preparation.progressive_tile_origins {
                bytes = bytes.saturating_add(
                    origins
                        .capacity()
                        .saturating_mul(std::mem::size_of::<(usize, usize)>())
                        .saturating_mul(2),
                );
            }
            for part in preparation.x_parts.iter().chain(&preparation.y_parts) {
                bytes = bytes
                    .saturating_add(std::mem::size_of::<FrozenAxis>())
                    .saturating_add(part.estimated_heap_bytes());
            }
        }
        bytes = bytes
            .saturating_add(
                self.pending_preparation_tiles
                    .capacity()
                    .saturating_mul(std::mem::size_of::<PendingPreparationTile>()),
            )
            .saturating_add(self.pending_preparation_tile_bytes);
        bytes = bytes
            .saturating_add(
                self.axis_cache
                    .capacity()
                    .saturating_mul(std::mem::size_of::<(AxisCacheKey, AxisCacheEntry)>()),
            )
            .saturating_add(self.axis_cache_bytes)
            .saturating_add(
                self.cache_recency
                    .len()
                    .saturating_mul(std::mem::size_of::<(u64, AxisCacheKey)>()),
            );
        bytes = bytes.saturating_add(
            self.composition_indices
                .capacity()
                .saturating_mul(std::mem::size_of::<(usize, CompositionIndex)>()),
        );
        for index in self.composition_indices.values() {
            bytes = bytes.saturating_add(index.estimated_heap_bytes());
        }
        bytes = bytes.saturating_add(
            self.composition_builders
                .capacity()
                .saturating_mul(std::mem::size_of::<(usize, CompositionIndexBuilder)>()),
        );
        for builder in self.composition_builders.values() {
            bytes = bytes.saturating_add(builder.estimated_heap_bytes());
        }
        bytes
    }

    /// Configured upper bound for application-owned Wasm session memory.
    pub fn memory_budget_bytes(&self) -> usize {
        MAX_WASM_SESSION_BYTES
    }

    /// Starts chunked overview construction from one validated scientific configuration.
    ///
    /// # Errors
    ///
    /// Returns an error for missing sequence indexes or invalid sketch parameters.
    pub fn begin_prepare_scientific(
        &mut self,
        x_index: usize,
        y_index: usize,
        resolution: usize,
        config: &BrowserScientificConfig,
        progressive_tiles: bool,
    ) -> Result<(), JsError> {
        if resolution == 0 {
            return Err(JsError::new("resolution must be positive"));
        }
        let config = config.inner;
        let x_sequence = self
            .sequences
            .get(x_index)
            .ok_or_else(|| JsError::new("x sequence index is out of range"))?;
        let y_sequence = self
            .sequences
            .get(y_index)
            .ok_or_else(|| JsError::new("y sequence index is out of range"))?;
        let domain_length = x_sequence.len().max(y_sequence.len()).max(1);
        let same_comparison = self
            .prepared_levels
            .values()
            .next()
            .is_some_and(|prepared| {
                prepared.x_index == x_index
                    && prepared.y_index == y_index
                    && prepared.x.resolution == resolution
                    && prepared.config.k() == config.k()
                    && prepared.config.hash_algorithm() == config.hash_algorithm()
                    && prepared.config.hash_seed() == config.hash_seed()
            });
        let axis_count = if x_index == y_index { 1 } else { 2 };
        let retained_bytes = if same_comparison {
            self.estimated_memory_bytes()
        } else {
            estimated_sequence_bytes(&self.sequences, self.sequences.capacity())
        };
        validate_prepared_axis_admission(resolution, config, axis_count, retained_bytes)
            .map_err(JsError::new)?;
        if !same_comparison {
            self.prepared_levels.clear();
            self.clear_axis_cache();
        }
        self.comparison = Some(ComparisonContext {
            x_index,
            y_index,
            domain_length,
            k: config.k(),
        });
        self.preparation = Some(ComparisonPreparation {
            x_index,
            y_index,
            domain_length,
            resolution,
            config,
            axis: 0,
            x_next_bin: 0,
            y_next_bin: 0,
            progressive_tiles,
            progressive_tile_origins: None,
            x_parts: Vec::new(),
            y_parts: Vec::new(),
        });
        self.clear_pending_preparation_tiles();
        Ok(())
    }

    /// Restricts progressive preparation tiles to the supplied `(x,y)` origins.
    ///
    /// Axis construction is unchanged; the filter prevents unselected matrix blocks
    /// from being compared merely to make selected detailed blocks visible early.
    ///
    /// # Errors
    ///
    /// Returns an error for an odd coordinate array or an origin outside the current
    /// preparation resolution.
    pub fn set_preparation_tile_filter(&mut self, coordinates: &[u32]) -> Result<(), JsError> {
        if !coordinates.len().is_multiple_of(2) {
            return Err(JsError::new(
                "preparation tile coordinates must be x/y pairs",
            ));
        }
        let preparation = self
            .preparation
            .as_mut()
            .ok_or_else(|| JsError::new("begin_prepare_comparison must be called first"))?;
        let mut origins = HashSet::with_capacity(coordinates.len() / 2);
        let (pairs, remainder) = coordinates.as_chunks::<2>();
        debug_assert!(remainder.is_empty());
        for &[x_coordinate, y_coordinate] in pairs {
            let x = usize::try_from(x_coordinate)
                .map_err(|_| JsError::new("preparation tile x origin is unsupported"))?;
            let y = usize::try_from(y_coordinate)
                .map_err(|_| JsError::new("preparation tile y origin is unsupported"))?;
            if x >= preparation.resolution || y >= preparation.resolution {
                return Err(JsError::new(
                    "preparation tile origin lies outside its resolution",
                ));
            }
            origins.insert((x, y));
        }
        preparation.progressive_tile_origins = Some(origins);
        Ok(())
    }

    /// Selects an axis pair without constructing sketches, for an initially exact view.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid k-mer length or missing sequence index.
    pub fn select_exact_comparison(
        &mut self,
        x_index: usize,
        y_index: usize,
        k: u8,
    ) -> Result<(), JsError> {
        let config = CoreScientificConfig::production_default(k, 2, false)
            .map_err(|error| JsError::new(&error.to_string()))?;
        let x_length = self
            .sequences
            .get(x_index)
            .ok_or_else(|| JsError::new("x sequence index is out of range"))?
            .len();
        let y_length = self
            .sequences
            .get(y_index)
            .ok_or_else(|| JsError::new("y sequence index is out of range"))?
            .len();
        self.preparation = None;
        self.clear_pending_preparation_tiles();
        self.prepared_levels.clear();
        self.clear_axis_cache();
        self.comparison = Some(ComparisonContext {
            x_index,
            y_index,
            domain_length: x_length.max(y_length).max(1),
            k: config.k(),
        });
        Ok(())
    }

    /// Abandons an in-progress overview refinement while retaining completed levels.
    pub fn cancel_preparation(&mut self) {
        self.preparation = None;
        self.clear_pending_preparation_tiles();
    }

    /// Reports whether the requested overview register level is ready.
    pub fn has_prepared_level(&self, register_count: usize) -> bool {
        self.prepared_levels.contains_key(&register_count)
    }

    /// Retains only the two register levels selected for the next browser generation.
    ///
    /// Zoom-axis ranges are view-specific, so they are released when a new plot
    /// generation begins even when its overview sketches remain reusable.
    pub fn retain_prepared_levels(&mut self, preview_registers: usize, detailed_registers: usize) {
        self.prepared_levels.retain(|registers, _| {
            *registers == preview_registers || *registers == detailed_registers
        });
        self.clear_axis_cache();
    }

    /// Builds the next contiguous group of overview bins and returns progress in `[0,1]`.
    ///
    /// # Errors
    ///
    /// Returns an error if preparation has not begun or `maximum_bins` is zero.
    pub fn prepare_comparison_chunk(&mut self, maximum_bins: usize) -> Result<f64, JsError> {
        if maximum_bins == 0 {
            return Err(JsError::new("preparation chunk size must be positive"));
        }
        let mut state = self
            .preparation
            .take()
            .ok_or_else(|| JsError::new("begin_prepare_comparison must be called first"))?;
        let building_axis = state.axis;
        let sequence_index = if building_axis == 0 {
            state.x_index
        } else {
            state.y_index
        };
        let sequence = self
            .sequences
            .get(sequence_index)
            .ok_or_else(|| JsError::new("preparation sequence index is out of range"))?;
        let next_bin = if building_axis == 0 {
            state.x_next_bin
        } else {
            state.y_next_bin
        };
        let count = maximum_bins.min(state.resolution - next_bin);
        let part = build_axis_range(
            sequence,
            state.domain_length,
            state.resolution,
            next_bin,
            count,
            state.config,
        )
        .map_err(|error| JsError::new(&error.to_string()))?
        .freeze();
        if building_axis == 0 {
            state.x_parts.push(part);
            state.x_next_bin += count;
        } else {
            state.y_parts.push(part);
            state.y_next_bin += count;
        }
        if state.progressive_tiles && count <= MAX_TILE_EDGE {
            for tile in progressive_tiles_for_part(&state, building_axis) {
                self.push_pending_preparation_tile(tile);
            }
        }
        let complete = state.x_next_bin == state.resolution
            && (state.x_index == state.y_index || state.y_next_bin == state.resolution);
        if complete {
            let x = join_axis_parts(std::mem::take(&mut state.x_parts));
            let y = if state.x_index == state.y_index {
                None
            } else {
                Some(join_axis_parts(std::mem::take(&mut state.y_parts)))
            };
            self.prepared_levels.insert(
                state.config.register_count(),
                PreparedComparison {
                    x,
                    y,
                    x_index: state.x_index,
                    y_index: state.y_index,
                    domain_length: state.domain_length,
                    config: state.config,
                },
            );
            return Ok(1.0);
        }
        if state.x_index != state.y_index {
            state.axis = if state.progressive_tiles {
                u8::from(building_axis == 0)
            } else {
                u8::from(state.x_next_bin >= state.resolution)
            };
        }
        let axis_count = if state.x_index == state.y_index { 1 } else { 2 };
        let completed = state.x_next_bin.saturating_add(state.y_next_bin);
        let completed = u32::try_from(completed)
            .map_err(|_| JsError::new("overview resolution is too large for progress reporting"))?;
        let total = u32::try_from(axis_count * state.resolution)
            .map_err(|_| JsError::new("overview resolution is too large for progress reporting"))?;
        let progress = f64::from(completed) / f64::from(total);
        self.preparation = Some(state);
        Ok(progress)
    }

    /// Removes the oldest tile made available during chunked axis preparation.
    ///
    /// The browser drains this queue after every preparation chunk so diagonal and
    /// comparison blocks can paint before the complete overview axis is available.
    pub fn take_preparation_tile(&mut self) -> Option<WasmPreparationTile> {
        let tile = self.pending_preparation_tiles.pop_front()?;
        self.pending_preparation_tile_bytes = self
            .pending_preparation_tile_bytes
            .saturating_sub(matrix_tile_heap_bytes(&tile.inner));
        Some(WasmPreparationTile {
            x: tile.x,
            y: tile.y,
            inner: tile.inner,
        })
    }

    /// Computes one clipped numeric tile from the prepared comparison.
    ///
    /// # Errors
    ///
    /// Returns an error if no comparison is prepared or `b_bits` is outside `1..=32`.
    pub fn compute_tile_scientific(
        &self,
        x_start: usize,
        y_start: usize,
        width: usize,
        height: usize,
        config: &BrowserScientificConfig,
    ) -> Result<WasmTile, JsError> {
        let config = config.inner;
        let prepared = self
            .prepared_levels
            .get(&config.register_count())
            .ok_or_else(|| JsError::new("the requested overview register level is not prepared"))?;
        if prepared.config.digest() != config.digest() {
            return Err(JsError::new(
                "prepared level scientific configuration does not match",
            ));
        }
        validate_tile_request(prepared.x.resolution, x_start, y_start, width, height)?;
        let y = prepared.y.as_ref().unwrap_or(&prepared.x);
        let request = TileRequest {
            x_start,
            y_start,
            width,
            height,
            b_bits: config.b_bits(),
            register_limit: config.register_count(),
            k: config.k(),
        };
        let inner = if config.sparse_core_cap() > 0 {
            let x_sequence = &self.sequences[prepared.x_index];
            let y_sequence = &self.sequences[prepared.y_index];
            compute_frozen_tile_adaptive(
                &prepared.x,
                y,
                x_sequence,
                y_sequence,
                config.hash_algorithm(),
                config.hash_seed(),
                request,
                sparse_policy(config),
            )
        } else {
            compute_frozen_tile(&prepared.x, y, request)
        }
        .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(WasmTile { inner })
    }

    /// Computes one tile at a demand-selected zoom resolution.
    ///
    /// Axis sketches are constructed only for the requested x and y ranges, then
    /// retained in a bounded session cache so adjacent matrix tiles reuse them.
    ///
    /// # Errors
    ///
    /// Returns an error for an unprepared comparison, invalid coordinates, or invalid
    /// b-bit/register parameters.
    pub fn compute_zoom_tile_scientific(
        &mut self,
        resolution: usize,
        x_start: usize,
        y_start: usize,
        width: usize,
        height: usize,
        config: &BrowserScientificConfig,
    ) -> Result<WasmTile, JsError> {
        let config = config.inner;
        validate_tile_request(resolution, x_start, y_start, width, height)?;

        let prepared = self
            .prepared_levels
            .values()
            .find(|prepared| {
                prepared.x_index == self.comparison.map_or(usize::MAX, |pair| pair.x_index)
                    && prepared.y_index == self.comparison.map_or(usize::MAX, |pair| pair.y_index)
            })
            .ok_or_else(|| JsError::new("prepare_comparison must be called first"))?;
        let x_index = prepared.x_index;
        let y_index = prepared.y_index;
        let domain_length = prepared.domain_length;
        let x_count = width.min(resolution - x_start);
        let y_count = height.min(resolution - y_start);
        let x_key = AxisCacheKey {
            sequence_index: x_index,
            resolution,
            start: x_start,
            count: x_count,
            scientific_identity: config.identity(),
        };
        let y_key = AxisCacheKey {
            sequence_index: y_index,
            resolution,
            start: y_start,
            count: y_count,
            scientific_identity: config.identity(),
        };
        let x = self.axis_range(x_key, domain_length, config)?;
        let y = if x_key == y_key {
            Rc::clone(&x)
        } else {
            self.axis_range(y_key, domain_length, config)?
        };

        let request = TileRequest {
            x_start,
            y_start,
            width,
            height,
            b_bits: config.b_bits(),
            register_limit: config.register_count(),
            k: config.k(),
        };
        let inner = if config.sparse_core_cap() > 0 {
            compute_frozen_tile_adaptive(
                &x,
                &y,
                &self.sequences[x_index],
                &self.sequences[y_index],
                config.hash_algorithm(),
                config.hash_seed(),
                request,
                sparse_policy(config),
            )
        } else {
            compute_frozen_tile(&x, &y, request)
        }
        .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(WasmTile { inner })
    }

    /// Computes an exact canonical k-mer tile for the prepared sequence pair.
    ///
    /// # Errors
    ///
    /// Returns an error when no comparison is prepared or a coordinate cannot be
    /// represented in the shared domain.
    pub fn compute_kmer_tile(
        &self,
        x_start: u64,
        y_start: u64,
        width: usize,
        height: usize,
    ) -> Result<WasmTile, JsError> {
        let comparison = self
            .comparison
            .ok_or_else(|| JsError::new("select a comparison before requesting exact tiles"))?;
        if x_start >= comparison.domain_length || y_start >= comparison.domain_length {
            return Err(JsError::new(
                "base tile origin lies outside the sequence domain",
            ));
        }
        if width == 0 || height == 0 || width > MAX_TILE_EDGE || height > MAX_TILE_EDGE {
            return Err(JsError::new(
                "exact tile dimensions must be in 1..=256 before allocation",
            ));
        }
        let x = self
            .sequences
            .get(comparison.x_index)
            .ok_or_else(|| JsError::new("x sequence index is out of range"))?;
        let y = self
            .sequences
            .get(comparison.y_index)
            .ok_or_else(|| JsError::new("y sequence index is out of range"))?;
        let inner = compute_kmer_tile(
            x,
            y,
            KmerTileRequest {
                domain_length: comparison.domain_length,
                x_start,
                y_start,
                width,
                height,
                k: comparison.k,
            },
        )
        .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(WasmTile { inner })
    }

    /// Copies a bounded sequence range as ASCII for close-zoom rendering.
    ///
    /// # Errors
    ///
    /// Returns an error for a missing sequence index or an invalid range.
    pub fn sequence_ascii(
        &self,
        sequence_index: usize,
        start: u64,
        end: u64,
    ) -> Result<Vec<u8>, JsError> {
        let sequence = self
            .sequences
            .get(sequence_index)
            .ok_or_else(|| JsError::new("sequence index is out of range"))?;
        if start > end || end > sequence.len() {
            return Err(JsError::new("sequence label range is out of bounds"));
        }
        let mut output = Vec::with_capacity(
            usize::try_from(end - start)
                .map_err(|_| JsError::new("sequence range is too large"))?,
        );
        for position in start..end {
            let (code, valid) = sequence
                .get(position)
                .ok_or_else(|| JsError::new("sequence position is out of range"))?;
            output.push(if valid {
                b"ACGT"[usize::from(code)]
            } else {
                b'N'
            });
        }
        Ok(output)
    }

    /// Starts or resumes an on-demand GC index for one loaded sequence.
    ///
    /// Returns true when the index was already complete.
    ///
    /// # Errors
    ///
    /// Returns an error for a missing sequence index.
    pub fn begin_composition_index(&mut self, sequence_index: usize) -> Result<bool, JsError> {
        if self.composition_indices.contains_key(&sequence_index) {
            return Ok(true);
        }
        let sequence = self
            .sequences
            .get(sequence_index)
            .ok_or_else(|| JsError::new("GC sequence index is out of range"))?;
        self.composition_builders
            .entry(sequence_index)
            .or_insert_with(|| {
                CompositionIndexBuilder::new(sequence, DEFAULT_COMPOSITION_BLOCK_SIZE)
            });
        Ok(false)
    }

    /// Builds the next GC index chunk and returns completion in `[0, 1]`.
    ///
    /// # Errors
    ///
    /// Returns an error if indexing was not started or `maximum_blocks` is zero.
    pub fn prepare_composition_index_chunk(
        &mut self,
        sequence_index: usize,
        maximum_blocks: usize,
    ) -> Result<f64, JsError> {
        if maximum_blocks == 0 {
            return Err(JsError::new("GC preparation chunk size must be positive"));
        }
        let sequence = self
            .sequences
            .get(sequence_index)
            .ok_or_else(|| JsError::new("GC sequence index is out of range"))?;
        let builder = self
            .composition_builders
            .get_mut(&sequence_index)
            .ok_or_else(|| JsError::new("begin_composition_index must be called first"))?;
        let progress = builder.advance(sequence, maximum_blocks);
        if builder.is_complete() {
            let builder = self
                .composition_builders
                .remove(&sequence_index)
                .ok_or_else(|| JsError::new("completed GC builder was not retained"))?;
            let complete = builder
                .finish()
                .ok_or_else(|| JsError::new("GC index completion was inconsistent"))?;
            self.composition_indices.insert(sequence_index, complete);
        }
        Ok(progress)
    }

    /// Samples exact GC fractions for equal windows in a visible sequence range.
    ///
    /// # Errors
    ///
    /// Returns an error for an unavailable index, invalid range, or zero bins.
    pub fn gc_bins(
        &self,
        sequence_index: usize,
        start: u64,
        end: u64,
        bins: usize,
    ) -> Result<Vec<f64>, JsError> {
        if bins == 0 {
            return Err(JsError::new("GC bin count must be positive"));
        }
        let sequence = self
            .sequences
            .get(sequence_index)
            .ok_or_else(|| JsError::new("GC sequence index is out of range"))?;
        if start > end || end > sequence.len() {
            return Err(JsError::new("GC sequence range is out of bounds"));
        }
        let index = self
            .composition_indices
            .get(&sequence_index)
            .ok_or_else(|| JsError::new("GC index is not ready"))?;
        Ok(index.sample_gc(sequence, start, end, bins))
    }

    /// Samples `CpG` observed/expected ratios for equal windows in a visible range.
    ///
    /// # Errors
    ///
    /// Returns an error for an unavailable index, invalid range, or zero bins.
    pub fn cpg_observed_expected_bins(
        &self,
        sequence_index: usize,
        start: u64,
        end: u64,
        bins: usize,
    ) -> Result<Vec<f64>, JsError> {
        if bins == 0 {
            return Err(JsError::new("CpG bin count must be positive"));
        }
        let sequence = self
            .sequences
            .get(sequence_index)
            .ok_or_else(|| JsError::new("CpG sequence index is out of range"))?;
        if start > end || end > sequence.len() {
            return Err(JsError::new("CpG sequence range is out of bounds"));
        }
        let index = self
            .composition_indices
            .get(&sequence_index)
            .ok_or_else(|| JsError::new("composition index is not ready"))?;
        Ok(index.sample_cpg_observed_expected(sequence, start, end, bins))
    }

    /// Releases all sequence and comparison memory.
    pub fn clear(&mut self) {
        self.parser = None;
        self.comparison = None;
        self.prepared_levels.clear();
        self.preparation = None;
        self.clear_pending_preparation_tiles();
        self.sequences.clear();
        self.clear_axis_cache();
        self.composition_indices.clear();
        self.composition_builders.clear();
    }

    fn append_records(&mut self, records: Vec<PackedSequence>) -> Result<JsValue, JsError> {
        let first = self.sequences.len();
        self.sequences.extend(records);
        if self.estimated_memory_bytes() > MAX_WASM_SESSION_BYTES {
            self.sequences.truncate(first);
            return Err(JsError::new(
                "Loaded sequences exceed the 3 GiB Wasm session budget.",
            ));
        }
        let metadata = self.metadata_for_range(first, self.sequences.len());
        serde_wasm_bindgen::to_value(&metadata).map_err(|error| JsError::new(&error.to_string()))
    }

    fn metadata_for_range(&self, start: usize, end: usize) -> Vec<SequenceMetadata> {
        self.sequences[start..end]
            .iter()
            .enumerate()
            .map(|(offset, sequence)| SequenceMetadata {
                index: start + offset,
                name: sequence.name().to_owned(),
                length: sequence.len(),
            })
            .collect()
    }

    fn axis_range(
        &mut self,
        key: AxisCacheKey,
        domain_length: u64,
        config: CoreScientificConfig,
    ) -> Result<Rc<FrozenAxis>, JsError> {
        validate_axis_cache_identity(key, config).map_err(JsError::new)?;
        if let Some(entry) = self.axis_cache.get(&key) {
            let axis = Rc::clone(&entry.axis);
            self.touch_axis_cache(key);
            return Ok(axis);
        }
        let sequence = self
            .sequences
            .get(key.sequence_index)
            .ok_or_else(|| JsError::new("cached axis sequence index is out of range"))?;
        let admitted = estimated_frozen_axis_bytes(key.count, config);
        if admitted > MAX_CACHED_AXIS_BYTES {
            return Err(JsError::new(
                "A requested zoom axis exceeds the cache budget; reduce detailed accuracy.",
            ));
        }
        while self.axis_cache_bytes.saturating_add(admitted) > MAX_CACHED_AXIS_BYTES {
            let Some((_, expired)) = self.cache_recency.pop_first() else {
                break;
            };
            if let Some(entry) = self.axis_cache.remove(&expired) {
                self.axis_cache_bytes = self.axis_cache_bytes.saturating_sub(entry.bytes);
            }
        }
        if self.estimated_memory_bytes().saturating_add(admitted) > MAX_WASM_SESSION_BYTES {
            return Err(JsError::new(
                "The requested zoom level exceeds the Wasm session memory budget.",
            ));
        }
        let axis = Rc::new(
            build_axis_range(
                sequence,
                domain_length,
                key.resolution,
                key.start,
                key.count,
                config,
            )
            .map_err(|error| JsError::new(&error.to_string()))?
            .freeze(),
        );

        let bytes = std::mem::size_of::<FrozenAxis>().saturating_add(axis.estimated_heap_bytes());
        let last_used = self.next_cache_tick();
        self.axis_cache.insert(
            key,
            AxisCacheEntry {
                axis: Rc::clone(&axis),
                bytes,
                last_used,
            },
        );
        self.axis_cache_bytes = self.axis_cache_bytes.saturating_add(bytes);
        self.cache_recency.insert(last_used, key);
        self.prune_axis_cache();
        Ok(axis)
    }

    fn touch_axis_cache(&mut self, key: AxisCacheKey) {
        let next = self.next_cache_tick();
        if let Some(entry) = self.axis_cache.get_mut(&key) {
            self.cache_recency.remove(&entry.last_used);
            entry.last_used = next;
            self.cache_recency.insert(next, key);
        }
    }

    fn next_cache_tick(&mut self) -> u64 {
        self.cache_clock = self.cache_clock.wrapping_add(1);
        if self.cache_clock == 0 {
            let mut entries = self
                .axis_cache
                .iter()
                .map(|(key, entry)| (entry.last_used, *key))
                .collect::<Vec<_>>();
            entries.sort_unstable();
            self.cache_recency.clear();
            for (index, (_, key)) in entries.into_iter().enumerate() {
                let tick = u64::try_from(index + 1).expect("cache entry count fits u64");
                if let Some(entry) = self.axis_cache.get_mut(&key) {
                    entry.last_used = tick;
                }
                self.cache_recency.insert(tick, key);
            }
            self.cache_clock = u64::try_from(self.axis_cache.len()).expect("cache size fits u64");
            self.cache_clock += 1;
        }
        self.cache_clock
    }

    fn prune_axis_cache(&mut self) {
        while self.axis_cache_bytes > MAX_CACHED_AXIS_BYTES && self.axis_cache.len() > 1 {
            let Some((_, expired)) = self.cache_recency.pop_first() else {
                break;
            };
            if let Some(entry) = self.axis_cache.remove(&expired) {
                self.axis_cache_bytes = self.axis_cache_bytes.saturating_sub(entry.bytes);
            }
        }
    }

    fn clear_axis_cache(&mut self) {
        self.axis_cache.clear();
        self.cache_recency.clear();
        self.cache_clock = 0;
        self.axis_cache_bytes = 0;
    }

    fn push_pending_preparation_tile(&mut self, tile: PendingPreparationTile) {
        let bytes = matrix_tile_heap_bytes(&tile.inner);
        if self.pending_preparation_tile_bytes.saturating_add(bytes)
            > MAX_PENDING_PREPARATION_TILE_BYTES
        {
            return;
        }
        self.pending_preparation_tile_bytes =
            self.pending_preparation_tile_bytes.saturating_add(bytes);
        self.pending_preparation_tiles.push_back(tile);
    }

    fn clear_pending_preparation_tiles(&mut self) {
        self.pending_preparation_tiles.clear();
        self.pending_preparation_tile_bytes = 0;
    }
}

fn join_axis_parts(mut parts: Vec<FrozenAxis>) -> FrozenAxis {
    assert!(!parts.is_empty());
    let mut joined = parts.remove(0);
    for mut part in parts {
        assert_eq!(part.offset, joined.offset + joined.core_encoded.len());
        joined.bounds.append(&mut part.bounds);
        joined.core_encoded.append(&mut part.core_encoded);
        joined.expanded_encoded.append(&mut part.expanded_encoded);
        joined.sparse_core.append(&mut part.sparse_core);
    }
    joined
}

fn pending_tile(
    x: &FrozenAxis,
    y: &FrozenAxis,
    config: CoreScientificConfig,
) -> Option<PendingPreparationTile> {
    Some(PendingPreparationTile {
        x: x.offset,
        y: y.offset,
        inner: compute_frozen_tile(
            x,
            y,
            TileRequest {
                x_start: x.offset,
                y_start: y.offset,
                width: x.core_encoded.len(),
                height: y.core_encoded.len(),
                b_bits: config.b_bits(),
                register_limit: config.register_count(),
                k: config.k(),
            },
        )
        .ok()?,
    })
}

fn progressive_tiles_for_part(
    state: &ComparisonPreparation,
    building_axis: u8,
) -> Vec<PendingPreparationTile> {
    if state.x_index == state.y_index {
        let Some(current) = state.x_parts.last() else {
            return Vec::new();
        };
        return state
            .x_parts
            .iter()
            .filter_map(|previous| selected_pending_tile(state, current, previous))
            .collect();
    }
    if building_axis == 0 {
        let Some(current) = state.x_parts.last() else {
            return Vec::new();
        };
        state
            .y_parts
            .iter()
            .filter_map(|y_part| selected_pending_tile(state, current, y_part))
            .collect()
    } else {
        let Some(current) = state.y_parts.last() else {
            return Vec::new();
        };
        state
            .x_parts
            .iter()
            .filter_map(|x_part| selected_pending_tile(state, x_part, current))
            .collect()
    }
}

fn selected_pending_tile(
    state: &ComparisonPreparation,
    x: &FrozenAxis,
    y: &FrozenAxis,
) -> Option<PendingPreparationTile> {
    if state
        .progressive_tile_origins
        .as_ref()
        .is_some_and(|origins| !origins.contains(&(x.offset, y.offset)))
    {
        return None;
    }
    pending_tile(x, y, state.config)
}

fn validate_tile_request(
    resolution: usize,
    x_start: usize,
    y_start: usize,
    width: usize,
    height: usize,
) -> Result<(), JsError> {
    if resolution == 0 || width == 0 || height == 0 {
        return Err(JsError::new(
            "resolution and tile dimensions must be positive",
        ));
    }
    if width > MAX_TILE_EDGE || height > MAX_TILE_EDGE {
        return Err(JsError::new(
            "tile dimensions must be at most 256 before allocation",
        ));
    }
    if x_start >= resolution || y_start >= resolution {
        return Err(JsError::new("tile origin lies outside its resolution"));
    }
    Ok(())
}

fn sparse_policy(config: CoreScientificConfig) -> SparseCorrectionPolicy {
    SparseCorrectionPolicy {
        ani_floor: config.ani_floor(),
        minimum_detection_probability: config.minimum_detection_probability(),
    }
}

fn estimated_frozen_axis_bytes(resolution: usize, config: CoreScientificConfig) -> usize {
    let words = config.register_count().div_ceil(64);
    let signature_words = usize::from(config.verification_bits()).saturating_add(3);
    let one_signature = signature_words
        .saturating_mul(words)
        .saturating_mul(std::mem::size_of::<u64>())
        .saturating_add(std::mem::size_of::<moddotplot_core::BitSlicedSignature>());
    let sparse = if config.sparse_core_cap() == 0 {
        0
    } else {
        config
            .sparse_core_cap()
            .saturating_mul(32)
            .saturating_add(std::mem::size_of::<
                Option<moddotplot_core::SparseCoreHashSet>,
            >())
    };
    resolution.saturating_mul(
        one_signature
            .saturating_mul(2)
            .saturating_add(sparse)
            .saturating_add(std::mem::size_of::<(u64, u64)>()),
    )
}

fn estimated_sequence_bytes(sequences: &[PackedSequence], capacity: usize) -> usize {
    std::mem::size_of::<ComputeSession>()
        .saturating_add(capacity.saturating_mul(std::mem::size_of::<PackedSequence>()))
        .saturating_add(
            sequences
                .iter()
                .map(PackedSequence::estimated_heap_bytes)
                .sum::<usize>(),
        )
}

fn validate_prepared_axis_admission(
    resolution: usize,
    config: CoreScientificConfig,
    axis_count: usize,
    current_session_bytes: usize,
) -> Result<usize, &'static str> {
    let admitted = estimated_frozen_axis_bytes(resolution, config)
        .checked_mul(axis_count)
        .ok_or("prepared-axis estimate overflowed")?;
    if admitted > MAX_PREPARED_AXIS_BYTES {
        return Err(
            "This quality tier exceeds the 384 MiB prepared-axis budget; lower plot detail or sketch accuracy.",
        );
    }
    if current_session_bytes.saturating_add(admitted) > MAX_WASM_SESSION_BYTES {
        return Err(
            "This comparison exceeds the Wasm session memory budget; lower plot detail or sketch accuracy.",
        );
    }
    Ok(admitted)
}

fn matrix_tile_heap_bytes(tile: &MatrixTile) -> usize {
    tile.identity
        .capacity()
        .saturating_mul(std::mem::size_of::<u16>())
        .saturating_add(
            tile.direction
                .capacity()
                .saturating_mul(std::mem::size_of::<i16>()),
        )
        .saturating_add(
            tile.direction_support
                .capacity()
                .saturating_mul(std::mem::size_of::<u16>()),
        )
}

impl Default for ComputeSession {
    fn default() -> Self {
        Self::new()
    }
}

/// Owned numeric tile copied to JavaScript typed arrays.
#[wasm_bindgen]
pub struct WasmTile {
    inner: MatrixTile,
}

/// Owned numeric tile produced while overview axes are still being prepared.
#[wasm_bindgen]
pub struct WasmPreparationTile {
    x: usize,
    y: usize,
    inner: MatrixTile,
}

#[wasm_bindgen]
impl WasmPreparationTile {
    /// Global x-axis cell origin.
    #[wasm_bindgen(getter)]
    pub fn x(&self) -> usize {
        self.x
    }

    /// Global y-axis cell origin.
    #[wasm_bindgen(getter)]
    pub fn y(&self) -> usize {
        self.y
    }

    /// Tile width.
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> usize {
        self.inner.width
    }

    /// Tile height.
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> usize {
        self.inner.height
    }

    /// ANI values multiplied by 10,000; `65535` is missing data.
    pub fn take_identity(&mut self) -> Vec<u16> {
        std::mem::take(&mut self.inner.identity)
    }

    /// Signed direction values in `[-32767, 32767]`.
    pub fn take_direction(&mut self) -> Vec<i16> {
        std::mem::take(&mut self.inner.direction)
    }

    /// Informative full-hash direction support.
    pub fn take_direction_support(&mut self) -> Vec<u16> {
        std::mem::take(&mut self.inner.direction_support)
    }
}

#[wasm_bindgen]
impl WasmTile {
    /// Tile width.
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> usize {
        self.inner.width
    }

    /// Tile height.
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> usize {
        self.inner.height
    }

    /// ANI values multiplied by 10,000; `65535` is missing data.
    pub fn take_identity(&mut self) -> Vec<u16> {
        std::mem::take(&mut self.inner.identity)
    }

    /// Signed direction values in `[-32767, 32767]`.
    pub fn take_direction(&mut self) -> Vec<i16> {
        std::mem::take(&mut self.inner.direction)
    }

    /// Informative full-hash direction support.
    pub fn take_direction_support(&mut self) -> Vec<u16> {
        std::mem::take(&mut self.inner.direction_support)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_and_detailed_overviews_remain_independent_and_bounded() {
        let mut session = ComputeSession::new();
        session
            .sequences
            .push(PackedSequence::from_ascii("sequence", b"ACGTACGTACGTACGT"));

        let preview = BrowserScientificConfig {
            inner: CoreScientificConfig::production(3, 2, 4, false).unwrap(),
        };
        let detailed = BrowserScientificConfig {
            inner: CoreScientificConfig::production(3, 4, 4, true).unwrap(),
        };
        session
            .begin_prepare_scientific(0, 0, 4, &preview, true)
            .expect("preview preparation starts");
        while session
            .prepare_comparison_chunk(4)
            .expect("preview preparation advances")
            < 1.0
        {}
        let mut progressive = session
            .take_preparation_tile()
            .expect("the completed self block is immediately available");
        assert_eq!((progressive.x(), progressive.y()), (0, 0));
        assert_eq!((progressive.width(), progressive.height()), (4, 4));
        let identity = progressive.take_identity();
        let direction = progressive.take_direction();
        let support = progressive.take_direction_support();
        assert_eq!(identity[0], 10_000);
        assert_eq!(identity[5], 10_000);
        let mut completed = session
            .compute_tile_scientific(0, 0, 4, 4, &preview)
            .expect("completed level remains available");
        assert_eq!(completed.take_identity(), identity);
        assert_eq!(completed.take_direction(), direction);
        assert_eq!(completed.take_direction_support(), support);
        assert!(session.take_preparation_tile().is_none());
        session
            .begin_prepare_scientific(0, 0, 4, &detailed, true)
            .expect("detailed preparation starts");
        while session
            .prepare_comparison_chunk(4)
            .expect("detailed preparation advances")
            < 1.0
        {}
        let detailed_progressive = session
            .take_preparation_tile()
            .expect("a detailed tile is available as soon as its axis block completes");
        assert_eq!((detailed_progressive.x(), detailed_progressive.y()), (0, 0));

        assert!(session.has_prepared_level(2));
        assert!(session.has_prepared_level(4));
        assert_eq!(
            session.prepared_levels[&2].x.core_encoded[0].register_count(),
            2
        );
        assert_eq!(
            session.prepared_levels[&4].x.core_encoded[0].register_count(),
            4
        );

        session.retain_prepared_levels(2, 2);
        assert!(session.has_prepared_level(2));
        assert!(!session.has_prepared_level(4));
    }

    #[test]
    fn pairwise_preparation_interleaves_axes_and_publishes_compatible_blocks() {
        let mut session = ComputeSession::new();
        session
            .sequences
            .push(PackedSequence::from_ascii("x", b"ACGTACGTACGTACGTACGTACGT"));
        session
            .sequences
            .push(PackedSequence::from_ascii("y", b"ACGTACGTTCGTACGTACGTACGT"));
        let preview = BrowserScientificConfig {
            inner: CoreScientificConfig::production(3, 4, 4, false).unwrap(),
        };
        session
            .begin_prepare_scientific(0, 1, 6, &preview, true)
            .unwrap();

        assert!((session.prepare_comparison_chunk(3).unwrap() - 0.25).abs() < f64::EPSILON);
        assert!(session.take_preparation_tile().is_none());
        assert!((session.prepare_comparison_chunk(3).unwrap() - 0.5).abs() < f64::EPSILON);
        let first = session
            .take_preparation_tile()
            .expect("the first compatible x/y block is available halfway through preparation");
        assert_eq!(
            (first.x(), first.y(), first.width(), first.height()),
            (0, 0, 3, 3)
        );

        assert!((session.prepare_comparison_chunk(3).unwrap() - 0.75).abs() < f64::EPSILON);
        let second = session.take_preparation_tile().unwrap();
        assert_eq!((second.x(), second.y()), (3, 0));
        assert!((session.prepare_comparison_chunk(3).unwrap() - 1.0).abs() < f64::EPSILON);
        let remaining = std::iter::from_fn(|| session.take_preparation_tile())
            .map(|tile| (tile.x(), tile.y()))
            .collect::<Vec<_>>();
        assert_eq!(remaining, [(0, 3), (3, 3)]);
    }

    #[test]
    fn progressive_preparation_filter_skips_unselected_matrix_blocks() {
        let mut session = ComputeSession::new();
        session
            .sequences
            .push(PackedSequence::from_ascii("x", b"ACGTACGTACGTACGTACGTACGT"));
        session
            .sequences
            .push(PackedSequence::from_ascii("y", b"ACGTACGTTCGTACGTACGTACGT"));
        let config = BrowserScientificConfig {
            inner: CoreScientificConfig::production(3, 4, 4, false).unwrap(),
        };
        session
            .begin_prepare_scientific(0, 1, 6, &config, true)
            .unwrap();
        session.set_preparation_tile_filter(&[3, 0]).unwrap();

        session.prepare_comparison_chunk(3).unwrap();
        session.prepare_comparison_chunk(3).unwrap();
        assert!(session.take_preparation_tile().is_none());
        session.prepare_comparison_chunk(3).unwrap();
        let selected = session.take_preparation_tile().unwrap();
        assert_eq!((selected.x(), selected.y()), (3, 0));
        session.prepare_comparison_chunk(3).unwrap();
        assert!(session.take_preparation_tile().is_none());
    }

    #[test]
    fn gc_index_builds_incrementally_and_is_reused() {
        let sequence = b"ACGT".repeat(600);
        let mut session = ComputeSession::new();
        session
            .sequences
            .push(PackedSequence::from_ascii("gc", &sequence));

        assert!(!session.begin_composition_index(0).unwrap());
        assert!(session.prepare_composition_index_chunk(0, 1).unwrap() < 1.0);
        while session.prepare_composition_index_chunk(0, 1).unwrap() < 1.0 {}
        assert!(session.begin_composition_index(0).unwrap());
        let values = session.gc_bins(0, 0, 2_400, 4).unwrap();
        assert!(
            values
                .iter()
                .all(|value| (value - 0.5).abs() < f64::EPSILON)
        );
    }

    #[test]
    fn over_budget_pairwise_axis_is_rejected_before_preparation() {
        let maximum = CoreScientificConfig::production(21, 4_096, 10, true).unwrap();
        let error = validate_prepared_axis_admission(10_000, maximum, 2, 0)
            .expect_err("oversized pairwise axes must fail admission");

        assert!(error.contains("prepared-axis budget"));
    }

    #[test]
    fn zoom_cache_uses_exact_scientific_identity_and_rejects_key_drift() {
        let mut session = ComputeSession::new();
        session.sequences.push(PackedSequence::from_ascii(
            "cache",
            b"ACGTACGTACGTACGTACGTACGTACGTACGT",
        ));
        let base = CoreScientificConfig::new(
            3,
            HashAlgorithm::NtHash2,
            0,
            4,
            2,
            32,
            moddotplot_core::OphJaccardEstimator::VerifiedWinners,
            4,
            0,
            0.80,
            0.99,
        )
        .unwrap();
        let changed_seed = CoreScientificConfig::new(
            3,
            HashAlgorithm::NtHash2,
            1,
            4,
            2,
            32,
            moddotplot_core::OphJaccardEstimator::VerifiedWinners,
            4,
            0,
            0.80,
            0.99,
        )
        .unwrap();
        let base_key = AxisCacheKey {
            sequence_index: 0,
            resolution: 4,
            start: 0,
            count: 4,
            scientific_identity: base.identity(),
        };
        session.axis_range(base_key, 32, base).unwrap();
        assert_eq!(session.axis_cache.len(), 1);

        let changed_key = AxisCacheKey {
            scientific_identity: changed_seed.identity(),
            ..base_key
        };
        session.axis_range(changed_key, 32, changed_seed).unwrap();
        assert_eq!(session.axis_cache.len(), 2);

        assert!(validate_axis_cache_identity(base_key, changed_seed).is_err());
    }
}
