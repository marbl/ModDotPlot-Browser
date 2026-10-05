//! Frozen-axis provenance and contiguous-range validation.

use super::FrozenAxis;

pub(super) fn compatible_contiguous(left: &FrozenAxis, right: &FrozenAxis) -> bool {
    left.offset
        .checked_add(left.core_encoded.len())
        .is_some_and(|expected| right.offset == expected)
        && right.scientific_config.identity() == left.scientific_config.identity()
        && right.sequence_identity == left.sequence_identity
        && right.sequence_name == left.sequence_name
        && right.sequence_length == left.sequence_length
        && right.domain_length == left.domain_length
        && right.resolution == left.resolution
        && right.core_encoded.len() == right.expanded_encoded.len()
}
