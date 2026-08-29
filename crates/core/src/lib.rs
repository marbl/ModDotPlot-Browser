//! Browser-independent scientific algorithms for moddotplot-rs.
//!
//! Coordinates are zero-based and half-open throughout the core. The web interface
//! may present one-based inclusive labels, but conversions happen only at the UI
//! boundary. Expensive optimized algorithms have simple reference counterparts so
//! that scientific behavior can be tested differentially.

pub mod adaptive;
pub mod base;
pub mod containment;
pub mod dna;
pub mod fasta;
pub mod hash;
pub mod kmer;
pub mod matrix;
pub mod minmer;
pub mod reference;
pub mod sketch;

pub use adaptive::{
    DEFAULT_ANI_FLOOR, DEFAULT_DETAILED_REGISTERS, DEFAULT_EXACT_CORE_CAP,
    DEFAULT_MATCH_DETECTION_PROBABILITY, DEFAULT_PREVIEW_REGISTERS,
    expected_matches_for_probability, expected_oph_matches, needs_exact_correction,
    probability_of_at_least_one_match,
};
pub use containment::{
    ContainmentEstimate, DirectionEvidence, estimate_containment, estimate_containment_bit_sliced,
    estimate_containment_from_comparison,
};
pub use dna::{CanonicalKmer, Orientation, PackedSequence};
pub use fasta::{FastaError, FastaParser, MAX_SEQUENCE_LENGTH};
pub use kmer::{KmerTileRequest, compute_kmer_tile};
pub use matrix::{
    AxisOverview, MatrixTile, SparseCoreHashSet, SparseCorrectionPolicy, TileRequest,
    build_axis_overview, build_axis_overview_adaptive_with_hash, build_axis_overview_with_hash,
    build_axis_range, build_axis_range_adaptive_with_hash, build_axis_range_with_hash,
    compute_tile, compute_tile_adaptive, compute_tile_inverted, compute_tile_reference,
};
pub use minmer::{
    BottomSContainment, BottomSItem, MinmerIndex, MinmerInterval, bottom_s, build_minmer_index,
    estimate_bottom_s_containment, mashmap_bottom_s_range, reference_window_minmers,
};
pub use reference::{ExactHashSet, ExactSimilarity, exact_moddotplot_score};
pub use sketch::{BitSlicedSignature, HllSketch, OphSketch, RegisterComparison};

/// Default nucleotide k-mer length, matching current `ModDotPlot` behavior.
pub const DEFAULT_K: u8 = 21;

/// Fixed public seed used by the optimized rolling-hash backend.
pub const DEFAULT_HASH_SEED: u64 = 42;
pub use base::{BaseTileRequest, compute_base_tile};
