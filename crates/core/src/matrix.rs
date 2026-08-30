//! Axis summary construction and numeric matrix tiles.

mod axis;
mod frozen;
mod ordinary;
#[cfg(feature = "validation")]
use crate::validation::sparse;

use axis::divide_ceil;
#[cfg(feature = "validation")]
pub use sparse::SparseCorrectionPolicy;

use crate::config::ScientificConfig;
#[cfg(test)]
use crate::containment::estimate_containment_bit_sliced_scalar;
use crate::containment::{ContainmentEstimate, DirectionEvidence, estimate_containment_bit_sliced};
use crate::dna::{PackedSequence, SequenceIdentity};
#[cfg(feature = "validation")]
use crate::hash::HashAlgorithm;
use crate::hash::canonical_hashes;
use crate::sketch::{BitSlicedSignature, OphSketch};
#[cfg(feature = "validation")]
use crate::validation::adaptive::needs_exact_correction;
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
    /// Complete immutable scientific configuration used to build this axis.
    pub scientific_config: ScientificConfig,
    /// Stable identity of the complete source base stream.
    pub sequence_identity: SequenceIdentity,
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

    /// Discards mutable build sketches and retains only production tile data.
    pub fn freeze(self) -> FrozenAxis {
        FrozenAxis {
            scientific_config: self.scientific_config,
            sequence_identity: self.sequence_identity,
            sequence_name: self.sequence_name,
            sequence_length: self.sequence_length,
            domain_length: self.domain_length,
            resolution: self.resolution,
            offset: self.offset,
            bounds: self.bounds,
            core_encoded: self.core_encoded,
            expanded_encoded: self.expanded_encoded,
            sparse_core: self.sparse_core,
        }
    }
}

/// Immutable compact axis retained by the browser after sketch construction.
#[derive(Clone, Debug)]
pub struct FrozenAxis {
    /// FASTA record name.
    sequence_name: String,
    /// Stable identity of the complete source base stream.
    sequence_identity: SequenceIdentity,
    /// Complete immutable scientific configuration used to build this axis.
    scientific_config: ScientificConfig,
    /// Length of this sequence in bases.
    sequence_length: u64,
    /// Shared coordinate domain used by both selected axes.
    domain_length: u64,
    /// Logical number of intervals across the common domain.
    resolution: usize,
    /// First global interval represented by the vectors in this summary.
    offset: usize,
    /// Half-open, sequence-clipped interval bounds.
    bounds: Vec<(u64, u64)>,
    /// Word-parallel encodings of core intervals.
    core_encoded: Vec<BitSlicedSignature>,
    /// Word-parallel encodings of expanded intervals.
    expanded_encoded: Vec<BitSlicedSignature>,
    /// Complete hashes for cores retained by the optional sparse policy.
    sparse_core: Vec<Option<SparseCoreHashSet>>,
}

impl FrozenAxis {
    /// Complete scientific configuration from which this axis was built.
    pub const fn scientific_config(&self) -> ScientificConfig {
        self.scientific_config
    }

    /// Stable content identity of the complete source sequence.
    pub const fn sequence_identity(&self) -> SequenceIdentity {
        self.sequence_identity
    }

    /// FASTA record name.
    pub fn sequence_name(&self) -> &str {
        &self.sequence_name
    }

    /// Source sequence length in bases.
    pub const fn sequence_length(&self) -> u64 {
        self.sequence_length
    }

    /// Shared coordinate domain length.
    pub const fn domain_length(&self) -> u64 {
        self.domain_length
    }

    /// Logical number of intervals in the shared domain.
    pub const fn resolution(&self) -> usize {
        self.resolution
    }

    /// First global interval represented by this axis range.
    pub const fn offset(&self) -> usize {
        self.offset
    }

    /// Half-open, sequence-clipped interval bounds.
    pub fn bounds(&self) -> &[(u64, u64)] {
        &self.bounds
    }

