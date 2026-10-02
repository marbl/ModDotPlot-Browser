//! Validation-only sparse-correction contract.

use crate::PackedSequence;
use crate::matrix::{AxisData, TileBuildError};

/// Statistical decision used by detailed tiles with bounded exact sparse cores.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SparseCorrectionPolicy {
    /// ANI floor at which match detection is evaluated.
    pub ani_floor: f64,
    /// Minimum probability of observing at least one true matching register.
    pub minimum_detection_probability: f64,
}

pub(crate) fn validate_source_sequences(
    x: &impl AxisData,
    y: &impl AxisData,
    x_sequence: &PackedSequence,
    y_sequence: &PackedSequence,
) -> Result<(), TileBuildError> {
    if x.sequence_length() != x_sequence.len()
        || y.sequence_length() != y_sequence.len()
        || x.sequence_name() != x_sequence.name()
        || y.sequence_name() != y_sequence.name()
        || x.sequence_identity() != x_sequence.identity()
        || y.sequence_identity() != y_sequence.identity()
        || x.domain_length() < x_sequence.len()
        || y.domain_length() < y_sequence.len()
    {
        return Err(TileBuildError::IncompatibleSequence);
    }
    Ok(())
}
