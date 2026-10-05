//! Narrow, worker-oriented WebAssembly API for moddotplot-interactive.

mod cache;
mod composition;
mod preparation;
mod resource;
mod session;

use cache::{AxisCacheEntry, AxisCacheKey, validate_axis_cache_identity};
use composition::CompositionState;
use preparation::{
    ComparisonPreparation, PendingPreparationTile, PreparedComparison, join_axis_parts,
    progressive_tiles_for_part,
};
use resource::{
    MAX_CACHED_AXIS_BYTES, MAX_PENDING_PREPARATION_TILE_BYTES, MAX_TILE_EDGE,
    MAX_WASM_SESSION_BYTES, estimated_frozen_axis_bytes, estimated_sequence_bytes,
    matrix_tile_heap_bytes, validate_prepared_axis_admission,
};
use session::ComparisonContext;

#[cfg(test)]
use moddotplot_core::hash::HashAlgorithm;
use moddotplot_core::{
    CompositionIndex, CompositionIndexBuilder, DEFAULT_COMPOSITION_BLOCK_SIZE, FastaError,
    FastaParser, FrozenAxis, KmerTileGeometry, KmerTileRequest, MatrixTile, PackedSequence,
    ScientificConfig as CoreScientificConfig, ScientificConfigIdentity, TileBuildError,
    TileRequest, build_axis_range, compute_frozen_tile, compute_kmer_tile,
};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::rc::Rc;
use wasm_bindgen::prelude::*;

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
    pub fn new(k: u8, register_count: usize) -> Result<Self, JsError> {
        let inner = CoreScientificConfig::production_default(k, register_count, false)
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(Self { inner })
    }

    /// Stable hexadecimal digest covering every scientific field.
    #[wasm_bindgen(getter)]
    pub fn digest(&self) -> String {
        format!("{:016x}", self.inner.digest())
    }

    /// Canonical full scientific configuration identity encoded as lowercase hex.
    ///
    /// The shorter digest is useful provenance, while this full field encoding is
    /// the compatibility key used to validate persisted browser artifacts.
    #[wasm_bindgen(getter)]
    pub fn identity(&self) -> String {
        let bytes = self.inner.identity();
        let mut encoded = String::with_capacity(bytes.as_bytes().len() * 2);
        for byte in bytes.as_bytes() {
            use std::fmt::Write as _;
            write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
        }
        encoded
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
    description: String,
    length: u64,
}

/// Stateful compute session owned by one dedicated browser worker.
#[wasm_bindgen]
pub struct ComputeSession {
    parser: Option<FastaParser>,
    fasta_sequence_checkpoint: Option<usize>,
    sequences: Vec<PackedSequence>,
    sequence_heap_bytes: usize,
    comparison: Option<ComparisonContext>,
    prepared_levels: BTreeMap<usize, PreparedComparison>,
    preparation: Option<ComparisonPreparation>,
    pending_preparation_tiles: VecDeque<PendingPreparationTile>,
    pending_preparation_tile_bytes: usize,
    axis_cache: HashMap<AxisCacheKey, AxisCacheEntry>,
    cache_recency: BTreeMap<u64, AxisCacheKey>,
    cache_clock: u64,
    axis_cache_bytes: usize,
    composition: CompositionState,
}

