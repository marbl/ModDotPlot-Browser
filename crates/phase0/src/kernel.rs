//! Candidate sketch and all-pairs matrix kernels.

use crate::config::BenchmarkConfig;
use moddotplot_core::hash::{HashAlgorithm, canonical_hashes, fmix64, hash_canonical};
use moddotplot_core::{
    AxisOverview, BottomSItem, DirectionEvidence, ExactHashSet, ExactSimilarity, Orientation,
    PackedSequence, SparseCoreHashSet, TileRequest, build_axis_overview,
    build_axis_overview_adaptive_with_hash, build_axis_overview_with_hash, build_minmer_index,
    compute_tile, estimate_bottom_s_containment, estimate_containment_bit_sliced,
    exact_moddotplot_score, expected_oph_matches, mashmap_bottom_s_range,
};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Dense row-major output shared by every candidate.
#[derive(Clone, Debug)]
pub struct MatrixEstimate {
    /// Maximum directed-containment estimates; `None` means no valid evidence.
    pub containment: Vec<Option<f64>>,
    /// ANI-like estimates; `None` means no valid evidence.
    pub identity: Vec<Option<f64>>,
    /// Direction evidence selected with the maximum-containment score.
    pub direction: Vec<DirectionEvidence>,
}

/// Timed output for one candidate.
#[derive(Clone, Debug)]
pub struct KernelRun {
    /// Stable kernel identifier.
    pub name: &'static str,
    /// Sketch construction time.
    pub build_time: Duration,
    /// Median complete matrix time after one untimed warm-up.
    pub matrix_time: Duration,
    /// Estimated owned bytes.
    pub estimated_bytes: usize,
    /// Complete result from the last repetition.
    pub matrix: MatrixEstimate,
    /// OPH-specific diagnostics, when this is a direct OPH candidate.
    pub oph_diagnostics: Option<OphDiagnostics>,
    /// Sparse correction diagnostics, when this is an adaptive OPH candidate.
    pub adaptive_diagnostics: Option<AdaptiveDiagnostics>,
}

/// Diagnostics that are intentionally kept outside timed matrix execution.
#[derive(Clone, Copy, Debug)]
pub struct OphDiagnostics {
    /// Mean fraction of occupied registers across core interval sketches.
    pub mean_core_occupancy: f64,
    /// Different 64-bit winners that collided in the retained 32-bit fingerprint.
    pub fingerprint32_collisions: u64,
}

/// Frozen adaptive-containment parameters.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AdaptiveConfig {
    /// Maximum distinct canonical hashes retained for one exact core.
    pub sparse_cap: usize,
    /// Exact correction is considered below this probability-derived expected-match count.
    pub min_expected_matches: f64,
    /// Lowest scientifically useful displayed ANI.
    pub ani_floor: f64,
}

/// Resource and selection counters for one adaptive candidate.
#[derive(Clone, Copy, Debug, Default)]
pub struct AdaptiveDiagnostics {
    /// Core intervals whose complete distinct hash sets fit under the cap.
    pub retained_sparse_cores: usize,
    /// Complete distinct hashes retained across both axes.
    pub retained_sparse_hashes: usize,
    /// Directed cell comparisons replaced by exact containment.
    pub corrected_directed_cells: usize,
    /// Cold correction-index and exact-intersection time from the retained run.
    pub correction_time: Duration,
    /// OPH comparison, adaptive selection, and output assembly time.
    pub selection_time: Duration,
}

/// Hash-only timing result over both axes of one fixture.
#[derive(Clone, Copy, Debug)]
pub struct HashRun {
    /// Number of valid k-mer occurrences hashed in one pass.
    pub kmer_count: u64,
    /// Median duration after one warm-up.
    pub elapsed: Duration,
    /// Data-dependent checksum preventing dead-code elimination.
    pub checksum: u64,
}

/// Independent exact score matrix.
pub fn exact_oracle(
    x: &PackedSequence,
    y: &PackedSequence,
    config: BenchmarkConfig,
) -> Vec<Option<ExactSimilarity>> {
    let domain = x.len().max(y.len()).max(1);
    let x_axis = exact_axis(x, config, domain);
    let y_axis = exact_axis(y, config, domain);
    all_pairs(config.resolution, |column, row| {
        if x_axis[column].0.is_empty() || y_axis[row].0.is_empty() {
            return None;
        }
        exact_moddotplot_score(
            &x_axis[column].0,
            &x_axis[column].1,
            &y_axis[row].0,
            &y_axis[row].1,
            config.k,
        )
    })
}

/// Independent MashMap-compatible coordinated bottom-s matrix.
pub fn mashmap_oracle(
    x: &PackedSequence,
    y: &PackedSequence,
    config: BenchmarkConfig,
) -> MatrixEstimate {
    let domain = x.len().max(y.len()).max(1);
    let x_axis = bottom_s_axis(x, config, domain);
    let y_axis = bottom_s_axis(y, config, domain);
    bottom_s_matrix(&x_axis, &y_axis, config)
}

/// Benchmarks pairwise coordinated bottom-s merge comparisons.
pub fn run_bottom_s(x: &PackedSequence, y: &PackedSequence, config: BenchmarkConfig) -> KernelRun {
    let build_start = Instant::now();
    let domain = x.len().max(y.len()).max(1);
    let x_axis = bottom_s_axis(x, config, domain);
    let y_axis = bottom_s_axis(y, config, domain);
    let build_time = build_start.elapsed();
    let estimated_bytes = bottom_s_bytes(&x_axis) + bottom_s_bytes(&y_axis);
    timed_matrix(
        "coordinated_bottom_s",
        build_time,
        estimated_bytes,
        config,
        || bottom_s_matrix(&x_axis, &y_axis, config),
    )
}

/// Benchmarks an inverted-postings comparison over minmer/bottom-s cell samples.
///
/// This candidate trades coordinated-union comparison for one postings traversal per
/// retained hash. The benchmark quantifies the resulting bias instead of assuming it
/// is scientifically interchangeable with coordinated bottom-s.
pub fn run_minmer_postings(
    x: &PackedSequence,
    y: &PackedSequence,
    config: BenchmarkConfig,
) -> KernelRun {
    let build_start = Instant::now();
    let (x_axis, x_index_bytes) = minmer_axis(x, config);
    let (y_axis, y_index_bytes) = minmer_axis(y, config);
    let y_expanded_postings = postings(&y_axis, true);
    let x_expanded_postings = postings(&x_axis, true);
    let build_time = build_start.elapsed();
    let estimated_bytes = x_index_bytes
        + y_index_bytes
        + bottom_s_bytes(&x_axis)
        + bottom_s_bytes(&y_axis)
        + postings_bytes(&y_expanded_postings)
        + postings_bytes(&x_expanded_postings);
    timed_matrix(
        "minmer_postings",
        build_time,
        estimated_bytes,
        config,
        || {
            postings_matrix(
                &x_axis,
                &y_axis,
                &y_expanded_postings,
                &x_expanded_postings,
                config,
            )
        },
    )
}

