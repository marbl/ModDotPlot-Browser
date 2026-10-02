//! Exact canonical k-mer dotplot tiles for maximum zoom.

use crate::dna::{Orientation, PackedSequence};
use crate::matrix::{MISSING_IDENTITY, MatrixTile, TileBuildError};

/// Geometry used to display equal canonical k-mer pairs in an exact tile.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum KmerTileGeometry {
    /// Paint every base in the complete `k`-base alignment footprint.
    #[default]
    Footprints,
    /// Paint only the pair of k-mer start coordinates.
    Anchors,
}

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
    /// Geometry used to paint equal canonical k-mers.
    pub geometry: KmerTileGeometry,
}

/// Computes an exact canonical k-mer equality tile.
///
/// Equal canonical k-mers receive identity 1. [`KmerTileGeometry::Footprints`]
/// paints their complete `k`-base alignment footprint, while
/// [`KmerTileGeometry::Anchors`] paints only the k-mer start pair. Opposite
/// canonical orientations use reverse direction evidence; unequal valid k-mer
/// starts receive identity 0. Missing, padded, or ambiguity-overlapping positions
/// use the missing sentinel unless covered by a valid exact match.
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

    match request.geometry {
        KmerTileGeometry::Footprints => paint_match_footprints(x, y, request, &mut tile)?,
        KmerTileGeometry::Anchors => paint_match_anchors(&x_kmers, &y_kmers, &mut tile),
    }
    Ok(tile)
}

