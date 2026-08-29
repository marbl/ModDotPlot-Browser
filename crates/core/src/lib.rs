//! Browser-independent scientific algorithms for moddotplot-rs.
//!
//! Coordinates are zero-based and half-open throughout the core. The web interface
//! may present one-based inclusive labels, but conversions happen only at the UI
//! boundary. Expensive optimized algorithms have simple reference counterparts so
//! that scientific behavior can be tested differentially.

pub mod adaptive;
pub mod config;
pub mod containment;
pub mod dna;
pub mod fasta;
pub mod gc;
pub mod hash;
pub mod kmer;
pub mod matrix;
pub mod reference;
pub mod sketch;

pub use adaptive::{
    DEFAULT_ANI_FLOOR, DEFAULT_DETAILED_REGISTERS, DEFAULT_EXACT_CORE_CAP,
    DEFAULT_MATCH_DETECTION_PROBABILITY, DEFAULT_PREVIEW_REGISTERS,
    expected_matches_for_probability, expected_oph_matches, needs_exact_correction,
    probability_of_at_least_one_match,
};
pub use config::{
    AniTransform, AxisExpansionPolicy, ConfigError, DEFAULT_B_BITS, DEFAULT_HLL_PRECISION,
    DEFAULT_IDENTITY_SCALE, DEFAULT_MISSING_IDENTITY, DEFAULT_VERIFICATION_BITS,
    SCIENTIFIC_CONFIG_VERSION, ScientificConfig,
};
pub use containment::{
    ContainmentEstimate, DirectionEvidence, estimate_containment, estimate_containment_bit_sliced,
    estimate_containment_bit_sliced_with, estimate_containment_from_comparison,
    estimate_containment_from_comparison_with, estimate_containment_with,
};
pub use dna::{CanonicalKmer, Orientation, PackedSequence};
pub use fasta::{FastaError, FastaParser, MAX_SEQUENCE_LENGTH};
pub use gc::{CompositionIndex, CompositionIndexBuilder, DEFAULT_COMPOSITION_BLOCK_SIZE};
pub use kmer::{KmerTileRequest, compute_kmer_tile};
pub use matrix::{
    AxisOverview, FrozenAxis, MatrixBuildError, MatrixTile, SparseCoreHashSet,
    SparseCorrectionPolicy, TileBuildError, TileRequest, build_axis_overview, build_axis_range,
    compute_frozen_tile, compute_frozen_tile_adaptive, compute_tile, compute_tile_adaptive,
};
pub use reference::{ExactKmerSet, ExactSimilarity, exact_moddotplot_score};
pub use sketch::{
    BitSlicedSignature, HllSketch, OphJaccardEstimator, OphSketch, RegisterComparison,
    verified_winner_jaccard,
};

/// Default nucleotide k-mer length, matching current `ModDotPlot` behavior.
pub const DEFAULT_K: u8 = 21;

/// Production seed selecting the exact published ntHash2 stream.
///
/// Nonzero seeds are reserved for offline multi-layout statistical validation and
/// apply an additional avalanche; browser production always records zero.
pub const DEFAULT_HASH_SEED: u64 = 0;
