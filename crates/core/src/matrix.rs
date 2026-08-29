//! Axis summary construction and numeric matrix tiles.

use crate::adaptive::needs_exact_correction;
use crate::containment::{
    ContainmentEstimate, DirectionEvidence, estimate_containment, estimate_containment_bit_sliced,
    estimate_containment_from_comparison,
};
use crate::dna::PackedSequence;
use crate::hash::{HashAlgorithm, canonical_hashes};
use crate::sketch::{BitSlicedSignature, OphSketch, RegisterComparison};
use std::collections::HashMap;

/// Sentinel used for a matrix cell without valid k-mer evidence.
pub const MISSING_IDENTITY: u16 = u16::MAX;

const DIRECTION_FINGERPRINT_BITS: u8 = 32;

/// A complete distinct canonical-hash set retained for a bounded sparse core.
#[derive(Clone, Debug, Default)]
pub struct SparseCoreHashSet {
    items: HashMap<u64, crate::dna::Orientation>,
}

impl SparseCoreHashSet {
    /// Number of distinct canonical hashes.
    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// Returns true when the core has no valid canonical k-mers.
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Iterates over distinct hashes and their combined source orientation.
    pub fn iter(&self) -> impl Iterator<Item = (&u64, &crate::dna::Orientation)> {
        self.items.iter()
    }

    fn estimated_heap_bytes(&self) -> usize {
        self.items
            .capacity()
            .saturating_mul(std::mem::size_of::<(u64, crate::dna::Orientation)>())
    }
}

/// Core and neighbor-expanded interval sketches for one sequence axis.
#[derive(Clone, Debug)]
pub struct AxisOverview {
    /// FASTA record name.
    pub sequence_name: String,
    /// Length of this sequence in bases.
    pub sequence_length: u64,
    /// Shared coordinate domain used by both selected axes.
    pub domain_length: u64,
    /// Logical number of intervals across the common domain.
    pub resolution: usize,
    /// First global interval represented by the vectors in this summary.
    pub offset: usize,
    /// Half-open, sequence-clipped interval bounds.
    pub bounds: Vec<(u64, u64)>,
    /// Core interval sketches.
    pub core: Vec<OphSketch>,
    /// Intervals expanded by half a core width on either side.
    pub expanded: Vec<OphSketch>,
    /// Word-parallel encodings of core intervals.
    pub core_encoded: Vec<BitSlicedSignature>,
    /// Word-parallel encodings of expanded intervals.
    pub expanded_encoded: Vec<BitSlicedSignature>,
    /// Complete hashes for cores under an optional cardinality cap.
    ///
    /// This vector is empty for ordinary OPH-only builders. With the adaptive
    /// builder it has one entry per represented core; `None` means the cap was
    /// exceeded and the partial set was released.
    pub sparse_core: Vec<Option<SparseCoreHashSet>>,
}

impl AxisOverview {
    /// Approximate bytes owned by heap allocations, excluding allocator overhead.
    pub fn estimated_heap_bytes(&self) -> usize {
        self.sequence_name
            .capacity()
            .saturating_add(
                self.bounds
                    .capacity()
                    .saturating_mul(std::mem::size_of::<(u64, u64)>()),
            )
            .saturating_add(
                self.core
                    .capacity()
                    .saturating_mul(std::mem::size_of::<OphSketch>()),
            )
            .saturating_add(
                self.expanded
                    .capacity()
                    .saturating_mul(std::mem::size_of::<OphSketch>()),
            )
            .saturating_add(
                self.core_encoded
                    .capacity()
                    .saturating_mul(std::mem::size_of::<BitSlicedSignature>()),
            )
            .saturating_add(
                self.expanded_encoded
                    .capacity()
                    .saturating_mul(std::mem::size_of::<BitSlicedSignature>()),
            )
            .saturating_add(
                self.core
                    .iter()
                    .chain(&self.expanded)
                    .map(OphSketch::estimated_heap_bytes)
                    .sum::<usize>(),
            )
            .saturating_add(
                self.sparse_core
                    .capacity()
                    .saturating_mul(std::mem::size_of::<Option<SparseCoreHashSet>>()),
            )
            .saturating_add(
                self.sparse_core
                    .iter()
                    .filter_map(Option::as_ref)
                    .map(SparseCoreHashSet::estimated_heap_bytes)
                    .sum::<usize>(),
            )
            .saturating_add(
                self.core_encoded
                    .iter()
                    .chain(&self.expanded_encoded)
                    .map(BitSlicedSignature::estimated_heap_bytes)
                    .sum::<usize>(),
            )
    }
}

/// Request for one row-major numeric matrix tile.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TileRequest {
    /// First x interval.
    pub x_start: usize,
    /// First y interval.
    pub y_start: usize,
    /// Requested tile width.
    pub width: usize,
    /// Requested tile height.
    pub height: usize,
    /// Number of retained hash bits.
    pub b_bits: u8,
    /// Number of aligned registers to compare.
    pub register_limit: usize,
    /// K-mer length used by the ANI transform.
    pub k: u8,
}

/// Statistical decision used by detailed tiles with bounded exact sparse cores.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SparseCorrectionPolicy {
    /// ANI floor at which match detection is evaluated.
    pub ani_floor: f64,
    /// Minimum probability of observing at least one true matching register.
    pub minimum_detection_probability: f64,
}

/// Numeric matrix data consumed directly by the renderer and future exporters.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatrixTile {
    /// Actual width after clipping to the axis resolution.
    pub width: usize,
    /// Actual height after clipping to the axis resolution.
    pub height: usize,
    /// ANI multiplied by 10,000, or [`MISSING_IDENTITY`].
    pub identity: Vec<u16>,
    /// Signed relative direction scaled to `[-32767, 32767]`.
    pub direction: Vec<i16>,
    /// Number of full-hash informative direction matches, saturated to `u16`.
    pub direction_support: Vec<u16>,
}