    /// Word-parallel core signatures.
    pub fn core_encoded(&self) -> &[BitSlicedSignature] {
        &self.core_encoded
    }

    /// Word-parallel neighbor-expanded signatures.
    pub fn expanded_encoded(&self) -> &[BitSlicedSignature] {
        &self.expanded_encoded
    }

    /// Joins contiguous ranges produced from one source axis.
    ///
    /// # Errors
    ///
    /// Returns [`TileBuildError::IncompatibleAxes`] when any part has different
    /// scientific, sequence, coordinate, or layout provenance, or is not contiguous.
    pub fn join_contiguous(mut parts: Vec<Self>) -> Result<Self, TileBuildError> {
        let mut joined = parts
            .drain(..1)
            .next()
            .ok_or(TileBuildError::IncompatibleAxes)?;
        for mut part in parts {
            if !frozen::compatible_contiguous(&joined, &part) {
                return Err(TileBuildError::IncompatibleAxes);
            }
            joined.bounds.append(&mut part.bounds);
            joined.core_encoded.append(&mut part.core_encoded);
            joined.expanded_encoded.append(&mut part.expanded_encoded);
            joined.sparse_core.append(&mut part.sparse_core);
        }
        Ok(joined)
    }

    /// Approximate retained heap bytes, excluding allocator overhead.
    pub fn estimated_heap_bytes(&self) -> usize {
        self.sequence_name
            .capacity()
            .saturating_add(
                self.bounds
                    .capacity()
                    .saturating_mul(std::mem::size_of::<(u64, u64)>()),
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

pub(crate) trait AxisData {
    fn scientific_config(&self) -> ScientificConfig;
    #[cfg(feature = "validation")]
    fn sequence_name(&self) -> &str;
    #[cfg(feature = "validation")]
    fn sequence_identity(&self) -> SequenceIdentity;
    #[cfg(feature = "validation")]
    fn sequence_length(&self) -> u64;
    fn domain_length(&self) -> u64;
    fn resolution(&self) -> usize;
    fn offset(&self) -> usize;
    fn core_encoded(&self) -> &[BitSlicedSignature];
    fn expanded_encoded(&self) -> &[BitSlicedSignature];
    fn sparse_core(&self) -> &[Option<SparseCoreHashSet>];
}

impl AxisData for AxisOverview {
    fn scientific_config(&self) -> ScientificConfig {
        self.scientific_config
    }
    #[cfg(feature = "validation")]
    fn sequence_name(&self) -> &str {
        &self.sequence_name
    }
    #[cfg(feature = "validation")]
    fn sequence_identity(&self) -> SequenceIdentity {
        self.sequence_identity
    }
    #[cfg(feature = "validation")]
    fn sequence_length(&self) -> u64 {
        self.sequence_length
    }
    fn domain_length(&self) -> u64 {
        self.domain_length
    }
    fn resolution(&self) -> usize {
        self.resolution
    }
    fn offset(&self) -> usize {
        self.offset
    }
    fn core_encoded(&self) -> &[BitSlicedSignature] {
        &self.core_encoded
    }
    fn expanded_encoded(&self) -> &[BitSlicedSignature] {
        &self.expanded_encoded
    }
    fn sparse_core(&self) -> &[Option<SparseCoreHashSet>] {
        &self.sparse_core
    }
}

impl AxisData for FrozenAxis {
    fn scientific_config(&self) -> ScientificConfig {
        self.scientific_config
    }
    #[cfg(feature = "validation")]
    fn sequence_name(&self) -> &str {
        &self.sequence_name
    }
    #[cfg(feature = "validation")]
    fn sequence_identity(&self) -> SequenceIdentity {
        self.sequence_identity
    }
    #[cfg(feature = "validation")]
    fn sequence_length(&self) -> u64 {
        self.sequence_length
    }
    fn domain_length(&self) -> u64 {
        self.domain_length
    }
    fn resolution(&self) -> usize {
        self.resolution
    }
    fn offset(&self) -> usize {
        self.offset
    }
    fn core_encoded(&self) -> &[BitSlicedSignature] {
        &self.core_encoded
    }
    fn expanded_encoded(&self) -> &[BitSlicedSignature] {
        &self.expanded_encoded
    }
    fn sparse_core(&self) -> &[Option<SparseCoreHashSet>] {
        &self.sparse_core
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

/// Invalid coordinates rejected before any axis allocation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MatrixBuildError {
    /// The padded domain is empty or shorter than the sequence.
    Domain,
    /// The requested resolution is zero or cannot be represented safely.
    Resolution,
    /// The requested bin range is empty or starts beyond the resolution.
    Range,
}

impl std::fmt::Display for MatrixBuildError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Domain => "axis domain must be nonempty and cover the complete sequence",
            Self::Resolution => "axis resolution must be positive and safely representable",
            Self::Range => "axis bin range must be nonempty and begin inside the resolution",
        })
    }
}

