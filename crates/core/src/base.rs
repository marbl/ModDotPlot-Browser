//! Exact base-resolution matrix tiles.

use crate::dna::PackedSequence;
use crate::matrix::{MISSING_IDENTITY, MatrixTile};

/// Request for a row-major exact base tile in the shared sequence domain.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BaseTileRequest {
    /// Shared coordinate domain, at least as long as both sequences.
    pub domain_length: u64,
    /// First x base.
    pub x_start: u64,
    /// First y base.
    pub y_start: u64,
    /// Requested width in bases.
    pub width: usize,
    /// Requested height in bases.
    pub height: usize,
}

/// Computes an exact base-by-base match tile.
///
/// Equal bases are forward matches, complementary bases are reverse matches, and
/// all other valid pairs are mismatches. Ambiguous sequence and padded coordinates
/// are missing data. Identity storage is reused as an exact binary match channel;
/// callers must label this measurement as base matching rather than estimated ANI.
///
/// # Panics
///
/// Panics if the shared domain is shorter than either input sequence.
pub fn compute_base_tile(
    x: &PackedSequence,
    y: &PackedSequence,
    request: BaseTileRequest,
) -> MatrixTile {
    assert!(request.domain_length >= x.len());
    assert!(request.domain_length >= y.len());
    let width = usize::try_from(
        request
            .domain_length
            .saturating_sub(request.x_start)
            .min(request.width as u64),
    )
    .expect("a requested tile width must fit usize");
    let height = usize::try_from(
        request
            .domain_length
            .saturating_sub(request.y_start)
            .min(request.height as u64),
    )
    .expect("a requested tile height must fit usize");
    let mut tile = MatrixTile {
        width,
        height,
        identity: vec![MISSING_IDENTITY; width.saturating_mul(height)],
        direction: vec![0; width.saturating_mul(height)],
        direction_support: vec![0; width.saturating_mul(height)],
    };

    for row in 0..height {
        let y_position = request.y_start + row as u64;
        let Some((y_base, true)) = y.get(y_position) else {
            continue;
        };
        for column in 0..width {
            let x_position = request.x_start + column as u64;
            let Some((x_base, true)) = x.get(x_position) else {
                continue;
            };
            let output = row * width + column;
            tile.identity[output] = 0;
            if x_base == y_base {
                tile.identity[output] = 10_000;
                tile.direction[output] = i16::MAX;
                tile.direction_support[output] = 1;
            } else if x_base == 3 - y_base {
                tile.identity[output] = 10_000;
                tile.direction[output] = -i16::MAX;
                tile.direction_support[output] = 1;
            }
        }
    }
    tile
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_forward_reverse_mismatch_and_missing_cells() {
        let x = PackedSequence::from_ascii("x", b"ACGN");
        let y = PackedSequence::from_ascii("y", b"ATCN");
        let tile = compute_base_tile(
            &x,
            &y,
            BaseTileRequest {
                domain_length: 5,
                x_start: 0,
                y_start: 0,
                width: 5,
                height: 5,
            },
        );

        assert_eq!(tile.identity[0], 10_000); // A/A forward
        assert_eq!(tile.direction[0], i16::MAX);
        assert_eq!(tile.identity[5], 10_000); // A/T reverse complement
        assert_eq!(tile.direction[5], -i16::MAX);
        assert_eq!(tile.identity[2 * 5], 0); // A/C mismatch
        assert_eq!(tile.identity[3 * 5], MISSING_IDENTITY);
        assert_eq!(tile.identity[4 * 5], MISSING_IDENTITY);
    }

    #[test]
    fn clips_tiles_at_the_common_domain_edge() {
        let sequence = PackedSequence::from_ascii("seq", b"ACGT");
        let tile = compute_base_tile(
            &sequence,
            &sequence,
            BaseTileRequest {
                domain_length: 4,
                x_start: 3,
                y_start: 2,
                width: 256,
                height: 256,
            },
        );
        assert_eq!((tile.width, tile.height), (1, 2));
    }
}