/// Builds aligned core and delta=0.5 expanded interval sketches in one k-mer scan.
///
/// K-mer starts are assigned to `2 * resolution` half-bin segments. Core and expanded
/// sketches are then exact registerwise unions of those segments. This avoids hashing
/// the same sequence separately for core and neighbor-expanded intervals.
///
/// # Panics
///
/// Panics if the domain is empty or shorter than the sequence, the resolution is zero
/// or overflows its half-bin representation, or sketch parameters are invalid.
pub fn build_axis_overview(
    sequence: &PackedSequence,
    domain_length: u64,
    resolution: usize,
    k: u8,
    seed: u64,
    register_count: usize,
    hll_precision: u8,
) -> AxisOverview {
    build_axis_overview_with_hash(
        sequence,
        domain_length,
        resolution,
        k,
        seed,
        register_count,
        hll_precision,
        HashAlgorithm::PackedFmix64,
    )
}

/// Builds a complete overview with an explicitly selected hash stream.
///
/// This entry point exists so scientific benchmarks can change only the hash stream
/// while retaining identical interval assignment, sketching, and encoding code.
#[allow(clippy::too_many_arguments)]
pub fn build_axis_overview_with_hash(
    sequence: &PackedSequence,
    domain_length: u64,
    resolution: usize,
    k: u8,
    seed: u64,
    register_count: usize,
    hll_precision: u8,
    hash_algorithm: HashAlgorithm,
) -> AxisOverview {
    build_axis_range_internal(
        sequence,
        domain_length,
        resolution,
        0,
        resolution,
        k,
        seed,
        register_count,
        hll_precision,
        hash_algorithm,
        None,
    )
}

/// Builds OPH/HLL summaries while retaining complete hashes for bounded sparse cores.
///
/// Exact hashes are collected from the same canonical k-mer stream as the OPH
/// summaries. A core's partial exact set is released immediately when its distinct
/// cardinality exceeds `sparse_cap`.
///
/// # Panics
///
/// Panics under the same invalid coordinate and sketch-parameter conditions as
/// [`build_axis_overview_with_hash`], or when `sparse_cap` is zero.
#[allow(clippy::too_many_arguments)]
pub fn build_axis_overview_adaptive_with_hash(
    sequence: &PackedSequence,
    domain_length: u64,
    resolution: usize,
    k: u8,
    seed: u64,
    register_count: usize,
    hll_precision: u8,
    hash_algorithm: HashAlgorithm,
    sparse_cap: usize,
) -> AxisOverview {
    assert!(sparse_cap > 0);
    build_axis_range_internal(
        sequence,
        domain_length,
        resolution,
        0,
        resolution,
        k,
        seed,
        register_count,
        hll_precision,
        hash_algorithm,
        Some(sparse_cap),
    )
}

/// Builds sketches for a contiguous range of intervals at an arbitrary resolution.
///
/// Only the half-bin segments needed by `[bin_start, bin_start + bin_count)` and
/// its containment halo are scanned and retained. The result is therefore suitable
/// for demand-driven zoom tiles without allocating an entire high-resolution axis.
///
/// # Panics
///
/// Panics if the domain or sketch parameters are invalid, `bin_count` is zero, or
/// `bin_start` lies outside the requested resolution.
#[allow(clippy::too_many_arguments)]
pub fn build_axis_range(
    sequence: &PackedSequence,
    domain_length: u64,
    resolution: usize,
    bin_start: usize,
    bin_count: usize,
    k: u8,
    seed: u64,
    register_count: usize,
    hll_precision: u8,
) -> AxisOverview {
    build_axis_range_with_hash(
        sequence,
        domain_length,
        resolution,
        bin_start,
        bin_count,
        k,
        seed,
        register_count,
        hll_precision,
        HashAlgorithm::PackedFmix64,
    )
}

/// Builds a range of axis summaries with an explicitly selected hash stream.
///
/// All algorithms share the same coordinate assignment and OPH insertion path. This
/// prevents hash benchmarks from accidentally timing different sketch builders.
///
/// # Panics
///
/// Panics under the same invalid coordinate and sketch-parameter conditions as
/// [`build_axis_range`].
#[allow(clippy::too_many_arguments)]
pub fn build_axis_range_with_hash(
    sequence: &PackedSequence,
    domain_length: u64,
    resolution: usize,
    bin_start: usize,
    bin_count: usize,
    k: u8,
    seed: u64,
    register_count: usize,
    hll_precision: u8,
    hash_algorithm: HashAlgorithm,
) -> AxisOverview {
    build_axis_range_internal(
        sequence,
        domain_length,
        resolution,
        bin_start,
        bin_count,
        k,
        seed,
        register_count,
        hll_precision,
        hash_algorithm,
        None,
    )
}

/// Builds a ranged axis summary while retaining complete hashes for bounded sparse cores.
///
/// This is the demand-driven counterpart of [`build_axis_overview_adaptive_with_hash`].
/// Partial exact sets are discarded immediately when `sparse_cap` is exceeded.
///
/// # Panics
///
/// Panics under the same conditions as [`build_axis_range_with_hash`], or when
/// `sparse_cap` is zero.
#[allow(clippy::too_many_arguments)]
pub fn build_axis_range_adaptive_with_hash(
    sequence: &PackedSequence,
    domain_length: u64,
    resolution: usize,
    bin_start: usize,
    bin_count: usize,
    k: u8,
    seed: u64,
    register_count: usize,
    hll_precision: u8,
    hash_algorithm: HashAlgorithm,
    sparse_cap: usize,
) -> AxisOverview {
    assert!(sparse_cap > 0);
    build_axis_range_internal(
        sequence,
        domain_length,
        resolution,
        bin_start,
        bin_count,
        k,
        seed,
        register_count,
        hll_precision,
        hash_algorithm,
        Some(sparse_cap),
    )
}

