//! Axis-request validation and coordinate partitioning.

use super::MatrixBuildError;

pub(super) fn validate_request(
    sequence_length: u64,
    domain_length: u64,
    resolution: usize,
    bin_start: usize,
    bin_count: usize,
) -> Result<(), MatrixBuildError> {
    if domain_length < sequence_length || domain_length == 0 {
        return Err(MatrixBuildError::Domain);
    }
    if resolution == 0 || resolution > usize::MAX / 2 {
        return Err(MatrixBuildError::Resolution);
    }
    if bin_count == 0 || bin_start >= resolution {
        return Err(MatrixBuildError::Range);
    }
    Ok(())
}

pub(super) fn divide_ceil(numerator: u128, denominator: usize) -> u64 {
    let denominator = denominator as u128;
    u64::try_from(numerator.div_ceil(denominator))
        .expect("a coordinate within a u64 domain must fit in u64")
}