fn minmer_axis(sequence: &PackedSequence, config: BenchmarkConfig) -> (Vec<BottomSCell>, usize) {
    let window_size = sequence.len() / config.resolution as u64;
    assert!(window_size > 0);
    let index = build_minmer_index(
        sequence,
        config.k,
        window_size,
        config.sketch_size,
        config.hash_seed,
    );
    let cells = (0..config.resolution)
        .map(|cell| {
            let (start, end, expanded_start, expanded_end) =
                bounds(cell, config.resolution, sequence.len());
            let core_end = end.saturating_sub(window_size).saturating_add(1);
            let expanded_window_end = expanded_end.saturating_sub(window_size).saturating_add(1);
            BottomSCell {
                core: index.range_minmers(start, core_end),
                expanded: index.range_minmers(expanded_start, expanded_window_end),
            }
        })
        .collect();
    (cells, index.estimated_heap_bytes())
}

/// Benchmarks the current undensified word-parallel b-bit OPH kernel.
pub fn run_oph(x: &PackedSequence, y: &PackedSequence, config: BenchmarkConfig) -> KernelRun {
    run_oph_named(x, y, config, HashAlgorithm::PackedFmix64, "bbit_oph")
}

/// Benchmarks direct OPH while changing only the canonical hash stream.
pub fn run_oph_hash(
    x: &PackedSequence,
    y: &PackedSequence,
    config: BenchmarkConfig,
    algorithm: HashAlgorithm,
) -> KernelRun {
    run_oph_named(x, y, config, algorithm, algorithm.as_str())
}

/// Benchmarks ntHash2 b-bit OPH with the bounded exact sparse-core correction.
pub fn run_adaptive_oph(
    x: &PackedSequence,
    y: &PackedSequence,
    config: BenchmarkConfig,
    adaptive: AdaptiveConfig,
) -> KernelRun {
    let domain = x.len().max(y.len()).max(1);
    let build_start = Instant::now();
    let x_axis = build_axis_overview_adaptive_with_hash(
        x,
        domain,
        config.resolution,
        config.k,
        config.hash_seed,
        config.register_count,
        12,
        HashAlgorithm::NtHash2,
        adaptive.sparse_cap,
    );
    let y_axis = (x != y).then(|| {
        build_axis_overview_adaptive_with_hash(
            y,
            domain,
            config.resolution,
            config.k,
            config.hash_seed,
            config.register_count,
            12,
            HashAlgorithm::NtHash2,
            adaptive.sparse_cap,
        )
    });
    let y_summary = y_axis.as_ref().unwrap_or(&x_axis);
    let build_time = build_start.elapsed();
    let retained_sparse_cores =
        retained_sparse_cores(&x_axis) + y_axis.as_ref().map_or(0, retained_sparse_cores);
    let retained_sparse_hashes =
        retained_sparse_hashes(&x_axis) + y_axis.as_ref().map_or(0, retained_sparse_hashes);
    let estimated_bytes = x_axis.estimated_heap_bytes()
        + y_axis
            .as_ref()
            .map_or(0, AxisOverview::estimated_heap_bytes);
    let oph_diagnostics = oph_diagnostics(&x_axis, y_summary, config.register_count);

    let operation = || {
        adaptive_matrix(
            AdaptiveAxes {
                x_summary: &x_axis,
                y_summary,
                x_sequence: x,
                y_sequence: y,
            },
            config,
            adaptive,
        )
    };
    let _warm = operation();
    let mut measurements = Vec::with_capacity(config.repetitions);
    let mut last = None;
    for _ in 0..config.repetitions {
        let start = Instant::now();
        last = Some(operation());
        measurements.push(start.elapsed());
    }
    measurements.sort_unstable();
    let (matrix, corrected_directed_cells, correction_time, selection_time) =
        last.expect("at least one adaptive matrix repetition is required");
    KernelRun {
        name: "adaptive_nthash2_bbit_oph",
        build_time,
        matrix_time: measurements[measurements.len() / 2],
        estimated_bytes,
        matrix,
        oph_diagnostics: Some(oph_diagnostics),
        adaptive_diagnostics: Some(AdaptiveDiagnostics {
            retained_sparse_cores,
            retained_sparse_hashes,
            corrected_directed_cells,
            correction_time,
            selection_time,
        }),
    }
}

fn run_oph_named(
    x: &PackedSequence,
    y: &PackedSequence,
    config: BenchmarkConfig,
    algorithm: HashAlgorithm,
    name: &'static str,
) -> KernelRun {
    let domain = x.len().max(y.len()).max(1);
    let build_start = Instant::now();
    let x_axis = build_axis_overview_with_hash(
        x,
        domain,
        config.resolution,
        config.k,
        config.hash_seed,
        config.register_count,
        12,
        algorithm,
    );
    let y_axis = build_axis_overview_with_hash(
        y,
        domain,
        config.resolution,
        config.k,
        config.hash_seed,
        config.register_count,
        12,
        algorithm,
    );
    let build_time = build_start.elapsed();
    let estimated_bytes = x_axis.estimated_heap_bytes() + y_axis.estimated_heap_bytes();
    let diagnostics = oph_diagnostics(&x_axis, &y_axis, config.register_count);
    let mut run = timed_matrix(name, build_time, estimated_bytes, config, || {
        oph_matrix(&x_axis, &y_axis, config)
    });
    run.oph_diagnostics = Some(diagnostics);
    run
}

fn retained_sparse_cores(axis: &AxisOverview) -> usize {
    axis.sparse_core
        .iter()
        .filter(|core| core.as_ref().is_some_and(|items| !items.is_empty()))
        .count()
}

fn retained_sparse_hashes(axis: &AxisOverview) -> usize {
    axis.sparse_core
        .iter()
        .filter_map(Option::as_ref)
        .map(SparseCoreHashSet::len)
        .sum()
}

#[derive(Clone, Copy, Debug)]
struct DirectedScore {
    containment: f64,
    ani: f64,
    direction: DirectionEvidence,
}

impl DirectedScore {
    fn exact(containment: f64, k: u8, direction: DirectionEvidence) -> Self {
        let ani = if containment == 0.0 {
            0.0
        } else {
            containment.powf(1.0 / f64::from(k))
        };
        Self {
            containment,
            ani,
            direction,
        }
    }
}