#[allow(clippy::too_many_arguments)]
fn build_axis_range_internal(
    sequence: &PackedSequence,
    domain_length: u64,
    resolution: usize,
    bin_start: usize,
    bin_count: usize,
    k: u8,
    seed: u64,
    register_count: usize,
    hll_precision: u8,
    hash_algorithm: HashAlgorithm,
    sparse_cap: Option<usize>,
) -> AxisOverview {
    assert!(domain_length >= sequence.len() && domain_length > 0);
    assert!(resolution > 0 && resolution <= usize::MAX / 2);
    assert!(bin_count > 0);
    assert!(bin_start < resolution);
    let bin_end = bin_start.saturating_add(bin_count).min(resolution);
    let half_count = resolution * 2;
    let first_half = (2 * bin_start).saturating_sub(1);
    let end_half = (2 * bin_end + 1).min(half_count);
    let represented_half_count = end_half - first_half;
    let empty = OphSketch::new(register_count, hll_precision);
    let mut halves = vec![empty.clone(); represented_half_count];
    let represented_bins = bin_end - bin_start;
    let mut sparse_core = sparse_cap.map(|_| {
        (0..represented_bins)
            .map(|_| Some(SparseCoreHashSet::default()))
            .collect::<Vec<_>>()
    });

    // Segment boundaries use ceilings because assignment uses floor(start * H / D).
    // The conservative bounds are clipped by the sequence iterator and the explicit
    // segment range check below.
    let genomic_start = divide_ceil(first_half as u128 * u128::from(domain_length), half_count);
    let genomic_end = divide_ceil(end_half as u128 * u128::from(domain_length), half_count);

    for kmer in canonical_hashes(
        sequence,
        k,
        genomic_start,
        genomic_end,
        hash_algorithm,
        seed,
    ) {
        let segment =
            ((u128::from(kmer.start) * half_count as u128) / u128::from(domain_length)) as usize;
        let global_bin = segment / 2;
        if let (Some(cap), Some(cores), Some(local_bin)) = (
            sparse_cap,
            sparse_core.as_mut(),
            global_bin.checked_sub(bin_start),
        ) && let Some(slot) = cores.get_mut(local_bin)
            && let Some(core) = slot.as_mut()
        {
            if let Some(orientation) = core.items.get_mut(&kmer.hash) {
                *orientation = orientation.combine(kmer.orientation);
            } else if core.items.len() < cap {
                core.items.insert(kmer.hash, kmer.orientation);
            } else {
                *slot = None;
            }
        }
        if let Some(sketch) = segment
            .checked_sub(first_half)
            .and_then(|local| halves.get_mut(local))
        {
            sketch.insert(kmer.hash, kmer.orientation);
        }
    }

    let mut core = Vec::with_capacity(represented_bins);
    let mut expanded = Vec::with_capacity(represented_bins);
    let mut bounds = Vec::with_capacity(represented_bins);
    for bin in bin_start..bin_end {
        let mut core_sketch = empty.clone();
        core_sketch.merge(&halves[2 * bin - first_half]);
        core_sketch.merge(&halves[2 * bin + 1 - first_half]);
        core.push(core_sketch);

        let expanded_first = (2 * bin).saturating_sub(1);
        let expanded_end = (2 * bin + 3).min(half_count);
        let mut expanded_sketch = empty.clone();
        for half in &halves[expanded_first - first_half..expanded_end - first_half] {
            expanded_sketch.merge(half);
        }
        expanded.push(expanded_sketch);

        let start = divide_ceil(bin as u128 * u128::from(domain_length), resolution);
        let end = divide_ceil((bin + 1) as u128 * u128::from(domain_length), resolution);
        bounds.push((start.min(sequence.len()), end.min(sequence.len())));
    }

    let core_encoded = core
        .iter()
        .map(|sketch| sketch.bit_sliced(DIRECTION_FINGERPRINT_BITS, register_count))
        .collect();
    let expanded_encoded = expanded
        .iter()
        .map(|sketch| sketch.bit_sliced(DIRECTION_FINGERPRINT_BITS, register_count))
        .collect();

    AxisOverview {
        sequence_name: sequence.name().to_owned(),
        sequence_length: sequence.len(),
        domain_length,
        resolution,
        offset: bin_start,
        bounds,
        core,
        expanded,
        core_encoded,
        expanded_encoded,
        sparse_core: sparse_core.unwrap_or_default(),
    }
}

fn divide_ceil(numerator: u128, denominator: usize) -> u64 {
    let denominator = denominator as u128;
    u64::try_from(numerator.div_ceil(denominator))
        .expect("a coordinate within a u64 domain must fit in u64")
}

/// Computes a clipped matrix tile using `ModDotPlot`'s maximum directed containment.
///
/// # Panics
///
/// Panics if the axes use different domains or resolutions, or contain incompatible
/// sketch parameters.
pub fn compute_tile(x: &AxisOverview, y: &AxisOverview, request: TileRequest) -> MatrixTile {
    compute_tile_impl(x, y, request, true)
}

