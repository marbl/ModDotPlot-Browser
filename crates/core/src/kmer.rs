//! Exact canonical k-mer dotplot tiles for maximum zoom.

use crate::dna::{Orientation, PackedSequence};
use crate::matrix::{MISSING_IDENTITY, MatrixTile};

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
/// Equal canonical k-mers receive identity 1. Opposite canonical orientations receive
/// reverse direction; unequal valid k-mers receive identity 0. Missing, padded, or
/// ambiguity-overlapping k-mers use the missing sentinel.
///
/// # Panics
///
/// Panics for a zero domain, an invalid k-mer length, an origin outside the domain, or
/// output dimensions that overflow addressable memory.
pub fn compute_kmer_tile(
    x: &PackedSequence,
    y: &PackedSequence,
    request: KmerTileRequest,
) -> MatrixTile {
    assert!(request.domain_length > 0);
    assert!((1..=31).contains(&request.k));
    assert!(request.x_start < request.domain_length);
    assert!(request.y_start < request.domain_length);
    let width = request
        .width
        .min(usize::try_from(request.domain_length - request.x_start).unwrap_or(usize::MAX));
    let height = request
        .height
        .min(usize::try_from(request.domain_length - request.y_start).unwrap_or(usize::MAX));
    let cell_count = width
        .checked_mul(height)
        .expect("k-mer tile dimensions overflow");
    let mut tile = MatrixTile {
        width,
        height,
        identity: vec![MISSING_IDENTITY; cell_count],
        direction: vec![0; cell_count],
        direction_support: vec![0; cell_count],
    };
    let x_kmers = exact_range(x, request.x_start, width, request.k);
    let y_kmers = exact_range(y, request.y_start, height, request.k);
    for (row, right) in y_kmers.iter().enumerate() {
        let Some((right_bits, right_orientation)) = right else {
            continue;
        };
        for (column, left) in x_kmers.iter().enumerate() {
            let Some((left_bits, left_orientation)) = left else {
                continue;
            };
            let output = row * width + column;
            tile.identity[output] = u16::from(left_bits == right_bits) * 10_000;
            if left_bits != right_bits {
                continue;
            }
            tile.direction_support[output] = 1;
            tile.direction[output] = match (*left_orientation, *right_orientation) {
                (Orientation::Forward, Orientation::Forward)
                | (Orientation::Reverse, Orientation::Reverse) => i16::MAX,
                (Orientation::Forward, Orientation::Reverse)
                | (Orientation::Reverse, Orientation::Forward) => -i16::MAX,
                _ => 0,
            };
        }
    }
    tile
}

fn exact_range(
    sequence: &PackedSequence,
    start: u64,
    count: usize,
    k: u8,
) -> Vec<Option<(u64, Orientation)>> {
    let end = start.saturating_add(u64::try_from(count).expect("tile dimension fits u64"));
    let mut result = vec![None; count];
    for kmer in sequence.canonical_kmers(k, start, end) {
        let local = usize::try_from(kmer.start - start).expect("local k-mer index fits usize");
        if let Some(cell) = result.get_mut(local) {
            *cell = Some((kmer.bits, kmer.orientation));
        }
    }
    result
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
                width: 5,
                height: 5,
                k: 3,
            },
        );
        assert_eq!(tile.identity[0], 10_000);
        assert_eq!(tile.identity[1], 0);
        assert_eq!(tile.identity[4 * 5 + 4], MISSING_IDENTITY);

        let reverse = PackedSequence::from_ascii("reverse", b"CGGTT");
        let reverse_tile = compute_kmer_tile(
            &x,
            &reverse,
            KmerTileRequest {
                domain_length: 7,
                x_start: 0,
                y_start: 0,
                width: 1,
                height: 1,
                k: 5,
            },
        );
        assert_eq!(reverse_tile.identity[0], 10_000);
        assert_eq!(reverse_tile.direction[0], -i16::MAX);
    }
}
