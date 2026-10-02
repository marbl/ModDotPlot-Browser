//! Candidate estimator kernels retained only for controlled scientific comparison.

use crate::containment::{ContainmentEstimate, estimate_from_comparison};
use crate::sketch::{
    BitSlicedSignature, OphJaccardEstimator, OphSketch, RegisterComparison, verified_winner_jaccard,
};

/// Estimates directed containment with an explicit OPH resemblance statistic.
pub fn estimate_containment_with(
    x: &OphSketch,
    y: &OphSketch,
    k: u8,
    b: u8,
    register_limit: usize,
    estimator: OphJaccardEstimator,
) -> Option<ContainmentEstimate> {
    let mut registers = x.compare_bbit(y, b, register_limit);
    registers.jaccard = select_jaccard(registers, b, estimator);
    estimate_from_comparison(
        x.estimated_cardinality(),
        y.estimated_cardinality(),
        k,
        registers,
    )
}

/// Estimates directed containment from word-parallel signatures and an explicit statistic.
pub fn estimate_containment_bit_sliced_with(
    x: &BitSlicedSignature,
    y: &BitSlicedSignature,
    k: u8,
    b: u8,
    register_limit: usize,
    estimator: OphJaccardEstimator,
) -> Option<ContainmentEstimate> {
    let mut registers = x.compare(y, b, register_limit);
    registers.jaccard = select_jaccard(registers, b, estimator);
    estimate_from_comparison(
        x.estimated_cardinality(),
        y.estimated_cardinality(),
        k,
        registers,
    )
}

/// Estimates containment from externally accumulated counters and an explicit statistic.
pub fn estimate_containment_from_comparison_with(
    x_cardinality: f64,
    y_cardinality: f64,
    k: u8,
    b: u8,
    mut registers: RegisterComparison,
    estimator: OphJaccardEstimator,
) -> Option<ContainmentEstimate> {
    registers.jaccard = select_jaccard(registers, b, estimator);
    estimate_from_comparison(x_cardinality, y_cardinality, k, registers)
}

fn select_jaccard(
    registers: RegisterComparison,
    b: u8,
    estimator: OphJaccardEstimator,
) -> Option<f64> {
    match estimator {
        OphJaccardEstimator::BbitCollisionCorrected => collision_corrected_jaccard(
            registers.bbit_matches,
            registers.verified_matches,
            registers.considered,
            b,
        ),
        OphJaccardEstimator::VerifiedWinners => {
            verified_winner_jaccard(registers.verified_matches, registers.considered)
        }
    }
}

fn collision_corrected_jaccard(
    matches: u32,
    verified_matches: u32,
    considered: u32,
    b: u8,
) -> Option<f64> {
    if considered == 0 {
        return None;
    }
    if verified_matches == 0 {
        return Some(0.0);
    }
    let raw = f64::from(matches) / f64::from(considered);
    let collision = 2_f64.powi(-i32::from(b));
    Some(((raw - collision) / (1.0 - collision)).clamp(0.0, 1.0))
}