impl From<moddotplot_core::ContainmentEstimate> for DirectedScore {
    fn from(value: moddotplot_core::ContainmentEstimate) -> Self {
        Self {
            containment: value.containment,
            ani: value.ani,
            direction: value.direction,
        }
    }
}

#[derive(Clone, Copy)]
struct AdaptiveAxes<'a> {
    x_summary: &'a AxisOverview,
    y_summary: &'a AxisOverview,
    x_sequence: &'a PackedSequence,
    y_sequence: &'a PackedSequence,
}

#[derive(Clone, Copy)]
struct AdaptiveDecision {
    register_count: usize,
    min_expected_matches: f64,
    containment_floor: f64,
}

fn adaptive_matrix(
    axes: AdaptiveAxes<'_>,
    config: BenchmarkConfig,
    adaptive: AdaptiveConfig,
) -> (MatrixEstimate, usize, Duration, Duration) {
    let correction_start = Instant::now();
    let x_exact = exact_sparse_direction(
        axes.x_summary,
        axes.y_sequence,
        axes.x_summary.domain_length,
        config,
        true,
    );
    let y_exact = if axes.x_sequence == axes.y_sequence {
        transpose_scores(&x_exact, config.resolution)
    } else {
        exact_sparse_direction(
            axes.y_summary,
            axes.x_sequence,
            axes.x_summary.domain_length,
            config,
            false,
        )
    };
    let correction_time = correction_start.elapsed();
    let mut corrected_directed_cells = 0;
    let selection_start = Instant::now();
    let decision = AdaptiveDecision {
        register_count: config.register_count,
        min_expected_matches: adaptive.min_expected_matches,
        containment_floor: adaptive.ani_floor.powi(i32::from(config.k)),
    };
    let mut matrix = oph_matrix(axes.x_summary, axes.y_summary, config);
    for row in 0..config.resolution {
        for column in 0..config.resolution {
            let output = row * config.resolution + column;
            if matrix.identity[output].is_none() {
                continue;
            }
            let x_correct = should_correct(
                axes.x_summary.sparse_core[column]
                    .as_ref()
                    .map(SparseCoreHashSet::len),
                axes.y_summary.expanded[row].estimated_cardinality(),
                decision,
            );
            let y_correct = should_correct(
                axes.y_summary.sparse_core[row]
                    .as_ref()
                    .map(SparseCoreHashSet::len),
                axes.x_summary.expanded[column].estimated_cardinality(),
                decision,
            );
            if !x_correct && !y_correct {
                continue;
            }
            corrected_directed_cells += usize::from(x_correct) + usize::from(y_correct);
            let x_score = if x_correct {
                x_exact[output]
            } else {
                estimate_containment_bit_sliced(
                    &axes.x_summary.core_encoded[column],
                    &axes.y_summary.expanded_encoded[row],
                    config.k,
                    config.b_bits,
                    config.register_count,
                )
                .map(DirectedScore::from)
            };
            let y_score = if y_correct {
                y_exact[output]
            } else {
                estimate_containment_bit_sliced(
                    &axes.y_summary.core_encoded[row],
                    &axes.x_summary.expanded_encoded[column],
                    config.k,
                    config.b_bits,
                    config.register_count,
                )
                .map(DirectedScore::from)
            };
            if let Some(score) = choose_directed_score(x_score, y_score) {
                matrix.containment[output] = Some(score.containment);
                matrix.identity[output] = Some(score.ani);
                matrix.direction[output] = score.direction;
            }
        }
    }
    (
        matrix,
        corrected_directed_cells,
        correction_time,
        selection_start.elapsed(),
    )
}

fn should_correct(
    exact_core_cardinality: Option<usize>,
    target_cardinality: f64,
    decision: AdaptiveDecision,
) -> bool {
    exact_core_cardinality.is_some_and(|cardinality| {
        expected_oph_matches(
            bounded_count_as_f64(cardinality),
            target_cardinality,
            decision.register_count,
            decision.containment_floor,
        ) < decision.min_expected_matches
    })
}