/// Computes a tile and exactly corrects only statistically underpowered sparse directions.
///
/// The ordinary OPH estimate is produced first. Complete core hash sets retained by the
/// adaptive builder are considered for correction only when the probability model predicts
/// insufficient match detection at `policy.ani_floor`. Target sequence hashes are streamed
/// only across the requested tile range and shared across all eligible query cores.
///
/// # Panics
///
/// Panics under the same incompatible-axis and request conditions as [`compute_tile`],
/// or if adaptive summaries and source sequences do not describe the same coordinate
/// domain and hash configuration.
#[allow(clippy::too_many_arguments)]
pub fn compute_tile_adaptive(
    x: &AxisOverview,
    y: &AxisOverview,
    x_sequence: &PackedSequence,
    y_sequence: &PackedSequence,
    hash_algorithm: HashAlgorithm,
    seed: u64,
    request: TileRequest,
    policy: SparseCorrectionPolicy,
) -> MatrixTile {
    let mut tile = compute_tile(x, y, request);
    if x.sparse_core.is_empty() && y.sparse_core.is_empty() {
        return tile;
    }
    let x_exact = exact_sparse_tile_direction(
        x,
        y,
        y_sequence,
        hash_algorithm,
        seed,
        request,
        policy,
        true,
    );
    let y_exact = exact_sparse_tile_direction(
        y,
        x,
        x_sequence,
        hash_algorithm,
        seed,
        request,
        policy,
        false,
    );
    for row in 0..tile.height {
        let y_local = request.y_start + row - y.offset;
        for column in 0..tile.width {
            let output = row * tile.width + column;
            if x_exact[output].is_none() && y_exact[output].is_none() {
                continue;
            }
            let x_local = request.x_start + column - x.offset;
            let left = x_exact[output].or_else(|| {
                estimate_containment_bit_sliced(
                    &x.core_encoded[x_local],
                    &y.expanded_encoded[y_local],
                    request.k,
                    request.b_bits,
                    request.register_limit,
                )
                .map(DirectedScore::from)
            });
            let right = y_exact[output].or_else(|| {
                estimate_containment_bit_sliced(
                    &y.core_encoded[y_local],
                    &x.expanded_encoded[x_local],
                    request.k,
                    request.b_bits,
                    request.register_limit,
                )
                .map(DirectedScore::from)
            });
            let Some(score) = choose_directed_score(left, right) else {
                continue;
            };
            tile.identity[output] = encode_identity(score.ani);
            tile.direction[output] = score.direction.signed().map_or(0, encode_direction);
            tile.direction_support[output] =
                u16::try_from(score.direction.informative().min(u32::from(u16::MAX)))
                    .expect("support was clamped to u16::MAX");
        }
    }
    tile
}

#[derive(Clone, Copy, Debug)]
struct DirectedScore {
    containment: f64,
    ani: f64,
    direction: DirectionEvidence,
}

impl From<ContainmentEstimate> for DirectedScore {
    fn from(value: ContainmentEstimate) -> Self {
        Self {
            containment: value.containment,
            ani: value.ani,
            direction: value.direction,
        }
    }
}