impl std::error::Error for MatrixBuildError {}

/// Invalid tile request rejected before allocating output channels.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TileBuildError {
    /// The two axes do not describe compatible domains, layouts, or sketches.
    IncompatibleAxes,
    /// A source sequence does not match the axis from which it was built.
    IncompatibleSequence,
    /// K-mer, bit-width, or register parameters are unsupported.
    Parameters,
    /// Tile dimensions are zero or overflow addressable memory.
    Dimensions,
    /// The requested origin lies outside one of the represented axis ranges.
    Range,
}

impl std::fmt::Display for TileBuildError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::IncompatibleAxes => "tile axes have incompatible domains or sketch layouts",
            Self::IncompatibleSequence => "tile source sequence does not match its prepared axis",
            Self::Parameters => "tile k-mer, bit-width, or register parameters are invalid",
            Self::Dimensions => "tile dimensions must be positive and safely representable",
            Self::Range => "tile origin lies outside the represented axis range",
        })
    }
}

impl std::error::Error for TileBuildError {}

/// Builds aligned core and half-window-expanded sketches in one k-mer scan.
///
/// # Errors
///
/// Returns [`MatrixBuildError`] when the domain or resolution is invalid.
pub fn build_axis_overview(
    sequence: &PackedSequence,
    domain_length: u64,
    resolution: usize,
    config: ScientificConfig,
) -> Result<AxisOverview, MatrixBuildError> {
    build_axis_range(sequence, domain_length, resolution, 0, resolution, config)
}

/// Builds sketches for a contiguous range of intervals at an arbitrary resolution.
///
/// Only the half-bin segments needed by `[bin_start, bin_start + bin_count)` and
/// its containment halo are scanned and retained. The result is therefore suitable
/// for demand-driven zoom tiles without allocating an entire high-resolution axis.
///
/// # Errors
///
/// Returns [`MatrixBuildError`] when the domain, resolution, or bin range is invalid.
///
pub fn build_axis_range(
    sequence: &PackedSequence,
    domain_length: u64,
    resolution: usize,
    bin_start: usize,
    bin_count: usize,
    config: ScientificConfig,
) -> Result<AxisOverview, MatrixBuildError> {
    axis::validate_request(
        sequence.len(),
        domain_length,
        resolution,
        bin_start,
        bin_count,
    )?;
    Ok(build_axis_range_internal(
        sequence,
        domain_length,
        resolution,
        bin_start,
        bin_count,
        config,
    ))
}

