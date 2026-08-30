//! Non-default research estimators, projections, and correction kernels.
//!
//! Nothing in this namespace is linked into ordinary production builds. These APIs
//! exist only for controlled comparisons against the fixed browser estimator.

pub mod adaptive;
mod estimators;
mod projection;
pub(crate) mod sparse;

pub use crate::matrix::{
    SparseCoreHashSet, SparseCorrectionPolicy, compute_frozen_tile_adaptive, compute_tile_adaptive,
};
pub use crate::sketch::OphJaccardEstimator;
pub use adaptive::{
    DEFAULT_ANI_FLOOR, DEFAULT_DETAILED_REGISTERS, DEFAULT_EXACT_CORE_CAP,
    DEFAULT_MATCH_DETECTION_PROBABILITY, DEFAULT_PREVIEW_REGISTERS,
    expected_matches_for_probability, expected_oph_matches, needs_exact_correction,
    probability_of_at_least_one_match,
};
pub use estimators::{
    estimate_containment_bit_sliced_with, estimate_containment_from_comparison_with,
    estimate_containment_with,
};