fn paint_match_anchors(
    x_kmers: &[Option<(u64, Orientation)>],
    y_kmers: &[Option<(u64, Orientation)>],
    tile: &mut MatrixTile,
) {
    for (row, right) in y_kmers.iter().enumerate() {
        let Some((right_bits, right_orientation)) = right else {
            continue;
        };
        for (column, left) in x_kmers.iter().enumerate() {
            let Some((left_bits, left_orientation)) = left else {
                continue;
            };
            if left_bits != right_bits {
                continue;
            }
            let output = row * tile.width + column;
            tile.identity[output] = 10_000;
            tile.direction_support[output] = 1;
            tile.direction[output] =
                match alignment_footprints(*left_orientation, *right_orientation) {
                    [
                        AlignmentFootprint::Forward(direction)
                        | AlignmentFootprint::Reverse(direction),
                    ] => direction_to_i16(*direction),
                    _ => 0,
                };
        }
    }
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
            for footprint in alignment_footprints(*left_orientation, *right_orientation) {
                for offset in 0..u64::from(request.k) {
                    let x_position = left_start + offset;
                    let (y_position, direction) = match footprint {
                        AlignmentFootprint::Forward(direction) => {
                            (right_start + offset, *direction)
                        }
                        AlignmentFootprint::Reverse(direction) => {
                            (right_start + u64::from(request.k - 1) - offset, *direction)
                        }
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
                    tile.direction_support[output] =
                        tile.direction_support[output].saturating_add(1);
                    direction_balance[output] += direction;
                }
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AlignmentFootprint {
    Forward(i32),
    Reverse(i32),
}

fn alignment_footprints(left: Orientation, right: Orientation) -> &'static [AlignmentFootprint] {
    const FORWARD: &[AlignmentFootprint] = &[AlignmentFootprint::Forward(1)];
    const REVERSE: &[AlignmentFootprint] = &[AlignmentFootprint::Reverse(-1)];
    const PALINDROMIC: &[AlignmentFootprint] = &[
        AlignmentFootprint::Forward(0),
        AlignmentFootprint::Reverse(0),
    ];
    const NONE: &[AlignmentFootprint] = &[];

    match (left, right) {
        (Orientation::Forward, Orientation::Forward)
        | (Orientation::Reverse, Orientation::Reverse) => FORWARD,
        (Orientation::Forward, Orientation::Reverse)
        | (Orientation::Reverse, Orientation::Forward) => REVERSE,
        // Canonical bits can only be palindromic on both axes simultaneously.
        // Treat a mixed state conservatively if a future producer violates that
        // invariant: both alignment geometries are possible and neither supplies
        // signed direction evidence.
        (Orientation::Both, _) | (_, Orientation::Both) => PALINDROMIC,
        (Orientation::Unknown, _) | (_, Orientation::Unknown) => NONE,
    }
}

fn direction_to_i16(direction: i32) -> i16 {
    match direction.cmp(&0) {
        std::cmp::Ordering::Less => -i16::MAX,
        std::cmp::Ordering::Equal => 0,
        std::cmp::Ordering::Greater => i16::MAX,
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

    const PERIODIC_LENGTH: usize = 72;
    const PERIODIC_K: u8 = 21;

    fn periodic_sequence() -> PackedSequence {
        PackedSequence::from_ascii("periodic", "ACGT".repeat(18).as_bytes())
    }

    fn periodic_tile(geometry: KmerTileGeometry) -> MatrixTile {
        let sequence = periodic_sequence();
        compute_kmer_tile(
            &sequence,
            &sequence,
            KmerTileRequest {
                domain_length: PERIODIC_LENGTH as u64,
                x_start: 0,
                y_start: 0,
                width: PERIODIC_LENGTH,
                height: PERIODIC_LENGTH,
                k: PERIODIC_K,
                geometry,
            },
        )
        .unwrap()
    }

    fn stitch_periodic_tiles(
        geometry: KmerTileGeometry,
        x_boundaries: &[usize],
        y_boundaries: &[usize],
    ) -> MatrixTile {
        let sequence = periodic_sequence();
        let cell_count = PERIODIC_LENGTH * PERIODIC_LENGTH;
        let mut stitched = MatrixTile {
            width: PERIODIC_LENGTH,
            height: PERIODIC_LENGTH,
            identity: vec![MISSING_IDENTITY; cell_count],
            direction: vec![0; cell_count],
            direction_support: vec![0; cell_count],
        };

        for y_bounds in y_boundaries.windows(2) {
            for x_bounds in x_boundaries.windows(2) {
                let x_start = x_bounds[0];
                let y_start = y_bounds[0];
                let tile = compute_kmer_tile(
                    &sequence,
                    &sequence,
                    KmerTileRequest {
                        domain_length: PERIODIC_LENGTH as u64,
                        x_start: x_start as u64,
                        y_start: y_start as u64,
                        width: x_bounds[1] - x_start,
                        height: y_bounds[1] - y_start,
                        k: PERIODIC_K,
                        geometry,
                    },
                )
                .unwrap();
                for row in 0..tile.height {
                    let source = row * tile.width;
                    let destination = (y_start + row) * PERIODIC_LENGTH + x_start;
                    stitched.identity[destination..destination + tile.width]
                        .copy_from_slice(&tile.identity[source..source + tile.width]);
                    stitched.direction[destination..destination + tile.width]
                        .copy_from_slice(&tile.direction[source..source + tile.width]);
                    stitched.direction_support[destination..destination + tile.width]
                        .copy_from_slice(&tile.direction_support[source..source + tile.width]);
                }
            }
        }
        stitched
    }

    fn assert_symmetric(tile: &MatrixTile) {
        assert_eq!(tile.width, tile.height);
        for row in 0..tile.height {
            for column in 0..tile.width {
                let cell = row * tile.width + column;
                let transpose = column * tile.width + row;
                assert_eq!(tile.identity[cell], tile.identity[transpose]);
                assert_eq!(tile.direction[cell], tile.direction[transpose]);
                assert_eq!(
                    tile.direction_support[cell],
                    tile.direction_support[transpose]
                );
            }
        }
    }

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
                geometry: KmerTileGeometry::Footprints,
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
                geometry: KmerTileGeometry::Footprints,
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
                geometry: KmerTileGeometry::Footprints,
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
                geometry: KmerTileGeometry::Footprints,
            },
        )
        .unwrap();
        assert_eq!(tile.identity, vec![10_000]);
        assert_eq!(tile.direction, vec![-i16::MAX]);
    }

    #[test]
    fn periodic_footprints_have_expected_counts_symmetry_and_diagonals() {
        let tile = periodic_tile(KmerTileGeometry::Footprints);
        assert_eq!(
            tile.identity
                .iter()
                .filter(|&&value| value == 10_000)
                .count(),
            2_352
        );
        assert_eq!(
            tile.identity.iter().filter(|&&value| value == 0).count(),
            1_352
        );
        assert_eq!(
            tile.identity
                .iter()
                .filter(|&&value| value == MISSING_IDENTITY)
                .count(),
            1_480
        );
        assert_eq!(
            tile.direction
                .iter()
                .filter(|&&value| value == i16::MAX)
                .count(),
            1_176
        );
        assert_eq!(
            tile.direction
                .iter()
                .filter(|&&value| value == -i16::MAX)
                .count(),
            1_176
        );
        let supported = tile
            .direction_support
            .iter()
            .copied()
            .filter(|&support| support > 0);
        assert_eq!(supported.clone().min(), Some(1));
        assert_eq!(supported.max(), Some(u16::from(PERIODIC_K)));

        assert_symmetric(&tile);
        for coordinate in 0..PERIODIC_LENGTH {
            let forward = coordinate * PERIODIC_LENGTH + coordinate;
            assert_eq!(tile.identity[forward], 10_000);
            assert_eq!(tile.direction[forward], i16::MAX);

            let reverse = coordinate * PERIODIC_LENGTH + (PERIODIC_LENGTH - 1 - coordinate);
            assert_eq!(tile.identity[reverse], 10_000);
            assert_eq!(tile.direction[reverse], -i16::MAX);
        }
    }

    #[test]
    fn periodic_anchors_paint_only_equal_kmer_start_pairs() {
        let tile = periodic_tile(KmerTileGeometry::Anchors);
        assert_eq!(
            tile.identity
                .iter()
                .filter(|&&value| value == 10_000)
                .count(),
            1_352
        );
        assert_eq!(
            tile.identity.iter().filter(|&&value| value == 0).count(),
            1_352
        );
        assert_eq!(
            tile.identity
                .iter()
                .filter(|&&value| value == MISSING_IDENTITY)
                .count(),
            2_480
        );
        assert_eq!(
            tile.direction
                .iter()
                .filter(|&&value| value == i16::MAX)
                .count(),
            676
        );
        assert_eq!(
            tile.direction
                .iter()
                .filter(|&&value| value == -i16::MAX)
                .count(),
            676
        );
        assert!(tile.direction_support.iter().all(|&support| support <= 1));
        assert_eq!(
            tile.direction_support
                .iter()
                .filter(|&&support| support == 1)
                .count(),
            1_352
        );

        assert_symmetric(&tile);
        let valid_starts = PERIODIC_LENGTH - usize::from(PERIODIC_K) + 1;
        for coordinate in 0..valid_starts {
            let forward = coordinate * PERIODIC_LENGTH + coordinate;
            assert_eq!(tile.identity[forward], 10_000);
            assert_eq!(tile.direction[forward], i16::MAX);

            let reverse = coordinate * PERIODIC_LENGTH + (valid_starts - 1 - coordinate);
            assert_eq!(tile.identity[reverse], 10_000);
            assert_eq!(tile.direction[reverse], -i16::MAX);
        }
        for coordinate in valid_starts..PERIODIC_LENGTH {
            let diagonal = coordinate * PERIODIC_LENGTH + coordinate;
            assert_eq!(tile.identity[diagonal], MISSING_IDENTITY);
            assert_eq!(tile.direction_support[diagonal], 0);
        }
    }

    #[test]
    fn periodic_full_and_split_tiles_are_identical_for_each_geometry() {
        let x_boundaries = [0, 7, 29, 51, PERIODIC_LENGTH];
        let y_boundaries = [0, 13, 32, 60, PERIODIC_LENGTH];
        for geometry in [KmerTileGeometry::Footprints, KmerTileGeometry::Anchors] {
            assert_eq!(
                periodic_tile(geometry),
                stitch_periodic_tiles(geometry, &x_boundaries, &y_boundaries),
                "split tile seam changed {geometry:?} output"
            );
        }
    }

    #[test]
    fn even_k_palindrome_paints_both_footprints_with_neutral_direction() {
        let sequence = PackedSequence::from_ascii("palindrome", b"AT");
        let tile = compute_kmer_tile(
            &sequence,
            &sequence,
            KmerTileRequest {
                domain_length: 2,
                x_start: 0,
                y_start: 0,
                width: 2,
                height: 2,
                k: 2,
                geometry: KmerTileGeometry::Footprints,
            },
        )
        .unwrap();

        assert_eq!(tile.identity, vec![10_000; 4]);
        assert_eq!(tile.direction, vec![0; 4]);
        assert_eq!(tile.direction_support, vec![1; 4]);
    }

    #[test]
    fn overlapping_even_k_palindromes_count_each_origin_geometry_once() {
        let sequence = PackedSequence::from_ascii("palindromes", b"ATAT");
        let tile = compute_kmer_tile(
            &sequence,
            &sequence,
            KmerTileRequest {
                domain_length: 4,
                x_start: 0,
                y_start: 0,
                width: 4,
                height: 4,
                k: 2,
                geometry: KmerTileGeometry::Footprints,
            },
        )
        .unwrap();

        assert_eq!(tile.identity, vec![10_000; 16]);
        assert_eq!(tile.direction, vec![0; 16]);
        assert_eq!(
            tile.direction_support,
            vec![1, 1, 1, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1, 1, 1, 1]
        );
    }

    #[test]
    fn even_k_palindrome_anchor_is_single_neutral_evidence_cell() {
        let sequence = PackedSequence::from_ascii("palindrome", b"AT");
        let tile = compute_kmer_tile(
            &sequence,
            &sequence,
            KmerTileRequest {
                domain_length: 2,
                x_start: 0,
                y_start: 0,
                width: 2,
                height: 2,
                k: 2,
                geometry: KmerTileGeometry::Anchors,
            },
        )
        .unwrap();

        assert_eq!(
            tile.identity,
            vec![10_000, MISSING_IDENTITY, MISSING_IDENTITY, MISSING_IDENTITY]
        );
        assert_eq!(tile.direction, vec![0; 4]);
        assert_eq!(tile.direction_support, vec![1, 0, 0, 0]);
    }
}
