//! Browser-independent scientific algorithms for moddotplot-interactive.
//!
//! Coordinates are zero-based and half-open throughout the core. The web interface
//! may present one-based inclusive labels, but conversions happen only at the UI
//! boundary. Expensive optimized algorithms have simple reference counterparts so
//! that scientific behavior can be tested differentially.

pub mod config;
pub mod containment;
pub mod dna;
pub mod fasta;
pub mod gc;
pub mod hash;
pub mod kmer;
mod matrix;
pub mod reference;
pub mod sketch;

#[cfg(feature = "validation")]
pub mod validation;

pub use config::{
    AniTransform, AxisExpansionPolicy, ConfigError, DEFAULT_B_BITS, DEFAULT_HLL_PRECISION,
    DEFAULT_IDENTITY_SCALE, DEFAULT_MISSING_IDENTITY, DEFAULT_VERIFICATION_BITS,
    SCIENTIFIC_CONFIG_VERSION, ScientificConfig, ScientificConfigIdentity,
};
pub use containment::{
    ContainmentEstimate, DirectionEvidence, estimate_containment, estimate_containment_bit_sliced,
    estimate_containment_from_comparison,
};
pub use dna::{CanonicalKmer, Orientation, PackedSequence, SequenceIdentity};
pub use fasta::{FastaError, FastaParser, MAX_SEQUENCE_LENGTH};
pub use gc::{CompositionIndex, CompositionIndexBuilder, DEFAULT_COMPOSITION_BLOCK_SIZE};
pub use kmer::{KmerTileGeometry, KmerTileRequest, compute_kmer_tile};
pub use matrix::{
    AxisOverview, FrozenAxis, MatrixBuildError, MatrixTile, TileBuildError, TileRequest,
    build_axis_overview, build_axis_range, compute_frozen_tile, compute_tile,
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