fn build_axis_range_internal(
    sequence: &PackedSequence,
    domain_length: u64,
    resolution: usize,
    bin_start: usize,
    bin_count: usize,
    config: ScientificConfig,
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
    let register_count = config.register_count();
    let sparse_cap = (config.sparse_core_cap() > 0).then_some(config.sparse_core_cap());
    let empty = OphSketch::new(register_count, config.hll_precision());
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
        config.k(),
        genomic_start,
        genomic_end,
        config.hash_algorithm(),
        config.hash_seed(),
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
        scientific_config: config,
        sequence_identity: sequence.identity(),
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

/// Computes a clipped matrix tile using `ModDotPlot`'s maximum directed containment.
///
/// # Errors
///
/// Returns [`TileBuildError`] before allocation when axes or request fields are invalid.
pub fn compute_tile(
    x: &AxisOverview,
    y: &AxisOverview,
    request: TileRequest,
) -> Result<MatrixTile, TileBuildError> {
    compute_encoded_tile(x, y, request, std::ptr::eq(x, y))
}

/// Computes a tile from the compact immutable representation retained by production.
///
/// # Errors
///
/// Returns [`TileBuildError`] before allocation when axes or request fields are invalid.
pub fn compute_frozen_tile(
    x: &FrozenAxis,
    y: &FrozenAxis,
    request: TileRequest,
) -> Result<MatrixTile, TileBuildError> {
    compute_encoded_tile(x, y, request, std::ptr::eq(x, y))
}

fn compute_encoded_tile<A: AxisData>(
    x: &A,
    y: &A,
    request: TileRequest,
    is_self_axis: bool,
) -> Result<MatrixTile, TileBuildError> {
    let layout = ordinary::validate(x, y, request)?;
    let config = x.scientific_config();
    let (width, height, cells) = (layout.width, layout.height, layout.cells);
    let mut tile = MatrixTile {
        width,
        height,
        identity: vec![MISSING_IDENTITY; cells],
        direction: vec![0; cells],
        direction_support: vec![0; cells],
    };
    let mirror_within_tile = is_self_axis && request.x_start == request.y_start && width == height;
    for row in 0..height {
        let y_index = request.y_start + row;
        let y_local = y_index - y.offset();
        for column in 0..width {
            let x_index = request.x_start + column;
            let x_local = x_index - x.offset();
            let output = row * width + column;
            if mirror_within_tile && column < row {
                let transpose = column * width + row;
                tile.identity[output] = tile.identity[transpose];
                tile.direction[output] = tile.direction[transpose];
                tile.direction_support[output] = tile.direction_support[transpose];
                continue;
            }
            if x.core_encoded()[x_local].observations() == 0
                || y.core_encoded()[y_local].observations() == 0
            {
                continue;
            }
            if is_self_axis && x_index == y_index {
                tile.identity[output] = 10_000;
                tile.direction[output] = i16::MAX;
                tile.direction_support[output] = 1;
                continue;
            }
            let left = estimate_containment_bit_sliced(
                &x.core_encoded()[x_local],
                &y.expanded_encoded()[y_local],
                config.k(),
                config.b_bits(),
                config.register_count(),
            );
            let right = estimate_containment_bit_sliced(
                &y.core_encoded()[y_local],
                &x.expanded_encoded()[x_local],
                config.k(),
                config.b_bits(),
                config.register_count(),
            );
            let Some((ani, direction)) = choose_score(left, right) else {
                continue;
            };
            tile.identity[output] = encode_identity(ani);
            tile.direction[output] = direction.signed().map_or(0, encode_direction);
            tile.direction_support[output] =
                u16::try_from(direction.informative().min(u32::from(u16::MAX))).unwrap_or(u16::MAX);
        }
    }
    Ok(tile)
}

/// Computes a tile and exactly corrects only statistically underpowered sparse directions.
///
/// The ordinary OPH estimate is produced first. Complete core hash sets retained by the
/// adaptive builder are considered for correction only when the probability model predicts
/// insufficient match detection at `policy.ani_floor`. Target sequence hashes are streamed
/// only across the requested tile range and shared across all eligible query cores.
///
/// # Errors
///
/// Returns [`TileBuildError`] before allocation when axes, source sequences, or request
/// fields are incompatible.
#[allow(clippy::too_many_arguments)]
#[cfg(feature = "validation")]
pub fn compute_tile_adaptive(
    x: &AxisOverview,
    y: &AxisOverview,
    x_sequence: &PackedSequence,
    y_sequence: &PackedSequence,
    hash_algorithm: HashAlgorithm,
    seed: u64,
    request: TileRequest,
    policy: SparseCorrectionPolicy,
) -> Result<MatrixTile, TileBuildError> {
    sparse::validate_source_sequences(x, y, x_sequence, y_sequence)?;
    let mut tile = compute_tile(x, y, request)?;
    let config = x.scientific_config;
    if x.sparse_core.is_empty() && y.sparse_core.is_empty() {
        return Ok(tile);
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
                    config.k(),
                    config.b_bits(),
                    config.register_count(),
                )
                .map(DirectedScore::from)
            });
            let right = y_exact[output].or_else(|| {
                estimate_containment_bit_sliced(
                    &y.core_encoded[y_local],
                    &x.expanded_encoded[x_local],
                    config.k(),
                    config.b_bits(),
                    config.register_count(),
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
                    .unwrap_or(u16::MAX);
        }
    }
    Ok(tile)
}