fn choose_directed_score(
    left: Option<DirectedScore>,
    right: Option<DirectedScore>,
) -> Option<DirectedScore> {
    match (left, right) {
        (Some(left), Some(right)) if (left.containment - right.containment).abs() <= 1e-12 => {
            Some(DirectedScore {
                containment: left.containment.max(right.containment),
                ani: left.ani.max(right.ani),
                direction: left.direction.combine(right.direction),
            })
        }
        (Some(left), Some(right)) if left.containment > right.containment => Some(left),
        (Some(_), Some(right)) => Some(right),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn exact_sparse_direction(
    query: &AxisOverview,
    target: &PackedSequence,
    domain: u64,
    config: BenchmarkConfig,
    query_is_x: bool,
) -> Vec<Option<DirectedScore>> {
    let cell_count = config.resolution * config.resolution;
    let mut result = vec![None; cell_count];
    let queries = sparse_queries(query);
    if queries.is_empty() {
        return result;
    }
    let target_hits = scan_sparse_query_hits(&queries, target, domain, config);
    let (shared, direction) =
        accumulate_sparse_hits(&queries, &target_hits, config.resolution, query_is_x);

    for row in 0..config.resolution {
        for column in 0..config.resolution {
            let output = row * config.resolution + column;
            let query_cell = if query_is_x { column } else { row };
            let Some(denominator) = query.sparse_core[query_cell]
                .as_ref()
                .map(SparseCoreHashSet::len)
            else {
                continue;
            };
            if denominator == 0 {
                continue;
            }
            let containment = f64::from(shared[output]) / bounded_count_as_f64(denominator);
            result[output] = Some(DirectedScore::exact(
                containment.clamp(0.0, 1.0),
                config.k,
                direction[output],
            ));
        }
    }
    result
}

fn sparse_queries(query: &AxisOverview) -> Vec<(u64, Vec<Posting>)> {
    let mut postings = HashMap::<u64, Vec<Posting>>::new();
    for (query_cell, hashes) in query.sparse_core.iter().enumerate() {
        let Some(hashes) = hashes else {
            continue;
        };
        for (&hash, &orientation) in hashes.iter() {
            postings
                .entry(hash)
                .or_default()
                .push((query_cell, orientation));
        }
    }
    let mut queries = postings.into_iter().collect::<Vec<_>>();
    queries.sort_unstable_by_key(|(hash, _)| *hash);
    queries
}

fn scan_sparse_query_hits(
    queries: &[(u64, Vec<Posting>)],
    target: &PackedSequence,
    domain: u64,
    config: BenchmarkConfig,
) -> TargetHalfBits {
    let index = QueryHashIndex::new(queries.iter().map(|(hash, _)| *hash));
    let half_count = config.resolution * 2;
    let words = half_count.div_ceil(64);
    let plane_len = queries.len().saturating_mul(words);
    let mut hits = TargetHalfBits {
        forward: vec![0; plane_len],
        reverse: vec![0; plane_len],
        words,
    };
    for item in canonical_hashes(
        target,
        config.k,
        0,
        target.len(),
        HashAlgorithm::NtHash2,
        config.hash_seed,
    ) {
        let Some(query_id) = index.get(item.hash) else {
            continue;
        };
        let half = scaled_segment(item.start, half_count, domain);
        let output = query_id * words + half / 64;
        let flag = 1_u64 << (half % 64);
        match item.orientation {
            Orientation::Forward => hits.forward[output] |= flag,
            Orientation::Reverse => hits.reverse[output] |= flag,
            Orientation::Both | Orientation::Unknown => {
                hits.forward[output] |= flag;
                hits.reverse[output] |= flag;
            }
        }
    }
    hits
}

fn accumulate_sparse_hits(
    queries: &[(u64, Vec<Posting>)],
    target_hits: &TargetHalfBits,
    resolution: usize,
    query_is_x: bool,
) -> (Vec<u32>, Vec<DirectionEvidence>) {
    let cell_count = resolution * resolution;
    let mut shared = vec![0_u32; cell_count];
    let mut direction = vec![DirectionEvidence::default(); cell_count];
    let mut target_orientation = vec![Orientation::Unknown; resolution];
    let mut touched_targets = Vec::<usize>::new();
    for (query_id, query) in queries.iter().enumerate() {
        for word in 0..target_hits.words {
            let index = query_id * target_hits.words + word;
            let forward = target_hits.forward[index];
            let reverse = target_hits.reverse[index];
            let mut occupied = forward | reverse;
            while occupied != 0 {
                let bit = occupied.trailing_zeros() as usize;
                let flag = 1_u64 << bit;
                let half = word * 64 + bit;
                let orientation = match (forward & flag != 0, reverse & flag != 0) {
                    (true, false) => Orientation::Forward,
                    (false, true) => Orientation::Reverse,
                    _ => Orientation::Both,
                };
                let (first, last) = expanded_target_cells(half, resolution);
                record_target_orientation(
                    &mut target_orientation,
                    &mut touched_targets,
                    first,
                    orientation,
                );
                if last != first {
                    record_target_orientation(
                        &mut target_orientation,
                        &mut touched_targets,
                        last,
                        orientation,
                    );
                }
                occupied &= occupied - 1;
            }
        }
        accumulate_one_query(
            &query.1,
            &target_orientation,
            &touched_targets,
            resolution,
            query_is_x,
            &mut shared,
            &mut direction,
        );
        for &target in &touched_targets {
            target_orientation[target] = Orientation::Unknown;
        }
        touched_targets.clear();
    }
    (shared, direction)
}

struct TargetHalfBits {
    forward: Vec<u64>,
    reverse: Vec<u64>,
    words: usize,
}

fn expanded_target_cells(half: usize, resolution: usize) -> (usize, usize) {
    let base = half / 2;
    let first = if half.is_multiple_of(2) {
        base.saturating_sub(1)
    } else {
        base
    };
    let last = if half.is_multiple_of(2) {
        base
    } else {
        base + 1
    }
    .min(resolution - 1);
    (first, last)
}

fn record_target_orientation(
    orientations: &mut [Orientation],
    touched: &mut Vec<usize>,
    target: usize,
    observation: Orientation,
) {
    if orientations[target] == Orientation::Unknown {
        touched.push(target);
        orientations[target] = observation;
    } else {
        orientations[target] = orientations[target].combine(observation);
    }
}

fn accumulate_one_query(
    query_postings: &[Posting],
    target_orientation: &[Orientation],
    touched_targets: &[usize],
    resolution: usize,
    query_is_x: bool,
    shared: &mut [u32],
    direction: &mut [DirectionEvidence],
) {
    for &target_cell in touched_targets {
        for &(query_cell, query_orientation) in query_postings {
            let output = if query_is_x {
                target_cell * resolution + query_cell
            } else {
                query_cell * resolution + target_cell
            };
            shared[output] += 1;
            add_direction(
                &mut direction[output],
                query_orientation,
                target_orientation[target_cell],
            );
        }
    }
}

fn transpose_scores(
    values: &[Option<DirectedScore>],
    resolution: usize,
) -> Vec<Option<DirectedScore>> {
    let mut transposed = vec![None; values.len()];
    for row in 0..resolution {
        for column in 0..resolution {
            transposed[row * resolution + column] = values[column * resolution + row];
        }
    }
    transposed
}

/// Minimal deterministic open-addressing set for a pre-hashed query stream.
///
/// `std::collections::HashMap` deliberately uses a denial-of-service-resistant hash
/// function. These keys are already uniformly distributed ntHash2 values, so a
/// direct table avoids re-hashing every chromosome k-mer during sparse correction.
struct QueryHashIndex {
    keys: Vec<u64>,
    values: Vec<usize>,
    occupied: Vec<bool>,
    mask: usize,
    index_shift: u32,
}

impl QueryHashIndex {
    fn new(hashes: impl IntoIterator<Item = u64>) -> Self {
        let hashes = hashes.into_iter().collect::<Vec<_>>();
        let capacity = hashes.len().saturating_mul(2).max(2).next_power_of_two();
        let mut filter = Self {
            keys: vec![0; capacity],
            values: vec![0; capacity],
            occupied: vec![false; capacity],
            mask: capacity - 1,
            index_shift: 64 - capacity.trailing_zeros(),
        };
        for (value, hash) in hashes.into_iter().enumerate() {
            filter.insert(hash, value);
        }
        filter
    }

    fn insert(&mut self, hash: u64, value: usize) {
        let mut index = self.index(hash);
        while self.occupied[index] {
            if self.keys[index] == hash {
                return;
            }
            index = (index + 1) & self.mask;
        }
        self.occupied[index] = true;
        self.keys[index] = hash;
        self.values[index] = value;
    }

    fn get(&self, hash: u64) -> Option<usize> {
        let mut index = self.index(hash);
        while self.occupied[index] {
            if self.keys[index] == hash {
                return Some(self.values[index]);
            }
            index = (index + 1) & self.mask;
        }
        None
    }

    fn index(&self, hash: u64) -> usize {
        let mixed = hash.wrapping_mul(0x9e37_79b9_7f4a_7c15);
        usize::try_from(mixed >> self.index_shift).expect("a table index must fit usize")
    }
}

fn scaled_segment(start: u64, segment_count: usize, domain: u64) -> usize {
    let segment = u128::from(start) * segment_count as u128 / u128::from(domain);
    usize::try_from(segment).expect("a segment index must fit usize")
}

fn bounded_count_as_f64(count: usize) -> f64 {
    f64::from(u32::try_from(count).expect("a supported sketch count must fit u32"))
}

/// Times only canonical hash generation over two packed sequences.
pub fn benchmark_hash_stream(
    x: &PackedSequence,
    y: &PackedSequence,
    config: BenchmarkConfig,
    algorithm: HashAlgorithm,
) -> HashRun {
    let operation = || {
        let mut count = 0_u64;
        let mut checksum = 0_u64;
        for sequence in [x, y] {
            for item in canonical_hashes(
                sequence,
                config.k,
                0,
                sequence.len(),
                algorithm,
                config.hash_seed,
            ) {
                count += 1;
                checksum = checksum.wrapping_add(item.hash.rotate_left((item.start & 63) as u32));
            }
        }
        std::hint::black_box((count, checksum))
    };
    let _warm = operation();
    let mut measurements = Vec::with_capacity(config.repetitions);
    let mut result = (0, 0);
    for _ in 0..config.repetitions {
        let start = Instant::now();
        result = operation();
        measurements.push(start.elapsed());
    }
    measurements.sort_unstable();
    HashRun {
        kmer_count: result.0,
        elapsed: measurements[measurements.len() / 2],
        checksum: result.1,
    }
}

fn oph_diagnostics(x: &AxisOverview, y: &AxisOverview, register_count: usize) -> OphDiagnostics {
    let is_self = std::ptr::eq(x, y);
    let sketch_count = x.core.len() + if is_self { 0 } else { y.core.len() };
    let occupied = x
        .core
        .iter()
        .map(moddotplot_core::OphSketch::occupied_registers)
        .sum::<usize>()
        + if is_self {
            0
        } else {
            y.core
                .iter()
                .map(moddotplot_core::OphSketch::occupied_registers)
                .sum::<usize>()
        };
    let denominator = sketch_count.saturating_mul(register_count);
    let mean_core_occupancy = if denominator == 0 {
        0.0
    } else {
        f64::from(u32::try_from(occupied).expect("benchmark occupancy fits u32"))
            / f64::from(u32::try_from(denominator).expect("benchmark register budget fits u32"))
    };
    let mut fingerprint32_collisions = 0_u64;
    for x_cell in &x.core {
        for y_cell in &y.expanded {
            let comparison = x_cell.compare_bbit(y_cell, 32, register_count);
            fingerprint32_collisions +=
                u64::from(comparison.bbit_matches - comparison.verified_matches);
        }
    }
    if !is_self {
        for y_cell in &y.core {
            for x_cell in &x.expanded {
                let comparison = y_cell.compare_bbit(x_cell, 32, register_count);
                fingerprint32_collisions +=
                    u64::from(comparison.bbit_matches - comparison.verified_matches);
            }
        }
    }
    OphDiagnostics {
        mean_core_occupancy,
        fingerprint32_collisions,
    }
}

/// Benchmarks re-randomized densification of the word-parallel b-bit OPH kernel.
pub fn run_densified_oph(
    x: &PackedSequence,
    y: &PackedSequence,
    config: BenchmarkConfig,
) -> KernelRun {
    let domain = x.len().max(y.len()).max(1);
    let build_start = Instant::now();
    let x_axis = build_axis_overview(
        x,
        domain,
        config.resolution,
        config.k,
        config.hash_seed,
        config.register_count,
        12,
    );
    let y_axis = build_axis_overview(
        y,
        domain,
        config.resolution,
        config.k,
        config.hash_seed,
        config.register_count,
        12,
    );
    let x_dense = DenseAxis::new(&x_axis, config);
    let y_dense = DenseAxis::new(&y_axis, config);
    let build_time = build_start.elapsed();
    let estimated_bytes = x_axis.estimated_heap_bytes()
        + y_axis.estimated_heap_bytes()
        + x_dense.estimated_bytes()
        + y_dense.estimated_bytes();
    timed_matrix(
        "densified_bbit_oph",
        build_time,
        estimated_bytes,
        config,
        || dense_oph_matrix(&x_dense, &y_dense, config),
    )
}

/// Benchmarks a compact SetSketch-like joint-cardinality spike.
///
/// This uses max-rank registers and inclusion/exclusion of their cardinality
/// estimates. It intentionally does not claim the paper's specialized joint MLE.
pub fn run_setsketch_like(
    x: &PackedSequence,
    y: &PackedSequence,
    config: BenchmarkConfig,
) -> KernelRun {
    let build_start = Instant::now();
    let x_axis = SetLikeAxis::new(x, config);
    let y_axis = SetLikeAxis::new(y, config);
    let build_time = build_start.elapsed();
    let estimated_bytes = x_axis.estimated_bytes() + y_axis.estimated_bytes();
    timed_matrix(
        "setsketch_like_joint",
        build_time,
        estimated_bytes,
        config,
        || set_like_matrix(&x_axis, &y_axis, config),
    )
}

#[derive(Clone, Debug)]
struct BottomSCell {
    core: Vec<BottomSItem>,
    expanded: Vec<BottomSItem>,
}

fn bottom_s_axis(
    sequence: &PackedSequence,
    config: BenchmarkConfig,
    domain: u64,
) -> Vec<BottomSCell> {
    (0..config.resolution)
        .map(|index| {
            let (start, end, expanded_start, expanded_end) =
                bounds(index, config.resolution, domain);
            BottomSCell {
                core: mashmap_bottom_s_range(
                    sequence,
                    config.k,
                    start,
                    end,
                    config.sketch_size,
                    config.hash_seed,
                ),
                expanded: mashmap_bottom_s_range(
                    sequence,
                    config.k,
                    expanded_start,
                    expanded_end,
                    config.sketch_size,
                    config.hash_seed,
                ),
            }
        })
        .collect()
}

fn exact_axis(
    sequence: &PackedSequence,
    config: BenchmarkConfig,
    domain: u64,
) -> Vec<(ExactHashSet, ExactHashSet)> {
    (0..config.resolution)
        .map(|index| {
            let (start, end, expanded_start, expanded_end) =
                bounds(index, config.resolution, domain);
            (
                ExactHashSet::from_interval(sequence, start, end, config.k, config.hash_seed),
                ExactHashSet::from_interval(
                    sequence,
                    expanded_start,
                    expanded_end,
                    config.k,
                    config.hash_seed,
                ),
            )
        })
        .collect()
}

fn bottom_s_matrix(
    x: &[BottomSCell],
    y: &[BottomSCell],
    config: BenchmarkConfig,
) -> MatrixEstimate {
    matrix_from(config.resolution, |column, row| {
        choose_bottom_s(
            estimate_bottom_s_containment(
                &x[column].core,
                &y[row].expanded,
                config.k,
                config.sketch_size,
            ),
            estimate_bottom_s_containment(
                &y[row].core,
                &x[column].expanded,
                config.k,
                config.sketch_size,
            ),
        )
    })
}

type Posting = (usize, Orientation);
type PostingMap = HashMap<u64, Vec<Posting>>;

fn postings(axis: &[BottomSCell], expanded: bool) -> PostingMap {
    let mut result = PostingMap::new();
    for (cell, sketch) in axis
        .iter()
        .enumerate()
        .map(|(index, item)| (index, if expanded { &item.expanded } else { &item.core }))
    {
        for item in sketch {
            result
                .entry(item.hash)
                .or_default()
                .push((cell, item.orientation));
        }
    }
    result
}

fn postings_matrix(
    x: &[BottomSCell],
    y: &[BottomSCell],
    y_expanded: &PostingMap,
    x_expanded: &PostingMap,
    config: BenchmarkConfig,
) -> MatrixEstimate {
    let cells = config.resolution * config.resolution;
    let mut x_shared = vec![0_u32; cells];
    let mut y_shared = vec![0_u32; cells];
    let mut x_direction = vec![DirectionEvidence::default(); cells];
    let mut y_direction = vec![DirectionEvidence::default(); cells];

    for (x_index, cell) in x.iter().enumerate() {
        for item in &cell.core {
            if let Some(matches) = y_expanded.get(&item.hash) {
                for &(y_index, orientation) in matches {
                    let output = y_index * config.resolution + x_index;
                    x_shared[output] += 1;
                    add_direction(&mut x_direction[output], item.orientation, orientation);
                }
            }
        }
    }
    for (y_index, cell) in y.iter().enumerate() {
        for item in &cell.core {
            if let Some(matches) = x_expanded.get(&item.hash) {
                for &(x_index, orientation) in matches {
                    let output = y_index * config.resolution + x_index;
                    y_shared[output] += 1;
                    add_direction(&mut y_direction[output], item.orientation, orientation);
                }
            }
        }
    }

    let mut containment = Vec::with_capacity(cells);
    let mut identity = Vec::with_capacity(cells);
    let mut direction = Vec::with_capacity(cells);
    for output in 0..cells {
        let x_index = output % config.resolution;
        let y_index = output / config.resolution;
        let x_score = ratio_score(x_shared[output], x[x_index].core.len(), config.k);
        let y_score = ratio_score(y_shared[output], y[y_index].core.len(), config.k);
        match (x_score, y_score) {
            (Some(left), Some(right)) if left.0 >= right.0 => {
                containment.push(Some(left.0));
                identity.push(Some(left.1));
                direction.push(x_direction[output]);
            }
            (Some(_), Some(right)) => {
                containment.push(Some(right.0));
                identity.push(Some(right.1));
                direction.push(y_direction[output]);
            }
            (Some(value), None) => {
                containment.push(Some(value.0));
                identity.push(Some(value.1));
                direction.push(x_direction[output]);
            }
            (None, Some(value)) => {
                containment.push(Some(value.0));
                identity.push(Some(value.1));
                direction.push(y_direction[output]);
            }
            (None, None) => {
                containment.push(None);
                identity.push(None);
                direction.push(DirectionEvidence::default());
            }
        }
    }
    MatrixEstimate {
        containment,
        identity,
        direction,
    }
}

fn oph_matrix(x: &AxisOverview, y: &AxisOverview, config: BenchmarkConfig) -> MatrixEstimate {
    let tile = compute_tile(
        x,
        y,
        TileRequest {
            x_start: 0,
            y_start: 0,
            width: config.resolution,
            height: config.resolution,
            b_bits: config.b_bits,
            register_limit: config.register_count,
            k: config.k,
        },
    );
    let identity = tile
        .identity
        .into_iter()
        .map(|value| (value != u16::MAX).then(|| f64::from(value) / 10_000.0))
        .collect::<Vec<_>>();
    let containment = identity
        .iter()
        .map(|ani| ani.map(|value| value.powi(i32::from(config.k))))
        .collect();
    let direction = tile
        .direction
        .into_iter()
        .zip(tile.direction_support)
        .map(|(signed, support)| {
            if support == 0 {
                DirectionEvidence::default()
            } else if signed >= 0 {
                DirectionEvidence {
                    forward: u32::from(support),
                    ..DirectionEvidence::default()
                }
            } else {
                DirectionEvidence {
                    reverse: u32::from(support),
                    ..DirectionEvidence::default()
                }
            }
        })
        .collect();
    MatrixEstimate {
        containment,
        identity,
        direction,
    }
}

struct DenseAxis {
    core: Vec<moddotplot_core::BitSlicedSignature>,
    expanded: Vec<moddotplot_core::BitSlicedSignature>,
}

impl DenseAxis {
    fn new(axis: &AxisOverview, config: BenchmarkConfig) -> Self {
        let seed = config.hash_seed ^ 0xa409_3822_299f_31d0;
        Self {
            core: axis
                .core
                .iter()
                .map(|sketch| sketch.densified_bit_sliced(32, config.register_count, seed))
                .collect(),
            expanded: axis
                .expanded
                .iter()
                .map(|sketch| sketch.densified_bit_sliced(32, config.register_count, seed))
                .collect(),
        }
    }

    fn estimated_bytes(&self) -> usize {
        self.core
            .iter()
            .chain(&self.expanded)
            .map(moddotplot_core::BitSlicedSignature::estimated_heap_bytes)
            .sum()
    }
}

fn dense_oph_matrix(x: &DenseAxis, y: &DenseAxis, config: BenchmarkConfig) -> MatrixEstimate {
    matrix_from(config.resolution, |column, row| {
        choose_containment(
            estimate_containment_bit_sliced(
                &x.core[column],
                &y.expanded[row],
                config.k,
                config.b_bits,
                config.register_count,
            ),
            estimate_containment_bit_sliced(
                &y.core[row],
                &x.expanded[column],
                config.k,
                config.b_bits,
                config.register_count,
            ),
        )
    })
}

#[derive(Clone, Copy, Debug, Default)]
struct SetLikeRegister {
    rank: u8,
    hash: u64,
    orientation: Orientation,
}

#[derive(Clone, Debug)]
struct SetLikeSketch {
    registers: Vec<SetLikeRegister>,
}

impl SetLikeSketch {
    fn new(register_count: usize) -> Self {
        Self {
            registers: vec![SetLikeRegister::default(); register_count],
        }
    }

    fn insert(&mut self, hash: u64, orientation: Orientation) {
        let mixed = fmix64(hash ^ 0x3c6e_f372_fe94_f82b);
        let bucket = usize::try_from(mixed % self.registers.len() as u64)
            .expect("register bucket fits usize");
        let remainder = fmix64(hash ^ 0xbb67_ae85_84ca_a73b);
        let rank = u8::try_from(remainder.leading_zeros() + 1).expect("rank is at most 65");
        let register = &mut self.registers[bucket];
        if rank > register.rank || (rank == register.rank && hash < register.hash) {
            *register = SetLikeRegister {
                rank,
                hash,
                orientation,
            };
        } else if rank == register.rank && hash == register.hash {
            register.orientation = register.orientation.combine(orientation);
        }
    }

    fn merge(&self, other: &Self) -> Self {
        let mut merged = self.clone();
        for (left, right) in merged.registers.iter_mut().zip(&other.registers) {
            if right.rank > left.rank || (right.rank == left.rank && right.hash < left.hash) {
                *left = *right;
            } else if right.rank == left.rank && right.hash == left.hash {
                left.orientation = left.orientation.combine(right.orientation);
            }
        }
        merged
    }

    fn cardinality(&self) -> f64 {
        let m_u32 = u32::try_from(self.registers.len()).expect("register count fits u32");
        let m = f64::from(m_u32);
        let zeros = self
            .registers
            .iter()
            .filter(|register| register.rank == 0)
            .count();
        if zeros == self.registers.len() {
            return 0.0;
        }
        let alpha = 0.7213 / (1.0 + 1.079 / m);
        let harmonic = self
            .registers
            .iter()
            .map(|register| 2_f64.powi(-i32::from(register.rank)))
            .sum::<f64>();
        let raw = alpha * m * m / harmonic;
        if raw <= 2.5 * m && zeros > 0 {
            m * (m / f64::from(u32::try_from(zeros).expect("zero count fits u32"))).ln()
        } else {
            raw
        }
    }

    fn direction_against(&self, other: &Self) -> DirectionEvidence {
        let mut evidence = DirectionEvidence::default();
        for (left, right) in self.registers.iter().zip(&other.registers) {
            if left.rank > 0 && left.hash == right.hash {
                add_direction(&mut evidence, left.orientation, right.orientation);
            }
        }
        evidence
    }
}

#[derive(Clone, Debug)]
struct SetLikeCell {
    core: SetLikeSketch,
    expanded: SetLikeSketch,
}

struct SetLikeAxis(Vec<SetLikeCell>);

impl SetLikeAxis {
    fn new(sequence: &PackedSequence, config: BenchmarkConfig) -> Self {
        let domain = sequence.len();
        let cells = (0..config.resolution)
            .map(|index| {
                let (start, end, expanded_start, expanded_end) =
                    bounds(index, config.resolution, domain);
                SetLikeCell {
                    core: set_like_range(sequence, start, end, config),
                    expanded: set_like_range(sequence, expanded_start, expanded_end, config),
                }
            })
            .collect();
        Self(cells)
    }

    fn estimated_bytes(&self) -> usize {
        self.0
            .iter()
            .map(|cell| {
                (cell.core.registers.capacity() + cell.expanded.registers.capacity())
                    * std::mem::size_of::<SetLikeRegister>()
            })
            .sum()
    }
}

fn set_like_range(
    sequence: &PackedSequence,
    start: u64,
    end: u64,
    config: BenchmarkConfig,
) -> SetLikeSketch {
    let mut sketch = SetLikeSketch::new(config.register_count);
    for kmer in sequence.canonical_kmers(config.k, start, end) {
        sketch.insert(
            hash_canonical(kmer.bits, config.k, config.hash_seed),
            kmer.orientation,
        );
    }
    sketch
}

fn set_like_matrix(x: &SetLikeAxis, y: &SetLikeAxis, config: BenchmarkConfig) -> MatrixEstimate {
    matrix_from(config.resolution, |column, row| {
        let left = set_like_containment(&x.0[column].core, &y.0[row].expanded, config.k);
        let right = set_like_containment(&y.0[row].core, &x.0[column].expanded, config.k);
        match (left, right) {
            (
                Some((left_containment, left_ani, left_direction)),
                Some((right_containment, right_ani, right_direction)),
            ) => {
                if left_containment >= right_containment {
                    Some((left_containment, left_ani, left_direction))
                } else {
                    Some((right_containment, right_ani, right_direction))
                }
            }
            (Some(value), None) | (None, Some(value)) => Some(value),
            (None, None) => None,
        }
    })
}

fn set_like_containment(
    x: &SetLikeSketch,
    y: &SetLikeSketch,
    k: u8,
) -> Option<(f64, f64, DirectionEvidence)> {
    let x_cardinality = x.cardinality();
    if x_cardinality <= 0.0 {
        return None;
    }
    let intersection =
        (x_cardinality + y.cardinality() - x.merge(y).cardinality()).clamp(0.0, x_cardinality);
    let containment = intersection / x_cardinality;
    let ani = if containment == 0.0 {
        0.0
    } else {
        containment.powf(1.0 / f64::from(k))
    };
    Some((containment, ani, x.direction_against(y)))
}

fn timed_matrix<F>(
    name: &'static str,
    build_time: Duration,
    estimated_bytes: usize,
    config: BenchmarkConfig,
    mut operation: F,
) -> KernelRun
where
    F: FnMut() -> MatrixEstimate,
{
    let _warm = operation();
    let mut measurements = Vec::with_capacity(config.repetitions);
    let mut matrix = None;
    for _ in 0..config.repetitions {
        let start = Instant::now();
        matrix = Some(operation());
        measurements.push(start.elapsed());
    }
    measurements.sort_unstable();
    KernelRun {
        name,
        build_time,
        matrix_time: measurements[measurements.len() / 2],
        estimated_bytes,
        matrix: matrix.expect("at least one repetition is required"),
        oph_diagnostics: None,
        adaptive_diagnostics: None,
    }
}

fn matrix_from<F>(resolution: usize, mut cell: F) -> MatrixEstimate
where
    F: FnMut(usize, usize) -> Option<(f64, f64, DirectionEvidence)>,
{
    let mut containment = Vec::with_capacity(resolution * resolution);
    let mut identity = Vec::with_capacity(resolution * resolution);
    let mut direction = Vec::with_capacity(resolution * resolution);
    for row in 0..resolution {
        for column in 0..resolution {
            if let Some((score, ani, evidence)) = cell(column, row) {
                containment.push(Some(score));
                identity.push(Some(ani));
                direction.push(evidence);
            } else {
                containment.push(None);
                identity.push(None);
                direction.push(DirectionEvidence::default());
            }
        }
    }
    MatrixEstimate {
        containment,
        identity,
        direction,
    }
}

fn all_pairs<T, F>(resolution: usize, mut cell: F) -> Vec<T>
where
    F: FnMut(usize, usize) -> T,
{
    let mut values = Vec::with_capacity(resolution * resolution);
    for row in 0..resolution {
        for column in 0..resolution {
            values.push(cell(column, row));
        }
    }
    values
}

fn choose_bottom_s(
    left: Option<moddotplot_core::BottomSContainment>,
    right: Option<moddotplot_core::BottomSContainment>,
) -> Option<(f64, f64, DirectionEvidence)> {
    match (left, right) {
        (Some(left), Some(right)) if left.containment >= right.containment => {
            Some((left.containment, left.ani, left.direction))
        }
        (Some(_), Some(right)) => Some((right.containment, right.ani, right.direction)),
        (Some(value), None) | (None, Some(value)) => {
            Some((value.containment, value.ani, value.direction))
        }
        (None, None) => None,
    }
}

fn choose_containment(
    left: Option<moddotplot_core::ContainmentEstimate>,
    right: Option<moddotplot_core::ContainmentEstimate>,
) -> Option<(f64, f64, DirectionEvidence)> {
    match (left, right) {
        (Some(left), Some(right)) if left.containment >= right.containment => {
            Some((left.containment, left.ani, left.direction))
        }
        (Some(_), Some(right)) => Some((right.containment, right.ani, right.direction)),
        (Some(value), None) | (None, Some(value)) => {
            Some((value.containment, value.ani, value.direction))
        }
        (None, None) => None,
    }
}

fn ratio_score(shared: u32, denominator: usize, k: u8) -> Option<(f64, f64)> {
    if denominator == 0 {
        return None;
    }
    let denominator = f64::from(u32::try_from(denominator).expect("sketch size fits u32"));
    let containment = (f64::from(shared) / denominator).clamp(0.0, 1.0);
    let ani = if containment == 0.0 {
        0.0
    } else {
        containment.powf(1.0 / f64::from(k))
    };
    Some((containment, ani))
}

fn bounds(index: usize, resolution: usize, domain: u64) -> (u64, u64, u64, u64) {
    let halves = resolution * 2;
    let boundary = |half: usize| {
        u64::try_from((half as u128 * u128::from(domain)).div_ceil(halves as u128))
            .expect("bounded coordinate fits u64")
    };
    (
        boundary(index * 2),
        boundary(index * 2 + 2),
        boundary((index * 2).saturating_sub(1)),
        boundary((index * 2 + 3).min(halves)),
    )
}

fn bottom_s_bytes(axis: &[BottomSCell]) -> usize {
    axis.iter()
        .map(|cell| {
            (cell.core.capacity() + cell.expanded.capacity()) * std::mem::size_of::<BottomSItem>()
        })
        .sum()
}

fn postings_bytes(postings: &PostingMap) -> usize {
    postings.capacity() * std::mem::size_of::<(u64, Vec<Posting>)>()
        + postings
            .values()
            .map(|values| values.capacity() * std::mem::size_of::<Posting>())
            .sum::<usize>()
}

fn add_direction(evidence: &mut DirectionEvidence, left: Orientation, right: Orientation) {
    match (left, right) {
        (Orientation::Forward, Orientation::Forward)
        | (Orientation::Reverse, Orientation::Reverse) => evidence.forward += 1,
        (Orientation::Forward, Orientation::Reverse)
        | (Orientation::Reverse, Orientation::Forward) => evidence.reverse += 1,
        _ => evidence.ambiguous += 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::corpus::build_corpus;

    #[test]
    fn every_kernel_returns_the_complete_matrix() {
        let config = BenchmarkConfig::smoke();
        let fixture = build_corpus(config.sequence_length).remove(1);
        let expected = config.resolution * config.resolution;
        for run in [
            run_bottom_s(&fixture.x, &fixture.y, config),
            run_minmer_postings(&fixture.x, &fixture.y, config),
            run_oph(&fixture.x, &fixture.y, config),
            run_densified_oph(&fixture.x, &fixture.y, config),
            run_setsketch_like(&fixture.x, &fixture.y, config),
        ] {
            assert_eq!(run.matrix.identity.len(), expected, "{}", run.name);
            assert_eq!(run.matrix.containment.len(), expected, "{}", run.name);
            assert_eq!(run.matrix.direction.len(), expected, "{}", run.name);
        }
    }

    #[test]
    fn scaled_segments_match_reference_interval_bounds() {
        let expected = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5];
        for (start, segment) in expected.into_iter().enumerate() {
            assert_eq!(scaled_segment(start as u64, 6, 10), segment);
        }
    }

    #[test]
    fn expected_match_model_responds_to_cardinality_imbalance() {
        let containment_floor = 0.80_f64.powi(21);
        let balanced = expected_oph_matches(8_000.0, 12_000.0, 1_024, containment_floor);
        let imbalanced = expected_oph_matches(8_000.0, 120_000.0, 1_024, containment_floor);
        assert!(balanced > imbalanced);
        assert!(balanced.is_finite() && imbalanced.is_finite());
    }

    #[test]
    fn query_hash_index_has_exact_membership() {
        let hashes = (0..10_000_u64)
            .map(|value| fmix64(value ^ 0xa409_3822_299f_31d0))
            .collect::<Vec<_>>();
        let index = QueryHashIndex::new(hashes.iter().copied());
        assert!(
            hashes
                .iter()
                .enumerate()
                .all(|(expected, &hash)| index.get(hash) == Some(expected))
        );
        assert!((20_000..30_000_u64).all(|value| index.get(fmix64(value)).is_none()));
    }

    #[test]
    fn forced_sparse_channel_matches_exact_containment() {
        let config = BenchmarkConfig {
            sequence_length: 16_384,
            resolution: 8,
            register_count: 256,
            repetitions: 1,
            ..BenchmarkConfig::smoke()
        };
        let sequence = PackedSequence::from_ascii("left", &pseudo_random_bases(16_384));
        let same = PackedSequence::from_ascii("right", &pseudo_random_bases(16_384));
        let exact = exact_oracle(&sequence, &same, config);
        let run = run_adaptive_oph(
            &sequence,
            &same,
            config,
            AdaptiveConfig {
                sparse_cap: 4_096,
                min_expected_matches: 1.0,
                ani_floor: 0.0,
            },
        );
        for (estimate, exact) in run.matrix.containment.iter().zip(exact) {
            match (estimate, exact) {
                (Some(estimate), Some(exact)) => {
                    assert!((estimate - exact.containment).abs() < 1e-12);
                }
                (None, None) => {}
                pair => panic!("mismatched exact evidence: {pair:?}"),
            }
        }
    }

    fn pseudo_random_bases(length: usize) -> Vec<u8> {
        let mut state = 0x9e37_79b9_7f4a_7c15_u64;
        (0..length)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                b"ACGT"[(state & 3) as usize]
            })
            .collect()
    }
}