#[wasm_bindgen]
impl ComputeSession {
    /// Creates an empty session.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        console_error_panic_hook::set_once();
        Self {
            parser: None,
            fasta_sequence_checkpoint: None,
            sequences: Vec::new(),
            sequence_heap_bytes: 0,
            comparison: None,
            prepared_levels: BTreeMap::new(),
            preparation: None,
            pending_preparation_tiles: VecDeque::new(),
            pending_preparation_tile_bytes: 0,
            axis_cache: HashMap::new(),
            cache_recency: BTreeMap::new(),
            cache_clock: 0,
            axis_cache_bytes: 0,
            composition: CompositionState::default(),
        }
    }

    /// Starts one FASTA file. Multiple files can be appended to the same session.
    ///
    /// # Errors
    ///
    /// Returns an error if another FASTA stream is already active.
    pub fn begin_fasta(&mut self) -> Result<(), JsError> {
        if self.parser.is_some() || self.fasta_sequence_checkpoint.is_some() {
            return Err(JsError::new("a FASTA stream is already active"));
        }
        self.fasta_sequence_checkpoint = Some(self.sequences.len());
        self.parser = Some(FastaParser::new());
        Ok(())
    }

    /// Abandons the active FASTA stream without changing committed sequences.
    ///
    /// Returns `true` when an in-progress parser was discarded and `false` when no
    /// stream was active. A new stream may begin immediately after this call.
    pub fn abort_fasta(&mut self) -> bool {
        let parser_was_active = self.parser.take().is_some();
        let transaction_was_active = self.rollback_fasta_transaction();
        parser_was_active || transaction_was_active
    }

    /// Pushes one raw FASTA byte chunk and returns metadata for records completed by it.
    ///
    /// # Errors
    ///
    /// Returns an error if no stream is active, the FASTA is malformed, or JavaScript
    /// metadata serialization fails.
    pub fn push_fasta_chunk(&mut self, chunk: &[u8]) -> Result<JsValue, JsError> {
        if self.parser.is_none() {
            return Err(JsError::new("begin_fasta must be called first"));
        }
        let completed = self
            .parse_fasta_chunk(chunk)
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
        let completed = match self.finish_fasta_records() {
            Ok(completed) => completed,
            Err(error) => {
                self.rollback_fasta_transaction();
                return Err(error);
            }
        };
        match self.append_records(completed) {
            Ok(metadata) => {
                self.fasta_sequence_checkpoint = None;
                Ok(metadata)
            }
            Err(error) => {
                self.rollback_fasta_transaction();
                Err(error)
            }
        }
    }

    /// Finishes one lazily loaded indexed record and commits it only when it exactly
    /// matches the name and length declared by the FAI index.
    ///
    /// # Errors
    ///
    /// Returns an error and rolls the whole FASTA transaction back when parsing,
    /// serialization, record count, name, or length validation fails.
    pub fn finish_indexed_fasta(
        &mut self,
        expected_name: &str,
        expected_length: u64,
    ) -> Result<JsValue, JsError> {
        let checkpoint = self
            .fasta_sequence_checkpoint
            .ok_or_else(|| JsError::new("begin_fasta must be called first"))?;
        let completed = match self.finish_fasta_records() {
            Ok(completed) => completed,
            Err(error) => {
                self.rollback_fasta_transaction();
                return Err(error);
            }
        };
        let metadata = match self.append_records(completed) {
            Ok(metadata) => metadata,
            Err(error) => {
                self.rollback_fasta_transaction();
                return Err(error);
            }
        };
        let matches_index = self.sequences.len() == checkpoint.saturating_add(1)
            && self.sequences.get(checkpoint).is_some_and(|sequence| {
                sequence.name() == expected_name && sequence.len() == expected_length
            });
        if !matches_index {
            self.rollback_fasta_transaction();
            return Err(JsError::new(
                "Indexed FASTA record does not match its FAI name and length.",
            ));
        }
        self.fasta_sequence_checkpoint = None;
        Ok(metadata)
    }

    fn parse_fasta_chunk(&mut self, chunk: &[u8]) -> Result<Vec<PackedSequence>, FastaError> {
        self.parser
            .as_mut()
            .expect("begin_fasta establishes a parser before internal ingestion")
            .push_chunk(chunk)
    }

    fn finish_fasta_records(&mut self) -> Result<Vec<PackedSequence>, JsError> {
        let parser = self
            .parser
            .take()
            .ok_or_else(|| JsError::new("no FASTA stream is active"))?;
        parser
            .finish()
            .map_err(|error| JsError::new(&error.to_string()))
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
        let mut bytes =
            estimated_sequence_bytes(self.sequence_heap_bytes, self.sequences.capacity());
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
        bytes = bytes.saturating_add(self.composition.estimated_heap_bytes());
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
                    && prepared.x.resolution() == resolution
                    && prepared.config.k() == config.k()
                    && prepared.config.hash_algorithm() == config.hash_algorithm()
                    && prepared.config.hash_seed() == config.hash_seed()
            });
        let axis_count = if x_index == y_index { 1 } else { 2 };
        let retained_bytes = if same_comparison {
            self.estimated_memory_bytes()
        } else {
            estimated_sequence_bytes(self.sequence_heap_bytes, self.sequences.capacity())
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
        validate_tile_request(prepared.x.resolution(), x_start, y_start, width, height)?;
        let y = prepared.y.as_ref().unwrap_or(&prepared.x);
        let request = TileRequest {
            x_start,
            y_start,
            width,
            height,
        };
        let inner = compute_scientific_tile(
            &prepared.x,
            y,
            &self.sequences[prepared.x_index],
            &self.sequences[prepared.y_index],
            config,
            request,
        )
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
    /// Returns an error when no sequence pair is selected, the selected k-mer length
    /// disagrees with the configuration, coordinates are invalid, or b-bit/register
    /// parameters are invalid.
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

        let comparison = self
            .comparison
            .ok_or_else(|| JsError::new("a comparison must be selected first"))?;
        if comparison.k != config.k() {
            return Err(JsError::new(
                "selected comparison k-mer length does not match the scientific configuration",
            ));
        }
        let x_index = comparison.x_index;
        let y_index = comparison.y_index;
        let domain_length = comparison.domain_length;
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
        };
        let inner = compute_scientific_tile(
            &x,
            &y,
            &self.sequences[x_index],
            &self.sequences[y_index],
            config,
            request,
        )
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
        anchors: bool,
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
                geometry: if anchors {
                    KmerTileGeometry::Anchors
                } else {
                    KmerTileGeometry::Footprints
                },
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
        self.composition.begin(&self.sequences, sequence_index)
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
        self.composition
            .advance(&self.sequences, sequence_index, maximum_blocks)
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
        self.composition
            .gc_bins(&self.sequences, sequence_index, start, end, bins)
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
        self.composition
            .cpg_bins(&self.sequences, sequence_index, start, end, bins)
    }

    /// Releases all sequence and comparison memory.
    pub fn clear(&mut self) {
        self.parser = None;
        self.fasta_sequence_checkpoint = None;
        self.comparison = None;
        self.prepared_levels.clear();
        self.preparation = None;
        self.clear_pending_preparation_tiles();
        self.sequences.clear();
        self.sequence_heap_bytes = 0;
        self.clear_axis_cache();
        self.composition.clear();
    }

    fn append_records(&mut self, records: Vec<PackedSequence>) -> Result<JsValue, JsError> {
        let previous_sequence_heap_bytes = self.sequence_heap_bytes;
        let first = self.extend_sequence_storage(records);
        if self.estimated_memory_bytes() > MAX_WASM_SESSION_BYTES {
            self.sequences.truncate(first);
            self.sequence_heap_bytes = previous_sequence_heap_bytes;
            return Err(JsError::new(
                "Loaded sequences exceed the 3 GiB Wasm session budget.",
            ));
        }
        let metadata = self.metadata_for_range(first, self.sequences.len());
        serde_wasm_bindgen::to_value(&metadata).map_err(|error| JsError::new(&error.to_string()))
    }

    fn extend_sequence_storage(&mut self, records: Vec<PackedSequence>) -> usize {
        let first = self.sequences.len();
        let added_heap_bytes = records.iter().fold(0_usize, |total, sequence| {
            total.saturating_add(sequence.estimated_heap_bytes())
        });
        self.sequence_heap_bytes = self.sequence_heap_bytes.saturating_add(added_heap_bytes);
        self.sequences.extend(records);
        first
    }

    fn rollback_fasta_transaction(&mut self) -> bool {
        let Some(checkpoint) = self.fasta_sequence_checkpoint.take() else {
            return false;
        };
        let removed_heap_bytes = self.sequences[checkpoint..]
            .iter()
            .fold(0_usize, |total, sequence| {
                total.saturating_add(sequence.estimated_heap_bytes())
            });
        self.sequences.truncate(checkpoint);
        self.sequence_heap_bytes = self.sequence_heap_bytes.saturating_sub(removed_heap_bytes);
        true
    }

    fn metadata_for_range(&self, start: usize, end: usize) -> Vec<SequenceMetadata> {
        self.sequences[start..end]
            .iter()
            .enumerate()
            .map(|(offset, sequence)| SequenceMetadata {
                index: start + offset,
                name: sequence.name().to_owned(),
                description: sequence.description().to_owned(),
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

fn compute_scientific_tile(
    x: &FrozenAxis,
    y: &FrozenAxis,
    x_sequence: &PackedSequence,
    y_sequence: &PackedSequence,
    config: CoreScientificConfig,
    request: TileRequest,
) -> Result<MatrixTile, TileBuildError> {
    let _ = (x_sequence, y_sequence, config);
    compute_frozen_tile(x, y, request)
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
    fn aborting_partial_fasta_preserves_committed_records_and_allows_restart() {
        let committed = PackedSequence::from_ascii("committed", b"ACGT");
        let committed_identity = committed.identity();
        let mut session = ComputeSession::new();
        session.extend_sequence_storage(vec![committed]);

        session.begin_fasta().unwrap();
        let provisional = session
            .parse_fasta_chunk(b">cancelled\nACGTAC\n>unfinished\nTG")
            .unwrap();
        assert_eq!(provisional.len(), 1);
        session.extend_sequence_storage(provisional);
        assert_eq!(session.sequences.len(), 2);
        assert!(session.abort_fasta());
        assert!(!session.abort_fasta());
        assert_eq!(session.sequences.len(), 1);
        assert_eq!(session.sequences[0].name(), "committed");
        assert_eq!(session.sequences[0].identity(), committed_identity);

        session.begin_fasta().unwrap();
        assert!(
            session
                .parse_fasta_chunk(b">replacement\nTGCA\n")
                .unwrap()
                .is_empty()
        );
        let completed = session.finish_fasta_records().unwrap();
        session.extend_sequence_storage(completed);
        assert_eq!(session.sequences.len(), 2);
        assert_eq!(session.sequences[1].name(), "replacement");
        assert_eq!(session.sequences[1].len(), 4);
    }

    #[test]
    fn aborting_invalid_fasta_preserves_committed_records_and_allows_restart() {
        let committed = PackedSequence::from_ascii("committed", b"ACGT");
        let committed_identity = committed.identity();
        let mut session = ComputeSession::new();
        session.extend_sequence_storage(vec![committed]);

        session.begin_fasta().unwrap();
        assert!(session.parse_fasta_chunk(b"missing-header\n").is_err());
        assert!(session.abort_fasta());
        assert_eq!(session.sequences.len(), 1);
        assert_eq!(session.sequences[0].identity(), committed_identity);

        session.begin_fasta().unwrap();
        assert!(
            session
                .parse_fasta_chunk(b">valid-after-error\nAAAA\n")
                .unwrap()
                .is_empty()
        );
        let completed = session.finish_fasta_records().unwrap();
        session.extend_sequence_storage(completed);
        assert_eq!(session.sequences.len(), 2);
        assert_eq!(session.sequences[1].name(), "valid-after-error");
        assert_eq!(session.sequences[1].len(), 4);
    }

    #[test]
    fn preview_and_detailed_overviews_remain_independent_and_bounded() {
        let mut session = ComputeSession::new();
        session.extend_sequence_storage(vec![PackedSequence::from_ascii(
            "sequence",
            b"ACGTACGTACGTACGT",
        )]);

        let preview = BrowserScientificConfig {
            inner: CoreScientificConfig::production(3, 2, 4, false).unwrap(),
        };
        let detailed = BrowserScientificConfig {
            inner: CoreScientificConfig::production(3, 4, 4, false).unwrap(),
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
            session.prepared_levels[&2].x.core_encoded()[0].register_count(),
            2
        );
        assert_eq!(
            session.prepared_levels[&4].x.core_encoded()[0].register_count(),
            4
        );

        session.retain_prepared_levels(2, 2);
        assert!(session.has_prepared_level(2));
        assert!(!session.has_prepared_level(4));
    }

    #[test]
    fn demand_zoom_can_start_from_a_selected_pair_without_an_overview_axis() {
        let mut session = ComputeSession::new();
        session.extend_sequence_storage(vec![PackedSequence::from_ascii(
            "sequence",
            b"ACGTACGTACGTACGT",
        )]);
        let config = BrowserScientificConfig {
            inner: CoreScientificConfig::production(3, 4, 4, false).unwrap(),
        };

        session
            .select_exact_comparison(0, 0, 3)
            .expect("the sequence pair is selected without preparing overview signatures");
        assert!(session.prepared_levels.is_empty());
        let mut tile = session
            .compute_zoom_tile_scientific(8, 0, 0, 8, 8, &config)
            .expect("a demand zoom tile can build only its requested axis ranges");
        let identity = tile.take_identity();
        assert_eq!(identity.len(), 64);
        assert_eq!(identity[0], 10_000);
        assert_eq!(identity[9], 10_000);
    }

    #[test]
    fn pairwise_preparation_interleaves_axes_and_publishes_compatible_blocks() {
        let mut session = ComputeSession::new();
        session.extend_sequence_storage(vec![
            PackedSequence::from_ascii("x", b"ACGTACGTACGTACGTACGTACGT"),
            PackedSequence::from_ascii("y", b"ACGTACGTTCGTACGTACGTACGT"),
        ]);
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
        session.extend_sequence_storage(vec![
            PackedSequence::from_ascii("x", b"ACGTACGTACGTACGTACGTACGT"),
            PackedSequence::from_ascii("y", b"ACGTACGTTCGTACGTACGTACGT"),
        ]);
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
        session.extend_sequence_storage(vec![PackedSequence::from_ascii("gc", &sequence)]);

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
        let maximum = CoreScientificConfig::production(21, 4_096, 10, false).unwrap();
        let error = validate_prepared_axis_admission(10_000, maximum, 2, 0)
            .expect_err("oversized pairwise axes must fail admission");

        assert!(error.contains("prepared-axis budget"));
    }

    #[test]
    fn retained_sequence_bytes_are_accounted_incrementally_and_cleared() {
        let first = PackedSequence::from_ascii("first", &vec![b'A'; 4_097]);
        let first_heap_bytes = first.estimated_heap_bytes();
        let second = PackedSequence::with_description("second", "metadata");
        let second_heap_bytes = second.estimated_heap_bytes();
        let mut session = ComputeSession::new();

        assert_eq!(session.extend_sequence_storage(vec![first]), 0);
        assert_eq!(session.sequence_heap_bytes, first_heap_bytes);
        assert_eq!(session.extend_sequence_storage(vec![second]), 1);
        assert_eq!(
            session.sequence_heap_bytes,
            first_heap_bytes.saturating_add(second_heap_bytes)
        );
        assert_eq!(
            session.estimated_memory_bytes(),
            estimated_sequence_bytes(session.sequence_heap_bytes, session.sequences.capacity())
        );

        session.clear();
        assert_eq!(session.sequence_heap_bytes, 0);
        assert_eq!(
            session.estimated_memory_bytes(),
            estimated_sequence_bytes(0, session.sequences.capacity())
        );
    }

    #[test]
    fn predicted_axis_memory_bounds_observed_retained_bytes() {
        let mut session = ComputeSession::new();
        session.extend_sequence_storage(vec![PackedSequence::from_ascii(
            "memory",
            &vec![b'A'; 100_000],
        )]);
        let config = BrowserScientificConfig {
            inner: CoreScientificConfig::production(21, 1_024, 10, false).unwrap(),
        };
        session
            .begin_prepare_scientific(0, 0, 128, &config, false)
            .unwrap();
        while session.prepare_comparison_chunk(32).unwrap() < 1.0 {}
        let axis = &session.prepared_levels[&1_024].x;
        let observed =
            std::mem::size_of::<FrozenAxis>().saturating_add(axis.estimated_heap_bytes());
        let predicted = estimated_frozen_axis_bytes(128, config.inner);
        assert!(
            observed <= predicted,
            "observed {observed} bytes exceeded predicted {predicted} bytes"
        );
    }

    #[test]
    fn zoom_cache_uses_exact_scientific_identity_and_rejects_key_drift() {
        let mut session = ComputeSession::new();
        session.extend_sequence_storage(vec![PackedSequence::from_ascii(
            "cache",
            b"ACGTACGTACGTACGTACGTACGTACGTACGT",
        )]);
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