/// Computes a compact production tile with optional sparse exact correction.
///
/// # Errors
///
/// Returns [`TileBuildError`] before allocation when axes, source sequences, or request
/// fields are incompatible.
#[allow(clippy::too_many_arguments)]
#[cfg(feature = "validation")]
pub fn compute_frozen_tile_adaptive(
    x: &FrozenAxis,
    y: &FrozenAxis,
    x_sequence: &PackedSequence,
    y_sequence: &PackedSequence,
    hash_algorithm: HashAlgorithm,
    seed: u64,
    request: TileRequest,
    policy: SparseCorrectionPolicy,
) -> Result<MatrixTile, TileBuildError> {
    sparse::validate_source_sequences(x, y, x_sequence, y_sequence)?;
    let mut tile = compute_frozen_tile(x, y, request)?;
    let config = x.scientific_config;
    if x.sparse_core.is_empty() && y.sparse_core.is_empty() {
        return Ok(tile);
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
                    config.k(),
                    config.b_bits(),
                    config.register_count(),
                )
                .map(DirectedScore::from)
            });
            let right = y_exact[output].or_else(|| {
                estimate_containment_bit_sliced(
                    &y.core_encoded[y_local],
                    &x.expanded_encoded[x_local],
                    config.k(),
                    config.b_bits(),
                    config.register_count(),
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
                    .unwrap_or(u16::MAX);
        }
    }
    Ok(tile)
}

#[derive(Clone, Copy, Debug)]
#[cfg(feature = "validation")]
struct DirectedScore {
    containment: f64,
    ani: f64,
    direction: DirectionEvidence,
}

#[cfg(feature = "validation")]
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
#[cfg(feature = "validation")]
fn exact_sparse_tile_direction(
    query: &impl AxisData,
    target: &impl AxisData,
    target_sequence: &PackedSequence,
    hash_algorithm: HashAlgorithm,
    seed: u64,
    request: TileRequest,
    policy: SparseCorrectionPolicy,
    query_is_x: bool,
) -> Vec<Option<DirectedScore>> {
    let query_end = query.offset() + query.core_encoded().len();
    let target_end = target.offset() + target.core_encoded().len();
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
    if query_count == 0 || target_count == 0 || query.sparse_core().is_empty() {
        return scores;
    }

    let mut corrections = vec![false; query_count.saturating_mul(target_count)];
    let mut postings = HashMap::<u64, Vec<(usize, crate::dna::Orientation)>>::new();
    for query_offset in 0..query_count {
        let query_local = query_start + query_offset - query.offset();
        let Some(core) = query
            .sparse_core()
            .get(query_local)
            .and_then(Option::as_ref)
        else {
            continue;
        };
        let mut eligible = false;
        for target_offset in 0..target_count {
            let target_local = target_start + target_offset - target.offset();
            let correct = needs_exact_correction(
                core.len(),
                target.expanded_encoded()[target_local].estimated_cardinality(),
                query.scientific_config().register_count(),
                query.scientific_config().k(),
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
    let half_count = target.resolution() * 2;
    let first_half = (2 * target_start).saturating_sub(1);
    let end_half = (2 * (target_start + target_count) + 1).min(half_count);
    let genomic_start = divide_ceil(
        first_half as u128 * u128::from(target.domain_length()),
        half_count,
    );
    let genomic_end = divide_ceil(
        end_half as u128 * u128::from(target.domain_length()),
        half_count,
    );
    for item in canonical_hashes(
        target_sequence,
        query.scientific_config().k(),
        genomic_start,
        genomic_end,
        hash_algorithm,
        seed,
    ) {
        let Some(query_id) = index.get(item.hash) else {
            continue;
        };
        let half = ((u128::from(item.start) * half_count as u128)
            / u128::from(target.domain_length())) as usize;
        let (first, last) = expanded_target_cells(half, target.resolution());
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
        let query_local = query_start + query_offset - query.offset();
        let Some(denominator) = query.sparse_core()[query_local]
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
                    containment.powf(1.0 / f64::from(query.scientific_config().k()))
                },
                direction: direction[output],
            });
        }
    }
    scores
}

