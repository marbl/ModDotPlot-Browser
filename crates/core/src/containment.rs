//! Directed containment and orientation estimation.

use crate::sketch::{
    BitSlicedSignature, OphJaccardEstimator, OphSketch, RegisterComparison, verified_winner_jaccard,
};

/// Directional support derived only from complete-hash register matches.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DirectionEvidence {
    /// Matches supporting the same relative orientation.
    pub forward: u32,
    /// Matches supporting reverse-complement orientation.
    pub reverse: u32,
    /// Matches without an unambiguous direction.
    pub ambiguous: u32,
}

impl DirectionEvidence {
    /// Total unambiguous support.
    pub fn informative(self) -> u32 {
        self.forward + self.reverse
    }

    /// Signed direction in `[-1, 1]`, or `None` without informative support.
    pub fn signed(self) -> Option<f64> {
        let total = self.informative();
        (total > 0).then(|| (f64::from(self.forward) - f64::from(self.reverse)) / f64::from(total))
    }

    /// Adds independently sampled evidence.
    #[must_use]
    pub fn combine(self, other: Self) -> Self {
        Self {
            forward: self.forward.saturating_add(other.forward),
            reverse: self.reverse.saturating_add(other.reverse),
            ambiguous: self.ambiguous.saturating_add(other.ambiguous),
        }
    }
}

/// One directed containment estimate `|X ∩ Y| / |X|`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContainmentEstimate {
    /// Collision-corrected Jaccard estimate.
    pub jaccard: f64,
    /// Directed containment of the first sketch in the second.
    pub containment: f64,
    /// ANI-like transform `containment^(1/k)`.
    pub ani: f64,
    /// Full-hash directional evidence.
    pub direction: DirectionEvidence,
    /// Register comparison counters for diagnostics and validation.
    pub registers: RegisterComparison,
}

/// Estimates directed containment of `x` in `y`.
///
/// Jaccard is converted using estimated distinct cardinalities:
/// `intersection = J * (|X| + |Y|) / (1 + J)`.
pub fn estimate_containment(
    x: &OphSketch,
    y: &OphSketch,
    k: u8,
    b: u8,
    register_limit: usize,
) -> Option<ContainmentEstimate> {
    estimate_containment_with(
        x,
        y,
        k,
        b,
        register_limit,
        OphJaccardEstimator::VerifiedWinners,
    )
}

/// Estimates directed containment with an explicit OPH resemblance statistic.
pub fn estimate_containment_with(
    x: &OphSketch,
    y: &OphSketch,
    k: u8,
    b: u8,
    register_limit: usize,
    estimator: OphJaccardEstimator,
) -> Option<ContainmentEstimate> {
    let x_cardinality = x.estimated_cardinality();
    let y_cardinality = y.estimated_cardinality();
    let registers = x.compare_bbit(y, b, register_limit);
    let mut registers = registers;
    registers.jaccard = match estimator {
        OphJaccardEstimator::BbitCollisionCorrected => registers.jaccard,
        OphJaccardEstimator::VerifiedWinners => {
            verified_winner_jaccard(registers.verified_matches, registers.considered)
        }
    };
    estimate_from_comparison(x_cardinality, y_cardinality, k, registers)
}

/// Estimates directed containment from word-parallel bit-sliced signatures.
#[inline]
pub fn estimate_containment_bit_sliced(
    x: &BitSlicedSignature,
    y: &BitSlicedSignature,
    k: u8,
    b: u8,
    register_limit: usize,
) -> Option<ContainmentEstimate> {
    estimate_containment_bit_sliced_with(
        x,
        y,
        k,
        b,
        register_limit,
        OphJaccardEstimator::VerifiedWinners,
    )
}

/// Estimates directed containment using an explicit OPH resemblance statistic.
#[inline]
pub fn estimate_containment_bit_sliced_with(
    x: &BitSlicedSignature,
    y: &BitSlicedSignature,
    k: u8,
    b: u8,
    register_limit: usize,
    estimator: OphJaccardEstimator,
) -> Option<ContainmentEstimate> {
    let registers = x.compare(y, b, register_limit);
    let mut registers = registers;
    registers.jaccard = match estimator {
        OphJaccardEstimator::BbitCollisionCorrected => registers.jaccard,
        OphJaccardEstimator::VerifiedWinners => {
            verified_winner_jaccard(registers.verified_matches, registers.considered)
        }
    };
    estimate_from_comparison(
        x.estimated_cardinality(),
        y.estimated_cardinality(),
        k,
        registers,
    )
}

