//! Narrow, worker-oriented WebAssembly API for moddotplot-rs.

use moddotplot_core::hash::HashAlgorithm;
use moddotplot_core::{
    AxisOverview, DEFAULT_ANI_FLOOR, DEFAULT_EXACT_CORE_CAP, DEFAULT_HASH_SEED,
    DEFAULT_MATCH_DETECTION_PROBABILITY, FastaParser, KmerTileRequest, MatrixTile, PackedSequence,
    SparseCorrectionPolicy, TileRequest, build_axis_range_adaptive_with_hash,
    build_axis_range_with_hash, compute_kmer_tile, compute_tile, compute_tile_adaptive,
};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::rc::Rc;
use wasm_bindgen::prelude::*;

const MAX_CACHED_AXIS_BYTES: usize = 192 * 1024 * 1024;
const MAX_BROWSER_REGISTERS: usize = 4_096;

#[derive(Clone, Debug, Serialize)]
struct SequenceMetadata {
    index: usize,
    name: String,
    length: u64,
}

struct PreparedComparison {
    x: AxisOverview,
    y: Option<AxisOverview>,
    x_index: usize,
    y_index: usize,
    domain_length: u64,
    hll_precision: u8,
    k: u8,
    hash_algorithm: HashAlgorithm,
}

struct ComparisonPreparation {
    x_index: usize,
    y_index: usize,
    domain_length: u64,
    resolution: usize,
    register_count: usize,
    hll_precision: u8,
    k: u8,
    hash_algorithm: HashAlgorithm,
    sparse_cap: Option<usize>,
    axis: u8,
    next_bin: usize,
    x_parts: Vec<AxisOverview>,
    y_parts: Vec<AxisOverview>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct AxisCacheKey {
    sequence_index: usize,
    resolution: usize,
    start: usize,
    count: usize,
    register_count: usize,
    sparse_cap: Option<usize>,
}

struct AxisCacheEntry {
    axis: Rc<AxisOverview>,
    bytes: usize,
}

/// Stateful compute session owned by one dedicated browser worker.
#[wasm_bindgen]
pub struct ComputeSession {
    parser: Option<FastaParser>,
    sequences: Vec<PackedSequence>,
    prepared_levels: BTreeMap<usize, PreparedComparison>,
    preparation: Option<ComparisonPreparation>,
    axis_cache: HashMap<AxisCacheKey, AxisCacheEntry>,
    cache_order: VecDeque<AxisCacheKey>,
    axis_cache_bytes: usize,
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
            prepared_levels: BTreeMap::new(),
            preparation: None,
            axis_cache: HashMap::new(),
            cache_order: VecDeque::new(),
            axis_cache_bytes: 0,
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
        let mut bytes = std::mem::size_of::<Self>()
            .saturating_add(
                self.sequences
                    .capacity()
                    .saturating_mul(std::mem::size_of::<PackedSequence>()),
            )
            .saturating_add(
                self.sequences
                    .iter()
                    .map(PackedSequence::estimated_heap_bytes)
                    .sum::<usize>(),
            );
        for prepared in self.prepared_levels.values() {
            bytes = bytes
                .saturating_add(std::mem::size_of::<PreparedComparison>())
                .saturating_add(prepared.x.estimated_heap_bytes());
            if let Some(y) = &prepared.y {
                bytes = bytes.saturating_add(y.estimated_heap_bytes());
            }
        }
        bytes = bytes
            .saturating_add(
                self.axis_cache
                    .capacity()
                    .saturating_mul(std::mem::size_of::<(AxisCacheKey, AxisCacheEntry)>()),
            )
            .saturating_add(self.axis_cache_bytes)
            .saturating_add(
                self.cache_order
                    .capacity()
                    .saturating_mul(std::mem::size_of::<AxisCacheKey>()),
            );
        bytes
    }

    /// Builds reusable overview signatures for one selected axis pair.
    ///
    /// This method is intentionally synchronous because the containing JavaScript runs
    /// in a worker. Matrix tiles can be requested immediately after it returns.
    ///
    /// # Errors
    ///
    /// Returns an error for missing sequence indexes or invalid sketch parameters.
    pub fn prepare_comparison(
        &mut self,
        x_index: usize,
        y_index: usize,
        resolution: usize,
        register_count: usize,
        hll_precision: u8,
        k: u8,
    ) -> Result<(), JsError> {
        self.begin_prepare_comparison(
            x_index,
            y_index,
            resolution,
            register_count,
            hll_precision,
            k,
        )?;
        while self.prepare_comparison_chunk(resolution)? < 1.0 {}
        Ok(())
    }