#[cfg(feature = "validation")]
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

#[cfg(feature = "validation")]
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

#[cfg(feature = "validation")]
fn choose_directed_score(
    left: Option<DirectedScore>,
    right: Option<DirectedScore>,
) -> Option<DirectedScore> {
    match (left, right) {
        (Some(left), Some(right)) => Some(DirectedScore {
            containment: left.containment.max(right.containment),
            ani: left.ani.max(right.ani),
            direction: left.direction.combine(right.direction),
        }),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

/// Minimal open-addressing index for a set of already uniform 64-bit hashes.
#[cfg(feature = "validation")]
struct PrehashedQueryIndex {
    keys: Vec<u64>,
    values: Vec<usize>,
    occupied: Vec<bool>,
    mask: usize,
    index_shift: u32,
}

#[cfg(feature = "validation")]
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
#[cfg(test)]
fn compute_tile_reference(x: &AxisOverview, y: &AxisOverview, request: TileRequest) -> MatrixTile {
    compute_tile_impl(x, y, request, false)
}

#[cfg(test)]
#[allow(clippy::too_many_lines)]
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
    let config = x.scientific_config;
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

            #[cfg(test)]
            let (x_in_y, y_in_x) = if use_bit_sliced {
                (
                    estimate_containment_bit_sliced(
                        &x.core_encoded[x_local],
                        &y.expanded_encoded[y_local],
                        config.k(),
                        config.b_bits(),
                        config.register_count(),
                    ),
                    estimate_containment_bit_sliced(
                        &y.core_encoded[y_local],
                        &x.expanded_encoded[x_local],
                        config.k(),
                        config.b_bits(),
                        config.register_count(),
                    ),
                )
            } else {
                (
                    estimate_containment_bit_sliced_scalar(
                        &x.core_encoded[x_local],
                        &y.expanded_encoded[y_local],
                        config.k(),
                        config.b_bits(),
                        config.register_count(),
                    ),
                    estimate_containment_bit_sliced_scalar(
                        &y.core_encoded[y_local],
                        &x.expanded_encoded[x_local],
                        config.k(),
                        config.b_bits(),
                        config.register_count(),
                    ),
                )
            };
            #[cfg(not(test))]
            let (x_in_y, y_in_x) = {
                debug_assert!(use_bit_sliced);
                (
                    estimate_containment_bit_sliced(
                        &x.core_encoded[x_local],
                        &y.expanded_encoded[y_local],
                        config.k(),
                        config.b_bits(),
                        config.register_count(),
                    ),
                    estimate_containment_bit_sliced(
                        &y.core_encoded[y_local],
                        &x.expanded_encoded[x_local],
                        config.k(),
                        config.b_bits(),
                        config.register_count(),
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
                u16::try_from(direction.informative().min(u32::from(u16::MAX))).unwrap_or(u16::MAX);
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
        (Some(left), Some(right)) => Some((
            left.ani.max(right.ani),
            left.direction.combine(right.direction),
        )),
        (Some(value), None) | (None, Some(value)) => Some((value.ani, value.direction)),
        (None, None) => None,
    }
}

#[cfg(test)]
#[allow(deprecated)]
mod tests {
    use super::*;

    fn config(k: u8, registers: usize, hll_precision: u8, sparse: bool) -> ScientificConfig {
        ScientificConfig::production(k, registers, hll_precision, sparse).unwrap()
    }

    #[test]
    fn identical_sequence_has_full_diagonal() {
        let sequence = PackedSequence::from_ascii("seq", &pseudo_random_sequence(20_000));
        let axis =
            build_axis_overview(&sequence, sequence.len(), 16, config(15, 256, 10, false)).unwrap();
        let tile = compute_tile(
            &axis,
            &axis,
            TileRequest {
                x_start: 0,
                y_start: 0,
                width: 16,
                height: 16,
            },
        )
        .unwrap();
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
        let axis = build_axis_overview(&sequence, 10_000, 10, config(15, 128, 8, false)).unwrap();
        let tile = compute_tile(
            &axis,
            &axis,
            TileRequest {
                x_start: 0,
                y_start: 0,
                width: 10,
                height: 10,
            },
        )
        .unwrap();
        assert_eq!(tile.identity[9 * 10 + 9], MISSING_IDENTITY);
    }

    #[test]
    fn invalid_tile_requests_fail_before_output_allocation() {
        let sequence = PackedSequence::from_ascii("sequence", &pseudo_random_sequence(5_000));
        let axis =
            build_axis_overview(&sequence, sequence.len(), 4, config(15, 128, 8, false)).unwrap();
        let request = TileRequest {
            x_start: 0,
            y_start: 0,
            width: 0,
            height: usize::MAX,
        };
        assert_eq!(
            compute_tile(&axis, &axis, request),
            Err(TileBuildError::Dimensions)
        );

        let incompatible =
            build_axis_overview(&sequence, sequence.len(), 4, config(15, 256, 8, false)).unwrap();
        assert_eq!(
            compute_tile(
                &axis,
                &incompatible,
                TileRequest {
                    width: 1,
                    height: 1,
                    ..request
                }
            ),
            Err(TileBuildError::IncompatibleAxes)
        );

        let different_k =
            build_axis_overview(&sequence, sequence.len(), 4, config(17, 128, 8, false)).unwrap();
        assert_eq!(
            compute_tile(
                &axis,
                &different_k,
                TileRequest {
                    width: 1,
                    height: 1,
                    ..request
                }
            ),
            Err(TileBuildError::IncompatibleAxes)
        );
    }

    #[test]
    fn frozen_ranges_own_and_validate_scientific_and_sequence_provenance() {
        let bases = pseudo_random_sequence(20_000);
        let sequence = PackedSequence::from_ascii("source", &bases);
        let scientific = config(15, 128, 8, false);
        let first = build_axis_range(&sequence, sequence.len(), 8, 0, 4, scientific)
            .unwrap()
            .freeze();
        let second = build_axis_range(&sequence, sequence.len(), 8, 4, 4, scientific)
            .unwrap()
            .freeze();
        let joined = FrozenAxis::join_contiguous(vec![first.clone(), second]).unwrap();
        assert_eq!(joined.scientific_config().identity(), scientific.identity());
        assert_eq!(joined.sequence_identity(), sequence.identity());
        assert_eq!(joined.sequence_name(), sequence.name());
        assert_eq!(joined.offset(), 0);
        assert_eq!(joined.core_encoded().len(), 8);

        let different_bases = pseudo_random_sequence(20_001)[1..].to_vec();
        let different = PackedSequence::from_ascii("source", &different_bases);
        let incompatible = build_axis_range(&different, different.len(), 8, 4, 4, scientific)
            .unwrap()
            .freeze();
        assert!(matches!(
            FrozenAxis::join_contiguous(vec![first, incompatible]),
            Err(TileBuildError::IncompatibleAxes)
        ));
    }

    #[test]
    fn optimized_tile_matches_scalar_reference() {
        let left = PackedSequence::from_ascii("left", &pseudo_random_sequence(30_000));
        let mut right_bases = pseudo_random_sequence(30_000);
        for index in (100..right_bases.len()).step_by(17) {
            right_bases[index] = b"ACGT"[(right_bases[index] as usize + 1) & 3];
        }
        let right = PackedSequence::from_ascii("right", &right_bases);
        let scientific = config(15, 256, 10, false);
        let left_axis = build_axis_overview(&left, left.len(), 20, scientific).unwrap();
        let right_axis = build_axis_overview(&right, right.len(), 20, scientific).unwrap();
        let request = TileRequest {
            x_start: 0,
            y_start: 0,
            width: 20,
            height: 20,
        };
        assert_eq!(
            compute_tile(&left_axis, &right_axis, request).unwrap(),
            compute_tile_reference(&left_axis, &right_axis, request)
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
        let scientific = config(15, 256, 10, false);
        let left_full = build_axis_overview(&left, domain, 97, scientific).unwrap();
        let right_full = build_axis_overview(&right, domain, 97, scientific).unwrap();
        let left_range = build_axis_range(&left, domain, 97, 23, 29, scientific).unwrap();
        let right_range = build_axis_range(&right, domain, 97, 41, 27, scientific).unwrap();
        let request = TileRequest {
            x_start: 23,
            y_start: 41,
            width: 29,
            height: 27,
        };

        assert_eq!(
            compute_tile(&left_full, &right_full, request),
            compute_tile(&left_range, &right_range, request)
        );
        assert_eq!(&left_full.bounds[23..52], left_range.bounds);
        assert_eq!(&right_full.bounds[41..68], right_range.bounds);
    }

    #[test]
    #[cfg(feature = "validation")]
    fn adaptive_builder_retains_only_complete_bounded_core_sets() {
        let random = PackedSequence::from_ascii("random", &pseudo_random_sequence(20_000));
        let dense =
            build_axis_overview(&random, random.len(), 4, config(15, 256, 10, true)).unwrap();
        assert!(dense.sparse_core.iter().all(Option::is_none));

        let repetitive = PackedSequence::from_ascii("repeat", &vec![b'A'; 20_000]);
        let sparse =
            build_axis_overview(&repetitive, repetitive.len(), 4, config(15, 256, 10, true))
                .unwrap();
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
        let axis =
            build_axis_overview(&sequence, sequence.len(), 10, config(15, 128, 8, false)).unwrap();
        assert!(axis.sparse_core.is_empty());
    }

    #[test]
    #[cfg(feature = "validation")]
    fn adaptive_tile_recovers_a_sparse_core_contained_in_a_large_target() {
        let x_bases = pseudo_random_sequence(1_000);
        let mut y_bases = x_bases.clone();
        y_bases.extend(pseudo_random_sequence(50_000));
        let x = PackedSequence::from_ascii("x", &x_bases);
        let y = PackedSequence::from_ascii("y", &y_bases);
        let domain = y.len();
        let scientific = config(21, 2_048, 12, true);
        let x_axis = build_axis_overview(&x, domain, 1, scientific).unwrap();
        let y_axis = build_axis_overview(&y, domain, 1, scientific).unwrap();
        let tile = compute_tile_adaptive(
            &x_axis,
            &y_axis,
            &x,
            &y,
            HashAlgorithm::NtHash2,
            0,
            TileRequest {
                x_start: 0,
                y_start: 0,
                width: 1,
                height: 1,
            },
            SparseCorrectionPolicy {
                ani_floor: 0.80,
                minimum_detection_probability: 0.99,
            },
        )
        .unwrap();
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