/// Test-only scalar interpretation of a frozen bit-sliced signature.
#[cfg(test)]
pub(crate) fn estimate_containment_bit_sliced_scalar(
    x: &BitSlicedSignature,
    y: &BitSlicedSignature,
    k: u8,
    b: u8,
    register_limit: usize,
) -> Option<ContainmentEstimate> {
    estimate_from_comparison(
        x.estimated_cardinality(),
        y.estimated_cardinality(),
        k,
        x.compare_scalar(y, b, register_limit),
    )
}

/// Estimates containment from externally accumulated aligned-register counters.
///
/// This is used by sparse all-pairs kernels that invert b-bit winners by register
/// instead of comparing every signature pair independently.
pub fn estimate_containment_from_comparison(
    x_cardinality: f64,
    y_cardinality: f64,
    k: u8,
    b: u8,
    registers: RegisterComparison,
) -> Option<ContainmentEstimate> {
    estimate_containment_from_comparison_with(
        x_cardinality,
        y_cardinality,
        k,
        b,
        registers,
        OphJaccardEstimator::VerifiedWinners,
    )
}

/// Estimates containment from counters using an explicit OPH resemblance statistic.
pub fn estimate_containment_from_comparison_with(
    x_cardinality: f64,
    y_cardinality: f64,
    k: u8,
    b: u8,
    mut registers: RegisterComparison,
    estimator: OphJaccardEstimator,
) -> Option<ContainmentEstimate> {
    registers.jaccard = match estimator {
        OphJaccardEstimator::BbitCollisionCorrected => crate::sketch::collision_corrected_jaccard(
            registers.bbit_matches,
            registers.verified_matches,
            registers.considered,
            b,
        ),
        OphJaccardEstimator::VerifiedWinners => {
            verified_winner_jaccard(registers.verified_matches, registers.considered)
        }
    };
    estimate_from_comparison(x_cardinality, y_cardinality, k, registers)
}

#[inline]
fn estimate_from_comparison(
    x_cardinality: f64,
    y_cardinality: f64,
    k: u8,
    registers: RegisterComparison,
) -> Option<ContainmentEstimate> {
    if x_cardinality <= 0.0 {
        return None;
    }
    let jaccard = registers.jaccard?;
    let intersection = if jaccard == 0.0 {
        0.0
    } else {
        jaccard * (x_cardinality + y_cardinality) / (1.0 + jaccard)
    }
    .clamp(0.0, x_cardinality.min(y_cardinality));
    let containment = (intersection / x_cardinality).clamp(0.0, 1.0);
    let ani = if containment == 0.0 {
        0.0
    } else {
        containment.powf(1.0 / f64::from(k))
    };
    Some(ContainmentEstimate {
        jaccard,
        containment,
        ani,
        direction: DirectionEvidence {
            forward: registers.forward_matches,
            reverse: registers.reverse_matches,
            ambiguous: registers.ambiguous_matches,
        },
        registers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dna::Orientation;
    use crate::hash::fmix64;

    #[test]
    fn identical_sketch_has_full_containment_and_ani() {
        let mut sketch = OphSketch::new(256, 10);
        for value in 0..50_000_u64 {
            sketch.insert(fmix64(value), Orientation::Forward);
        }
        let estimate = estimate_containment(&sketch, &sketch, 21, 14, 256).unwrap();
        assert!((estimate.containment - 1.0).abs() < f64::EPSILON);
        assert!((estimate.ani - 1.0).abs() < f64::EPSILON);
        assert_eq!(estimate.direction.signed(), Some(1.0));
    }

    #[test]
    fn empty_numerator_is_missing() {
        let empty = OphSketch::new(64, 8);
        assert!(estimate_containment(&empty, &empty, 21, 14, 64).is_none());
    }
}