    /// Starts chunked overview construction so the worker can report true progress.
    ///
    /// # Errors
    ///
    /// Returns an error for missing sequence indexes or invalid sketch parameters.
    pub fn begin_prepare_comparison(
        &mut self,
        x_index: usize,
        y_index: usize,
        resolution: usize,
        register_count: usize,
        hll_precision: u8,
        k: u8,
    ) -> Result<(), JsError> {
        self.begin_prepare_comparison_with_hash(
            x_index,
            y_index,
            resolution,
            register_count,
            hll_precision,
            k,
            HashAlgorithm::NtHash2 as u8,
        )?;
        let preparation = self
            .preparation
            .as_mut()
            .ok_or_else(|| JsError::new("preparation state was not initialized"))?;
        preparation.sparse_cap = Some(DEFAULT_EXACT_CORE_CAP);
        Ok(())
    }

    /// Starts a lightweight overview without retaining exact sparse-window sets.
    ///
    /// The browser uses this level for the first visible frame. A full adaptive
    /// overview can be constructed afterward without discarding this prepared level.
    ///
    /// # Errors
    ///
    /// Returns the same validation errors as [`ComputeSession::begin_prepare_comparison`].
    pub fn begin_prepare_preview(
        &mut self,
        x_index: usize,
        y_index: usize,
        resolution: usize,
        register_count: usize,
        hll_precision: u8,
        k: u8,
    ) -> Result<(), JsError> {
        self.begin_prepare_comparison_with_hash(
            x_index,
            y_index,
            resolution,
            register_count,
            hll_precision,
            k,
            HashAlgorithm::NtHash2 as u8,
        )
    }