#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
fn exact_sparse_tile_direction(
    query: &AxisOverview,
    target: &AxisOverview,
    target_sequence: &PackedSequence,
    hash_algorithm: HashAlgorithm,
    seed: u64,
    request: TileRequest,
    policy: SparseCorrectionPolicy,
    query_is_x: bool,
) -> Vec<Option<DirectedScore>> {
    let query_end = query.offset + query.core.len();
    let target_end = target.offset + target.core.len();
    let (x_end, y_end) = if query_is_x {
        (query_end, target_end)
    } else {
        (target_end, query_end)
    };
    let width = request.width.min(x_end.saturating_sub(request.x_start));
    let height = request.height.min(y_end.saturating_sub(request.y_start));
    let mut scores = vec![None; width.saturating_mul(height)];
    let (query_start, query_count, target_start, target_count) = if query_is_x {
        (request.x_start, width, request.y_start, height)
    } else {
        (request.y_start, height, request.x_start, width)
    };
    if query_count == 0 || target_count == 0 || query.sparse_core.is_empty() {
        return scores;
    }

    let mut corrections = vec![false; query_count.saturating_mul(target_count)];
    let mut postings = HashMap::<u64, Vec<(usize, crate::dna::Orientation)>>::new();
    for query_offset in 0..query_count {
        let query_local = query_start + query_offset - query.offset;
        let Some(core) = query.sparse_core.get(query_local).and_then(Option::as_ref) else {
            continue;
        };
        let mut eligible = false;
        for target_offset in 0..target_count {
            let target_local = target_start + target_offset - target.offset;
            let correct = needs_exact_correction(
                core.len(),
                target.expanded[target_local].estimated_cardinality(),
                request.register_limit,
                request.k,
                policy.ani_floor,
                policy.minimum_detection_probability,
            );
            corrections[query_offset * target_count + target_offset] = correct;
            eligible |= correct;
        }
        if eligible {
            for (&hash, &orientation) in core.iter() {
                postings
                    .entry(hash)
                    .or_default()
                    .push((query_offset, orientation));
            }
        }
    }
    if postings.is_empty() {
        return scores;
    }

    let mut queries = postings.into_iter().collect::<Vec<_>>();
    queries.sort_unstable_by_key(|(hash, _)| *hash);
    let index = PrehashedQueryIndex::new(queries.iter().map(|(hash, _)| *hash));
    let mut target_orientation =
        vec![crate::dna::Orientation::Unknown; queries.len() * target_count];
    let half_count = target.resolution * 2;
    let first_half = (2 * target_start).saturating_sub(1);
    let end_half = (2 * (target_start + target_count) + 1).min(half_count);
    let genomic_start = divide_ceil(
        first_half as u128 * u128::from(target.domain_length),
        half_count,
    );
    let genomic_end = divide_ceil(
        end_half as u128 * u128::from(target.domain_length),
        half_count,
    );
    for item in canonical_hashes(
        target_sequence,
        request.k,
        genomic_start,
        genomic_end,
        hash_algorithm,
        seed,
    ) {
        let Some(query_id) = index.get(item.hash) else {
            continue;
        };
        let half = ((u128::from(item.start) * half_count as u128)
            / u128::from(target.domain_length)) as usize;
        let (first, last) = expanded_target_cells(half, target.resolution);
        for target_cell in [first, last] {
            if !(target_start..target_start + target_count).contains(&target_cell) {
                continue;
            }
            let slot = &mut target_orientation
                [query_id * target_count + target_cell.saturating_sub(target_start)];
            *slot = slot.combine(item.orientation);
        }
    }

    let mut shared = vec![0_u32; scores.len()];
    let mut direction = vec![DirectionEvidence::default(); scores.len()];
    for (query_id, (_, query_postings)) in queries.iter().enumerate() {
        for target_offset in 0..target_count {
            let target_strand = target_orientation[query_id * target_count + target_offset];
            if target_strand == crate::dna::Orientation::Unknown {
                continue;
            }
            for &(query_offset, query_strand) in query_postings {
                if !corrections[query_offset * target_count + target_offset] {
                    continue;
                }
                let output = if query_is_x {
                    target_offset * width + query_offset
                } else {
                    query_offset * width + target_offset
                };
                shared[output] = shared[output].saturating_add(1);
                add_exact_direction(&mut direction[output], query_strand, target_strand);
            }
        }
    }

    for query_offset in 0..query_count {
        let query_local = query_start + query_offset - query.offset;
        let Some(denominator) = query.sparse_core[query_local]
            .as_ref()
            .map(SparseCoreHashSet::len)
        else {
            continue;
        };
        if denominator == 0 {
            continue;
        }
        for target_offset in 0..target_count {
            if !corrections[query_offset * target_count + target_offset] {
                continue;
            }
            let output = if query_is_x {
                target_offset * width + query_offset
            } else {
                query_offset * width + target_offset
            };
            let containment = f64::from(shared[output])
                / f64::from(u32::try_from(denominator).expect("the sparse cap fits u32"));
            scores[output] = Some(DirectedScore {
                containment,
                ani: if containment == 0.0 {
                    0.0
                } else {
                    containment.powf(1.0 / f64::from(request.k))
                },
                direction: direction[output],
            });
        }
    }
    scores
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

fn add_exact_direction(
    evidence: &mut DirectionEvidence,
    query: crate::dna::Orientation,
    target: crate::dna::Orientation,
) {
    use crate::dna::Orientation::{Both, Forward, Reverse, Unknown};
    match (query, target) {
        (Forward, Forward) | (Reverse, Reverse) => {
            evidence.forward = evidence.forward.saturating_add(1);
        }
        (Forward, Reverse) | (Reverse, Forward) => {
            evidence.reverse = evidence.reverse.saturating_add(1);
        }
        (Both | Unknown, _) | (_, Both | Unknown) => {
            evidence.ambiguous = evidence.ambiguous.saturating_add(1);
        }
    }
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

/// Minimal open-addressing index for a set of already uniform 64-bit hashes.
struct PrehashedQueryIndex {
    keys: Vec<u64>,
    values: Vec<usize>,
    occupied: Vec<bool>,
    mask: usize,
    index_shift: u32,
}

impl PrehashedQueryIndex {
    fn new(hashes: impl IntoIterator<Item = u64>) -> Self {
        let hashes = hashes.into_iter().collect::<Vec<_>>();
        let capacity = hashes.len().saturating_mul(2).max(2).next_power_of_two();
        let mut index = Self {
            keys: vec![0; capacity],
            values: vec![0; capacity],
            occupied: vec![false; capacity],
            mask: capacity - 1,
            index_shift: 64 - capacity.trailing_zeros(),
        };
        for (value, hash) in hashes.into_iter().enumerate() {
            index.insert(hash, value);
        }
        index
    }

    fn insert(&mut self, hash: u64, value: usize) {
        let mut slot = self.index(hash);
        while self.occupied[slot] {
            if self.keys[slot] == hash {
                return;
            }
            slot = (slot + 1) & self.mask;
        }
        self.occupied[slot] = true;
        self.keys[slot] = hash;
        self.values[slot] = value;
    }

    fn get(&self, hash: u64) -> Option<usize> {
        let mut slot = self.index(hash);
        while self.occupied[slot] {
            if self.keys[slot] == hash {
                return Some(self.values[slot]);
            }
            slot = (slot + 1) & self.mask;
        }
        None
    }

    fn index(&self, hash: u64) -> usize {
        let mixed = hash.wrapping_mul(0x9e37_79b9_7f4a_7c15);
        usize::try_from(mixed >> self.index_shift).expect("a table index must fit usize")
    }
}

/// Computes a tile with the scalar register comparison used for differential testing.
///
/// # Panics
///
/// Panics under the same incompatible-axis and invalid-parameter conditions as
/// [`compute_tile`].
pub fn compute_tile_reference(
    x: &AxisOverview,
    y: &AxisOverview,
    request: TileRequest,
) -> MatrixTile {
    compute_tile_impl(x, y, request, false)
}

/// Computes a tile by inverting b-bit winners within each aligned register.
///
/// This kernel is intended for large all-pairs overview tiles. It preserves the same
/// counters, collision correction, 32-bit verification, containment transform, and
/// direction semantics as [`compute_tile`], but visits only equal b-bit winner pairs
/// after a word-parallel occupancy pass.
///
/// # Panics
///
/// Panics under the same incompatible-axis conditions as [`compute_tile`], or if
/// `b_bits` is outside `1..=16`.
pub fn compute_tile_inverted(
    x: &AxisOverview,
    y: &AxisOverview,
    request: TileRequest,
) -> MatrixTile {
    assert_eq!(x.domain_length, y.domain_length);
    assert_eq!(x.resolution, y.resolution);
    assert!((1..=16).contains(&request.b_bits));
    assert!(request.x_start >= x.offset);
    assert!(request.y_start >= y.offset);
    let x_end = x.offset + x.core.len();
    let y_end = y.offset + y.core.len();
    let width = request.width.min(x_end.saturating_sub(request.x_start));
    let height = request.height.min(y_end.saturating_sub(request.y_start));
    let x_local = request.x_start - x.offset;
    let y_local = request.y_start - y.offset;
    let x_range = x_local..x_local + width;
    let y_range = y_local..y_local + height;
    let left = inverted_register_counts(
        &x.core[x_range.clone()],
        &y.expanded[y_range.clone()],
        &x.core_encoded[x_range.clone()],
        &y.expanded_encoded[y_range.clone()],
        request.b_bits,
        request.register_limit,
    );
    let is_self_axis = std::ptr::eq(x, y);
    let mirrored = is_self_axis && request.x_start == request.y_start && width == height;
    let right = (!mirrored).then(|| {
        inverted_register_counts(
            &y.core[y_range.clone()],
            &x.expanded[x_range.clone()],
            &y.core_encoded[y_range.clone()],
            &x.expanded_encoded[x_range.clone()],
            request.b_bits,
            request.register_limit,
        )
    });
    assemble_inverted_tile(
        x,
        y,
        request,
        width,
        height,
        x_local,
        y_local,
        &left,
        right.as_deref(),
    )
}

#[allow(clippy::too_many_arguments)]
fn assemble_inverted_tile(
    x: &AxisOverview,
    y: &AxisOverview,
    request: TileRequest,
    width: usize,
    height: usize,
    x_local: usize,
    y_local: usize,
    left: &[RegisterComparison],
    right: Option<&[RegisterComparison]>,
) -> MatrixTile {
    let mut tile = MatrixTile {
        width,
        height,
        identity: vec![MISSING_IDENTITY; width * height],
        direction: vec![0; width * height],
        direction_support: vec![0; width * height],
    };
    let mirrored = right.is_none();
    for row in 0..height {
        for column in 0..width {
            let output = row * width + column;
            if x.core[x_local + column].observations() == 0
                || y.core[y_local + row].observations() == 0
            {
                continue;
            }
            if mirrored && row == column {
                tile.identity[output] = 10_000;
                tile.direction[output] = i16::MAX;
                tile.direction_support[output] = 1;
                continue;
            }
            let left_score = estimate_containment_from_comparison(
                x.core[x_local + column].estimated_cardinality(),
                y.expanded[y_local + row].estimated_cardinality(),
                request.k,
                request.b_bits,
                left[output],
            );
            let right_counts = right.map_or_else(
                || left[column * width + row],
                |counts| counts[column * height + row],
            );
            let right_score = estimate_containment_from_comparison(
                y.core[y_local + row].estimated_cardinality(),
                x.expanded[x_local + column].estimated_cardinality(),
                request.k,
                request.b_bits,
                right_counts,
            );
            let Some((ani, direction)) = choose_score(left_score, right_score) else {
                continue;
            };
            tile.identity[output] = encode_identity(ani);
            if let Some(signed) = direction.signed() {
                tile.direction[output] = encode_direction(signed);
            }
            tile.direction_support[output] =
                u16::try_from(direction.informative().min(u32::from(u16::MAX)))
                    .expect("support was clamped to u16::MAX");
        }
    }
    tile
}

fn inverted_register_counts(
    query: &[OphSketch],
    target: &[OphSketch],
    query_encoded: &[BitSlicedSignature],
    target_encoded: &[BitSlicedSignature],
    b: u8,
    register_limit: usize,
) -> Vec<RegisterComparison> {
    let width = query.len();
    let height = target.len();
    let mut counts = vec![RegisterComparison::default(); width * height];
    for (row, target_signature) in target_encoded.iter().enumerate() {
        for (column, query_signature) in query_encoded.iter().enumerate() {
            counts[row * width + column].considered =
                query_signature.considered_with(target_signature, register_limit);
        }
    }

    let register_count = register_limit.min(
        query
            .first()
            .map_or(0, OphSketch::register_count)
            .min(target.first().map_or(0, OphSketch::register_count)),
    );
    let bucket_count = 1_usize << b;
    let mask = (1_u64 << b) - 1;
    let verification_mask = u64::from(u32::MAX);
    let mut heads = vec![usize::MAX; bucket_count];
    let mut next = vec![usize::MAX; height];
    let mut touched = Vec::<usize>::new();
    for register in 0..register_count {
        for (row, sketch) in target.iter().enumerate() {
            let Some((hash, _)) = sketch.winner(register) else {
                continue;
            };
            let bucket = usize::try_from(hash & mask).expect("at most 16 bits fit usize");
            if heads[bucket] == usize::MAX {
                touched.push(bucket);
            }
            next[row] = heads[bucket];
            heads[bucket] = row;
        }
        for (column, sketch) in query.iter().enumerate() {
            let Some((query_hash, query_orientation)) = sketch.winner(register) else {
                continue;
            };
            let bucket = usize::try_from(query_hash & mask).expect("at most 16 bits fit usize");
            let mut row = heads[bucket];
            while row != usize::MAX {
                let output = row * width + column;
                counts[output].bbit_matches += 1;
                let (target_hash, target_orientation) = target[row]
                    .winner(register)
                    .expect("a bucket posting must have an occupied winner");
                if query_hash & verification_mask == target_hash & verification_mask {
                    counts[output].verified_matches += 1;
                    add_register_direction(
                        &mut counts[output],
                        query_orientation,
                        target_orientation,
                    );
                }
                row = next[row];
            }
        }
        for bucket in touched.drain(..) {
            heads[bucket] = usize::MAX;
        }
    }
    counts
}

fn add_register_direction(
    counts: &mut RegisterComparison,
    query: crate::dna::Orientation,
    target: crate::dna::Orientation,
) {
    use crate::dna::Orientation::{Both, Forward, Reverse, Unknown};
    match (query, target) {
        (Forward, Forward) | (Reverse, Reverse) => counts.forward_matches += 1,
        (Forward, Reverse) | (Reverse, Forward) => counts.reverse_matches += 1,
        (Both | Unknown, _) | (_, Both | Unknown) => counts.ambiguous_matches += 1,
    }
}

fn compute_tile_impl(
    x: &AxisOverview,
    y: &AxisOverview,
    request: TileRequest,
    use_bit_sliced: bool,
) -> MatrixTile {
    assert_eq!(x.domain_length, y.domain_length);
    assert_eq!(x.resolution, y.resolution);
    assert!(request.x_start >= x.offset);
    assert!(request.y_start >= y.offset);
    let x_end = x.offset + x.core.len();
    let y_end = y.offset + y.core.len();
    let width = request.width.min(x_end.saturating_sub(request.x_start));
    let height = request.height.min(y_end.saturating_sub(request.y_start));
    let cell_count = width.saturating_mul(height);
    let mut tile = MatrixTile {
        width,
        height,
        identity: vec![MISSING_IDENTITY; cell_count],
        direction: vec![0; cell_count],
        direction_support: vec![0; cell_count],
    };
    let is_self_axis = std::ptr::eq(x, y);
    let mirror_within_tile = is_self_axis && request.x_start == request.y_start && width == height;

    for row in 0..height {
        let y_index = request.y_start + row;
        let y_local = y_index - y.offset;
        for column in 0..width {
            let x_index = request.x_start + column;
            let x_local = x_index - x.offset;
            let output = row * width + column;
            if mirror_within_tile && column < row {
                let transpose = column * width + row;
                tile.identity[output] = tile.identity[transpose];
                tile.direction[output] = tile.direction[transpose];
                tile.direction_support[output] = tile.direction_support[transpose];
                continue;
            }
            if x.core[x_local].observations() == 0 || y.core[y_local].observations() == 0 {
                continue;
            }

            // A self interval compared with its own expanded interval has exact
            // containment one. Do not let sketch variance introduce a false gap in
            // the main diagonal, which is a known scientific invariant rather than
            // an estimated value.
            if is_self_axis && x_index == y_index {
                tile.identity[output] = 10_000;
                tile.direction[output] = i16::MAX;
                tile.direction_support[output] = 1;
                continue;
            }

            let (x_in_y, y_in_x) = if use_bit_sliced {
                (
                    estimate_containment_bit_sliced(
                        &x.core_encoded[x_local],
                        &y.expanded_encoded[y_local],
                        request.k,
                        request.b_bits,
                        request.register_limit,
                    ),
                    estimate_containment_bit_sliced(
                        &y.core_encoded[y_local],
                        &x.expanded_encoded[x_local],
                        request.k,
                        request.b_bits,
                        request.register_limit,
                    ),
                )
            } else {
                (
                    estimate_containment(
                        &x.core[x_local],
                        &y.expanded[y_local],
                        request.k,
                        request.b_bits,
                        request.register_limit,
                    ),
                    estimate_containment(
                        &y.core[y_local],
                        &x.expanded[x_local],
                        request.k,
                        request.b_bits,
                        request.register_limit,
                    ),
                )
            };
            let Some((ani, direction)) = choose_score(x_in_y, y_in_x) else {
                continue;
            };

            tile.identity[output] = encode_identity(ani);
            if let Some(signed) = direction.signed() {
                tile.direction[output] = encode_direction(signed);
            }
            tile.direction_support[output] =
                u16::try_from(direction.informative().min(u32::from(u16::MAX)))
                    .expect("support was clamped to u16::MAX");
        }
    }
    tile
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn encode_identity(ani: f64) -> u16 {
    // The clamp proves that the rounded value is in 0..=10_000.
    (ani.clamp(0.0, 1.0) * 10_000.0).round() as u16
}

#[allow(clippy::cast_possible_truncation)]
fn encode_direction(direction: f64) -> i16 {
    // DirectionEvidence::signed guarantees [-1, 1]. Clamp defensively at the storage
    // boundary so future estimators cannot overflow the fixed-point representation.
    (direction.clamp(-1.0, 1.0) * 32_767.0).round() as i16
}

fn choose_score(
    left: Option<ContainmentEstimate>,
    right: Option<ContainmentEstimate>,
) -> Option<(f64, DirectionEvidence)> {
    match (left, right) {
        (Some(left), Some(right)) => {
            let tolerance = 1e-12;
            if (left.containment - right.containment).abs() <= tolerance {
                Some((
                    left.ani.max(right.ani),
                    left.direction.combine(right.direction),
                ))
            } else if left.containment > right.containment {
                Some((left.ani, left.direction))
            } else {
                Some((right.ani, right.direction))
            }
        }
        (Some(value), None) | (None, Some(value)) => Some((value.ani, value.direction)),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_sequence_has_full_diagonal() {
        let sequence = PackedSequence::from_ascii("seq", &pseudo_random_sequence(20_000));
        let axis = build_axis_overview(&sequence, sequence.len(), 16, 15, 42, 256, 10);
        let tile = compute_tile(
            &axis,
            &axis,
            TileRequest {
                x_start: 0,
                y_start: 0,
                width: 16,
                height: 16,
                b_bits: 14,
                register_limit: 256,
                k: 15,
            },
        );
        for index in 0..16 {
            assert_eq!(tile.identity[index * 16 + index], 10_000);
            assert!(tile.direction[index * 16 + index] > 0);
        }
        for row in 0..16 {
            for column in 0..16 {
                assert_eq!(
                    tile.identity[row * 16 + column],
                    tile.identity[column * 16 + row]
                );
                assert_eq!(
                    tile.direction[row * 16 + column],
                    tile.direction[column * 16 + row]
                );
            }
        }
    }

    #[test]
    fn padded_axis_cells_are_missing() {
        let sequence = PackedSequence::from_ascii("short", &pseudo_random_sequence(5_000));
        let axis = build_axis_overview(&sequence, 10_000, 10, 15, 42, 128, 8);
        let tile = compute_tile(
            &axis,
            &axis,
            TileRequest {
                x_start: 0,
                y_start: 0,
                width: 10,
                height: 10,
                b_bits: 14,
                register_limit: 128,
                k: 15,
            },
        );
        assert_eq!(tile.identity[9 * 10 + 9], MISSING_IDENTITY);
    }

    #[test]
    fn optimized_tile_matches_scalar_reference() {
        let left = PackedSequence::from_ascii("left", &pseudo_random_sequence(30_000));
        let mut right_bases = pseudo_random_sequence(30_000);
        for index in (100..right_bases.len()).step_by(17) {
            right_bases[index] = b"ACGT"[(right_bases[index] as usize + 1) & 3];
        }
        let right = PackedSequence::from_ascii("right", &right_bases);
        let left_axis = build_axis_overview(&left, left.len(), 20, 15, 42, 256, 10);
        let right_axis = build_axis_overview(&right, right.len(), 20, 15, 42, 256, 10);
        let request = TileRequest {
            x_start: 0,
            y_start: 0,
            width: 20,
            height: 20,
            b_bits: 14,
            register_limit: 256,
            k: 15,
        };
        assert_eq!(
            compute_tile(&left_axis, &right_axis, request),
            compute_tile_reference(&left_axis, &right_axis, request)
        );
        assert_eq!(
            compute_tile(&left_axis, &right_axis, request),
            compute_tile_inverted(&left_axis, &right_axis, request)
        );
        assert_eq!(
            compute_tile(&left_axis, &left_axis, request),
            compute_tile_inverted(&left_axis, &left_axis, request)
        );
    }

    #[test]
    fn ranged_axis_matches_the_same_part_of_a_complete_axis() {
        let left = PackedSequence::from_ascii("left", &pseudo_random_sequence(50_003));
        let mut right_bases = pseudo_random_sequence(47_009);
        for index in (250..right_bases.len()).step_by(31) {
            right_bases[index] = b"ACGT"[(right_bases[index] as usize + 1) & 3];
        }
        let right = PackedSequence::from_ascii("right", &right_bases);
        let domain = left.len().max(right.len());
        let left_full = build_axis_overview(&left, domain, 97, 15, 42, 256, 10);
        let right_full = build_axis_overview(&right, domain, 97, 15, 42, 256, 10);
        let left_range = build_axis_range(&left, domain, 97, 23, 29, 15, 42, 256, 10);
        let right_range = build_axis_range(&right, domain, 97, 41, 27, 15, 42, 256, 10);
        let request = TileRequest {
            x_start: 23,
            y_start: 41,
            width: 29,
            height: 27,
            b_bits: 14,
            register_limit: 256,
            k: 15,
        };

        assert_eq!(
            compute_tile(&left_full, &right_full, request),
            compute_tile(&left_range, &right_range, request)
        );
        assert_eq!(&left_full.bounds[23..52], left_range.bounds);
        assert_eq!(&right_full.bounds[41..68], right_range.bounds);
    }

    #[test]
    fn adaptive_builder_retains_only_complete_bounded_core_sets() {
        let random = PackedSequence::from_ascii("random", &pseudo_random_sequence(20_000));
        let dense = build_axis_overview_adaptive_with_hash(
            &random,
            random.len(),
            4,
            15,
            42,
            256,
            10,
            HashAlgorithm::NtHash2,
            128,
        );
        assert!(dense.sparse_core.iter().all(Option::is_none));

        let repetitive = PackedSequence::from_ascii("repeat", &vec![b'A'; 20_000]);
        let sparse = build_axis_overview_adaptive_with_hash(
            &repetitive,
            repetitive.len(),
            4,
            15,
            42,
            256,
            10,
            HashAlgorithm::NtHash2,
            128,
        );
        assert_eq!(sparse.sparse_core.len(), 4);
        assert!(
            sparse
                .sparse_core
                .iter()
                .all(|core| core.as_ref().is_some_and(|hashes| hashes.len() == 1))
        );
    }

    #[test]
    fn ordinary_builder_does_not_allocate_sparse_sets() {
        let sequence = PackedSequence::from_ascii("seq", &pseudo_random_sequence(10_000));
        let axis = build_axis_overview(&sequence, sequence.len(), 10, 15, 42, 128, 8);
        assert!(axis.sparse_core.is_empty());
    }

    #[test]
    fn adaptive_tile_recovers_a_sparse_core_contained_in_a_large_target() {
        let x_bases = pseudo_random_sequence(1_000);
        let mut y_bases = x_bases.clone();
        y_bases.extend(pseudo_random_sequence(50_000));
        let x = PackedSequence::from_ascii("x", &x_bases);
        let y = PackedSequence::from_ascii("y", &y_bases);
        let domain = y.len();
        let x_axis = build_axis_overview_adaptive_with_hash(
            &x,
            domain,
            1,
            21,
            42,
            2_048,
            12,
            HashAlgorithm::NtHash2,
            2_048,
        );
        let y_axis = build_axis_overview_adaptive_with_hash(
            &y,
            domain,
            1,
            21,
            42,
            2_048,
            12,
            HashAlgorithm::NtHash2,
            2_048,
        );
        let tile = compute_tile_adaptive(
            &x_axis,
            &y_axis,
            &x,
            &y,
            HashAlgorithm::NtHash2,
            42,
            TileRequest {
                x_start: 0,
                y_start: 0,
                width: 1,
                height: 1,
                b_bits: 14,
                register_limit: 2_048,
                k: 21,
            },
            SparseCorrectionPolicy {
                ani_floor: 0.80,
                minimum_detection_probability: 0.99,
            },
        );
        assert_eq!(tile.identity, vec![10_000]);
        assert!(tile.direction[0] > 0);
    }

    fn pseudo_random_sequence(length: usize) -> Vec<u8> {
        let mut state = 0x243f_6a88_85a3_08d3_u64;
        let mut sequence = Vec::with_capacity(length);
        for _ in 0..length {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            sequence.push(b"ACGT"[(state & 3) as usize]);
        }
        sequence
    }
}
