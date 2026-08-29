//! Exact canonical k-mer dotplot tiles for maximum zoom.

use crate::dna::{Orientation, PackedSequence};
use crate::matrix::{MISSING_IDENTITY, MatrixTile, TileBuildError};

/// Request for a row-major exact k-mer tile.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct KmerTileRequest {
    /// Shared padded coordinate domain.
    pub domain_length: u64,
    /// First x-axis k-mer start.
    pub x_start: u64,
    /// First y-axis k-mer start.
    pub y_start: u64,
    /// Requested tile width.
    pub width: usize,
    /// Requested tile height.
    pub height: usize,
    /// Exact canonical k-mer length.
    pub k: u8,
}

/// Computes an exact canonical k-mer equality tile.
///
/// Equal canonical k-mers paint their complete `k`-base alignment footprint with
/// identity 1. Opposite canonical orientations paint a reverse diagonal; unequal
/// valid k-mer starts receive identity 0. Missing, padded, or ambiguity-overlapping
/// positions use the missing sentinel unless covered by another valid exact match.
///
/// # Errors
///
/// Returns [`TileBuildError`] before allocation for an invalid domain, k-mer length,
/// coordinate, or output size.
pub fn compute_kmer_tile(
    x: &PackedSequence,
    y: &PackedSequence,
    request: KmerTileRequest,
) -> Result<MatrixTile, TileBuildError> {
    if request.domain_length == 0 || !(1..=31).contains(&request.k) {
        return Err(TileBuildError::Parameters);
    }
    if request.x_start >= request.domain_length || request.y_start >= request.domain_length {
        return Err(TileBuildError::Range);
    }
    if request.width == 0 || request.height == 0 {
        return Err(TileBuildError::Dimensions);
    }
    let width = request
        .width
        .min(usize::try_from(request.domain_length - request.x_start).unwrap_or(usize::MAX));
    let height = request
        .height
        .min(usize::try_from(request.domain_length - request.y_start).unwrap_or(usize::MAX));
    let cell_count = width
        .checked_mul(height)
        .ok_or(TileBuildError::Dimensions)?;
    let mut tile = MatrixTile {
        width,
        height,
        identity: vec![MISSING_IDENTITY; cell_count],
        direction: vec![0; cell_count],
        direction_support: vec![0; cell_count],
    };
    let x_kmers = exact_range(x, request.x_start, width, request.k)?;
    let y_kmers = exact_range(y, request.y_start, height, request.k)?;
    for (row, right) in y_kmers.iter().enumerate() {
        let Some((right_bits, _)) = right else {
            continue;
        };
        for (column, left) in x_kmers.iter().enumerate() {
            let Some((left_bits, _)) = left else {
                continue;
            };
            if left_bits != right_bits {
                tile.identity[row * width + column] = 0;
            }
        }
    }

    paint_match_footprints(x, y, request, &mut tile)?;
    Ok(tile)
}

fn paint_match_footprints(
    x: &PackedSequence,
    y: &PackedSequence,
    request: KmerTileRequest,
    tile: &mut MatrixTile,
) -> Result<(), TileBuildError> {
    let flank = u64::from(request.k - 1);
    let x_origin_start = request.x_start.saturating_sub(flank);
    let y_origin_start = request.y_start.saturating_sub(flank);
    let x_output_end = request
        .x_start
        .saturating_add(u64::try_from(tile.width).map_err(|_| TileBuildError::Dimensions)?);
    let y_output_end = request
        .y_start
        .saturating_add(u64::try_from(tile.height).map_err(|_| TileBuildError::Dimensions)?);
    let x_origin_count =
        usize::try_from(x_output_end - x_origin_start).map_err(|_| TileBuildError::Dimensions)?;
    let y_origin_count =
        usize::try_from(y_output_end - y_origin_start).map_err(|_| TileBuildError::Dimensions)?;
    let x_origins = exact_range(x, x_origin_start, x_origin_count, request.k)?;
    let y_origins = exact_range(y, y_origin_start, y_origin_count, request.k)?;
    let mut direction_balance = vec![0_i32; tile.identity.len()];

    for (right_offset, right) in y_origins.iter().enumerate() {
        let Some((right_bits, right_orientation)) = right else {
            continue;
        };
        let right_start = y_origin_start
            .saturating_add(u64::try_from(right_offset).map_err(|_| TileBuildError::Range)?);
        for (left_offset, left) in x_origins.iter().enumerate() {
            let Some((left_bits, left_orientation)) = left else {
                continue;
            };
            if left_bits != right_bits {
                continue;
            }
            let left_start = x_origin_start
                .saturating_add(u64::try_from(left_offset).map_err(|_| TileBuildError::Range)?);
            let direction = relative_direction(*left_orientation, *right_orientation);
            for offset in 0..u64::from(request.k) {
                let x_position = left_start + offset;
                let y_position = if direction < 0 {
                    right_start + u64::from(request.k - 1) - offset
                } else {
                    right_start + offset
                };
                if x_position < request.x_start
                    || x_position >= x_output_end
                    || y_position < request.y_start
                    || y_position >= y_output_end
                {
                    continue;
                }
                let column = usize::try_from(x_position - request.x_start)
                    .map_err(|_| TileBuildError::Range)?;
                let row = usize::try_from(y_position - request.y_start)
                    .map_err(|_| TileBuildError::Range)?;
                let output = row * tile.width + column;
                tile.identity[output] = 10_000;
                tile.direction_support[output] = tile.direction_support[output].saturating_add(1);
                direction_balance[output] += direction;
            }
        }
    }

    for (index, support) in tile.direction_support.iter().copied().enumerate() {
        if support == 0 {
            continue;
        }
        let scaled = i64::from(direction_balance[index]) * i64::from(i16::MAX) / i64::from(support);
        tile.direction[index] =
            i16::try_from(scaled).unwrap_or(if scaled < 0 { i16::MIN } else { i16::MAX });
    }
    Ok(())
}