    /// Starts overview construction with an explicit benchmark hash backend.
    ///
    /// Production callers use [`ComputeSession::begin_prepare_comparison`]. This
    /// variant ensures native and Wasm benchmarks exercise identical core code.
    ///
    /// # Errors
    ///
    /// Returns an error for an unknown hash identifier or the same invalid parameters
    /// as [`ComputeSession::begin_prepare_comparison`].
    #[allow(clippy::too_many_arguments)]
    pub fn begin_prepare_comparison_with_hash(
        &mut self,
        x_index: usize,
        y_index: usize,
        resolution: usize,
        register_count: usize,
        hll_precision: u8,
        k: u8,
        hash_algorithm_id: u8,
    ) -> Result<(), JsError> {
        let hash_algorithm = HashAlgorithm::from_id(hash_algorithm_id)
            .ok_or_else(|| JsError::new("unknown hash algorithm"))?;
        if resolution == 0 {
            return Err(JsError::new("resolution must be positive"));
        }
        if register_count < 2 || !register_count.is_power_of_two() {
            return Err(JsError::new(
                "register count must be a power of two of at least two",
            ));
        }
        if !(4..=16).contains(&hll_precision) {
            return Err(JsError::new("HLL precision must be in 4..=16"));
        }
        if !(1..=31).contains(&k) {
            return Err(JsError::new("k must be in 1..=31"));
        }
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
                    && prepared.hll_precision == hll_precision
                    && prepared.k == k
                    && prepared.hash_algorithm == hash_algorithm
            });
        if !same_comparison {
            self.prepared_levels.clear();
            self.clear_axis_cache();
        }
        self.preparation = Some(ComparisonPreparation {
            x_index,
            y_index,
            domain_length,
            resolution,
            register_count,
            hll_precision,
            k,
            hash_algorithm,
            sparse_cap: None,
            axis: 0,
            next_bin: 0,
            x_parts: Vec::new(),
            y_parts: Vec::new(),
        });
        Ok(())
    }

    /// Abandons an in-progress overview refinement while retaining completed levels.
    pub fn cancel_preparation(&mut self) {
        self.preparation = None;
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
        let sequence_index = if state.axis == 0 {
            state.x_index
        } else {
            state.y_index
        };
        let sequence = self
            .sequences
            .get(sequence_index)
            .ok_or_else(|| JsError::new("preparation sequence index is out of range"))?;
        let count = maximum_bins.min(state.resolution - state.next_bin);
        let part = state.sparse_cap.map_or_else(
            || {
                build_axis_range_with_hash(
                    sequence,
                    state.domain_length,
                    state.resolution,
                    state.next_bin,
                    count,
                    state.k,
                    DEFAULT_HASH_SEED,
                    state.register_count,
                    state.hll_precision,
                    state.hash_algorithm,
                )
            },
            |sparse_cap| {
                build_axis_range_adaptive_with_hash(
                    sequence,
                    state.domain_length,
                    state.resolution,
                    state.next_bin,
                    count,
                    state.k,
                    DEFAULT_HASH_SEED,
                    state.register_count,
                    state.hll_precision,
                    state.hash_algorithm,
                    sparse_cap,
                )
            },
        );
        if state.axis == 0 {
            state.x_parts.push(part);
        } else {
            state.y_parts.push(part);
        }
        state.next_bin += count;
        if state.next_bin == state.resolution {
            if state.axis == 0 && state.x_index != state.y_index {
                state.axis = 1;
                state.next_bin = 0;
            } else {
                let x = join_axis_parts(std::mem::take(&mut state.x_parts));
                let y = if state.x_index == state.y_index {
                    None
                } else {
                    Some(join_axis_parts(std::mem::take(&mut state.y_parts)))
                };
                self.prepared_levels.insert(
                    state.register_count,
                    PreparedComparison {
                        x,
                        y,
                        x_index: state.x_index,
                        y_index: state.y_index,
                        domain_length: state.domain_length,
                        hll_precision: state.hll_precision,
                        k: state.k,
                        hash_algorithm: state.hash_algorithm,
                    },
                );
                return Ok(1.0);
            }
        }
        let axis_count = if state.x_index == state.y_index { 1 } else { 2 };
        let completed = usize::from(state.axis) * state.resolution + state.next_bin;
        let completed = u32::try_from(completed)
            .map_err(|_| JsError::new("overview resolution is too large for progress reporting"))?;
        let total = u32::try_from(axis_count * state.resolution)
            .map_err(|_| JsError::new("overview resolution is too large for progress reporting"))?;
        let progress = f64::from(completed) / f64::from(total);
        self.preparation = Some(state);
        Ok(progress)
    }

    /// Computes one clipped numeric tile from the prepared comparison.
    ///
    /// # Errors
    ///
    /// Returns an error if no comparison is prepared or `b_bits` is outside `1..=32`.
    #[allow(clippy::too_many_arguments)]
    pub fn compute_tile(
        &self,
        x_start: usize,
        y_start: usize,
        width: usize,
        height: usize,
        b_bits: u8,
        register_limit: usize,
        adaptive: bool,
    ) -> Result<WasmTile, JsError> {
        if !(1..=32).contains(&b_bits) {
            return Err(JsError::new("b_bits must be in 1..=32"));
        }
        let prepared = self
            .prepared_levels
            .range(register_limit..)
            .next()
            .map(|(_, prepared)| prepared)
            .ok_or_else(|| JsError::new("the requested overview register level is not prepared"))?;
        let y = prepared.y.as_ref().unwrap_or(&prepared.x);
        let request = TileRequest {
            x_start,
            y_start,
            width,
            height,
            b_bits,
            register_limit,
            k: prepared.k,
        };
        let inner = if adaptive {
            let x_sequence = &self.sequences[prepared.x_index];
            let y_sequence = &self.sequences[prepared.y_index];
            compute_tile_adaptive(
                &prepared.x,
                y,
                x_sequence,
                y_sequence,
                prepared.hash_algorithm,
                DEFAULT_HASH_SEED,
                request,
                default_sparse_policy(),
            )
        } else {
            compute_tile(&prepared.x, y, request)
        };
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
    #[allow(clippy::too_many_arguments)]
    pub fn compute_zoom_tile(
        &mut self,
        resolution: usize,
        x_start: usize,
        y_start: usize,
        width: usize,
        height: usize,
        b_bits: u8,
        register_limit: usize,
        adaptive: bool,
    ) -> Result<WasmTile, JsError> {
        if !(1..=32).contains(&b_bits) {
            return Err(JsError::new("b_bits must be in 1..=32"));
        }
        if resolution == 0 || width == 0 || height == 0 {
            return Err(JsError::new(
                "resolution and tile dimensions must be positive",
            ));
        }
        if x_start >= resolution || y_start >= resolution {
            return Err(JsError::new("tile origin lies outside its resolution"));
        }

        let prepared = self
            .prepared_levels
            .values()
            .next_back()
            .ok_or_else(|| JsError::new("prepare_comparison must be called first"))?;
        if !(2..=MAX_BROWSER_REGISTERS).contains(&register_limit)
            || !register_limit.is_power_of_two()
        {
            return Err(JsError::new(
                "register limit must be a supported power of two",
            ));
        }
        let x_index = prepared.x_index;
        let y_index = prepared.y_index;
        let domain_length = prepared.domain_length;
        let hll_precision = prepared.hll_precision;
        let k = prepared.k;
        let hash_algorithm = prepared.hash_algorithm;
        let sparse_cap = adaptive.then_some(DEFAULT_EXACT_CORE_CAP);
        let x_count = width.min(resolution - x_start);
        let y_count = height.min(resolution - y_start);
        let x_key = AxisCacheKey {
            sequence_index: x_index,
            resolution,
            start: x_start,
            count: x_count,
            register_count: register_limit,
            sparse_cap,
        };
        let y_key = AxisCacheKey {
            sequence_index: y_index,
            resolution,
            start: y_start,
            count: y_count,
            register_count: register_limit,
            sparse_cap,
        };
        let x = self.axis_range(
            x_key,
            domain_length,
            k,
            register_limit,
            hll_precision,
            hash_algorithm,
            sparse_cap,
        )?;
        let y = if x_key == y_key {
            Rc::clone(&x)
        } else {
            self.axis_range(
                y_key,
                domain_length,
                k,
                register_limit,
                hll_precision,
                hash_algorithm,
                sparse_cap,
            )?
        };

        let request = TileRequest {
            x_start,
            y_start,
            width,
            height,
            b_bits,
            register_limit,
            k,
        };
        let inner = if adaptive {
            compute_tile_adaptive(
                &x,
                &y,
                &self.sequences[x_index],
                &self.sequences[y_index],
                hash_algorithm,
                DEFAULT_HASH_SEED,
                request,
                default_sparse_policy(),
            )
        } else {
            compute_tile(&x, &y, request)
        };
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
        let prepared = self
            .prepared_levels
            .values()
            .next_back()
            .ok_or_else(|| JsError::new("prepare_comparison must be called first"))?;
        if x_start >= prepared.domain_length || y_start >= prepared.domain_length {
            return Err(JsError::new(
                "base tile origin lies outside the sequence domain",
            ));
        }
        let x = self
            .sequences
            .get(prepared.x_index)
            .ok_or_else(|| JsError::new("x sequence index is out of range"))?;
        let y = self
            .sequences
            .get(prepared.y_index)
            .ok_or_else(|| JsError::new("y sequence index is out of range"))?;
        Ok(WasmTile {
            inner: compute_kmer_tile(
                x,
                y,
                KmerTileRequest {
                    domain_length: prepared.domain_length,
                    x_start,
                    y_start,
                    width,
                    height,
                    k: prepared.k,
                },
            ),
        })
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

    /// Releases all sequence and comparison memory.
    pub fn clear(&mut self) {
        self.parser = None;
        self.prepared_levels.clear();
        self.preparation = None;
        self.sequences.clear();
        self.clear_axis_cache();
    }

    fn append_records(&mut self, records: Vec<PackedSequence>) -> Result<JsValue, JsError> {
        let first = self.sequences.len();
        self.sequences.extend(records);
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

    #[allow(clippy::too_many_arguments)]
    fn axis_range(
        &mut self,
        key: AxisCacheKey,
        domain_length: u64,
        k: u8,
        register_count: usize,
        hll_precision: u8,
        hash_algorithm: HashAlgorithm,
        sparse_cap: Option<usize>,
    ) -> Result<Rc<AxisOverview>, JsError> {
        if let Some(entry) = self.axis_cache.get(&key) {
            let axis = Rc::clone(&entry.axis);
            self.touch_axis_cache(key);
            return Ok(axis);
        }
        let sequence = self
            .sequences
            .get(key.sequence_index)
            .ok_or_else(|| JsError::new("cached axis sequence index is out of range"))?;
        let axis = Rc::new(sparse_cap.map_or_else(
            || {
                build_axis_range_with_hash(
                    sequence,
                    domain_length,
                    key.resolution,
                    key.start,
                    key.count,
                    k,
                    DEFAULT_HASH_SEED,
                    register_count,
                    hll_precision,
                    hash_algorithm,
                )
            },
            |cap| {
                build_axis_range_adaptive_with_hash(
                    sequence,
                    domain_length,
                    key.resolution,
                    key.start,
                    key.count,
                    k,
                    DEFAULT_HASH_SEED,
                    register_count,
                    hll_precision,
                    hash_algorithm,
                    cap,
                )
            },
        ));

        let bytes = std::mem::size_of::<AxisOverview>().saturating_add(axis.estimated_heap_bytes());
        self.axis_cache.insert(
            key,
            AxisCacheEntry {
                axis: Rc::clone(&axis),
                bytes,
            },
        );
        self.axis_cache_bytes = self.axis_cache_bytes.saturating_add(bytes);
        self.cache_order.push_back(key);
        self.prune_axis_cache();
        Ok(axis)
    }

    fn touch_axis_cache(&mut self, key: AxisCacheKey) {
        if let Some(index) = self
            .cache_order
            .iter()
            .position(|candidate| *candidate == key)
        {
            self.cache_order.remove(index);
        }
        self.cache_order.push_back(key);
    }

    fn prune_axis_cache(&mut self) {
        while self.axis_cache_bytes > MAX_CACHED_AXIS_BYTES && self.axis_cache.len() > 1 {
            let Some(expired) = self.cache_order.pop_front() else {
                break;
            };
            if let Some(entry) = self.axis_cache.remove(&expired) {
                self.axis_cache_bytes = self.axis_cache_bytes.saturating_sub(entry.bytes);
            }
        }
    }

    fn clear_axis_cache(&mut self) {
        self.axis_cache.clear();
        self.cache_order.clear();
        self.axis_cache_bytes = 0;
    }
}

fn join_axis_parts(mut parts: Vec<AxisOverview>) -> AxisOverview {
    assert!(!parts.is_empty());
    let mut joined = parts.remove(0);
    for mut part in parts {
        assert_eq!(part.offset, joined.offset + joined.core.len());
        joined.bounds.append(&mut part.bounds);
        joined.core.append(&mut part.core);
        joined.expanded.append(&mut part.expanded);
        joined.core_encoded.append(&mut part.core_encoded);
        joined.expanded_encoded.append(&mut part.expanded_encoded);
        joined.sparse_core.append(&mut part.sparse_core);
    }
    joined
}

fn default_sparse_policy() -> SparseCorrectionPolicy {
    SparseCorrectionPolicy {
        ani_floor: DEFAULT_ANI_FLOOR,
        minimum_detection_probability: DEFAULT_MATCH_DETECTION_PROBABILITY,
    }
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
    pub fn identity(&self) -> Vec<u16> {
        self.inner.identity.clone()
    }

    /// Signed direction values in `[-32767, 32767]`.
    pub fn direction(&self) -> Vec<i16> {
        self.inner.direction.clone()
    }

    /// Informative full-hash direction support.
    pub fn direction_support(&self) -> Vec<u16> {
        self.inner.direction_support.clone()
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

        session
            .begin_prepare_preview(0, 0, 4, 2, 4, 3)
            .expect("preview preparation starts");
        while session
            .prepare_comparison_chunk(4)
            .expect("preview preparation advances")
            < 1.0
        {}
        session
            .begin_prepare_comparison(0, 0, 4, 4, 4, 3)
            .expect("detailed preparation starts");
        while session
            .prepare_comparison_chunk(4)
            .expect("detailed preparation advances")
            < 1.0
        {}

        assert!(session.has_prepared_level(2));
        assert!(session.has_prepared_level(4));
        assert_eq!(session.prepared_levels[&2].x.core[0].register_count(), 2);
        assert_eq!(session.prepared_levels[&4].x.core[0].register_count(), 4);

        session.retain_prepared_levels(2, 2);
        assert!(session.has_prepared_level(2));
        assert!(!session.has_prepared_level(4));
    }
}