fn relative_direction(left: Orientation, right: Orientation) -> i32 {
    match (left, right) {
        (Orientation::Forward, Orientation::Forward)
        | (Orientation::Reverse, Orientation::Reverse) => 1,
        (Orientation::Forward, Orientation::Reverse)
        | (Orientation::Reverse, Orientation::Forward) => -1,
        _ => 0,
    }
}

fn exact_range(
    sequence: &PackedSequence,
    start: u64,
    count: usize,
    k: u8,
) -> Result<Vec<Option<(u64, Orientation)>>, TileBuildError> {
    let count_u64 = u64::try_from(count).map_err(|_| TileBuildError::Dimensions)?;
    let end = start.saturating_add(count_u64);
    let mut result = vec![None; count];
    for kmer in sequence.canonical_kmers(k, start, end) {
        let local = usize::try_from(kmer.start - start).map_err(|_| TileBuildError::Range)?;
        if let Some(cell) = result.get_mut(local) {
            *cell = Some((kmer.bits, kmer.orientation));
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_kmers_distinguish_forward_reverse_mismatch_and_ambiguity() {
        let x = PackedSequence::from_ascii("x", b"AACCGTN");
        let y = PackedSequence::from_ascii("y", b"AACCGTN");
        let tile = compute_kmer_tile(
            &x,
            &y,
            KmerTileRequest {
                domain_length: 7,
                x_start: 0,
                y_start: 0,
                width: 7,
                height: 7,
                k: 3,
            },
        )
        .unwrap();
        assert_eq!(tile.identity[0], 10_000);
        assert_eq!(tile.identity[1], 0);
        assert_eq!(tile.identity[6 * 7 + 6], MISSING_IDENTITY);

        let reverse = PackedSequence::from_ascii("reverse", b"CGGTT");
        let reverse_tile = compute_kmer_tile(
            &x,
            &reverse,
            KmerTileRequest {
                domain_length: 7,
                x_start: 0,
                y_start: 0,
                width: 5,
                height: 5,
                k: 5,
            },
        )
        .unwrap();
        assert_eq!(reverse_tile.identity[0], MISSING_IDENTITY);
        assert_eq!(reverse_tile.identity[4 * 5], 10_000);
        assert_eq!(reverse_tile.direction[4 * 5], -i16::MAX);
    }

    #[test]
    fn exact_kmers_extend_forward_matches_that_begin_outside_the_tile() {
        let x = PackedSequence::from_ascii("x", b"AAACG");
        let y = PackedSequence::from_ascii("y", b"AAATT");
        let tile = compute_kmer_tile(
            &x,
            &y,
            KmerTileRequest {
                domain_length: 5,
                x_start: 2,
                y_start: 2,
                width: 1,
                height: 1,
                k: 3,
            },
        )
        .unwrap();
        assert_eq!(tile.identity, vec![10_000]);
        assert_eq!(tile.direction, vec![i16::MAX]);
    }

    #[test]
    fn exact_kmers_extend_reverse_matches_from_start_to_start_plus_k_minus_one() {
        let x = PackedSequence::from_ascii("x", b"AAACG");
        let y = PackedSequence::from_ascii("y", b"TTTGG");
        let tile = compute_kmer_tile(
            &x,
            &y,
            KmerTileRequest {
                domain_length: 5,
                x_start: 2,
                y_start: 0,
                width: 1,
                height: 1,
                k: 3,
            },
        )
        .unwrap();
        assert_eq!(tile.identity, vec![10_000]);
        assert_eq!(tile.direction, vec![-i16::MAX]);
    }
}
