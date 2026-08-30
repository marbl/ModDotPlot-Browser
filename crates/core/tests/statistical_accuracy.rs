//! Statistical acceptance tests against exact k-mer-set calculations.

use moddotplot_core::validation::{SparseCorrectionPolicy, compute_tile_adaptive};
use moddotplot_core::{
    ExactKmerSet, PackedSequence, ScientificConfig, TileRequest, build_axis_overview,
    exact_moddotplot_score,
};

#[test]
fn bbit_overview_tracks_exact_high_identity_windows() {
    const LENGTH: usize = 160_000;
    const RESOLUTION: usize = 20;
    const K: u8 = 21;
    let left_bases = pseudo_random_sequence(LENGTH);
    let mut right_bases = left_bases.clone();
    for index in (101..LENGTH).step_by(97) {
        right_bases[index] = mutate(right_bases[index]);
    }

    let left = PackedSequence::from_ascii("left", &left_bases);
    let right = PackedSequence::from_ascii("right", &right_bases);
    let config = ScientificConfig::production_default(K, 2_048, true).unwrap();
    let left_axis = build_axis_overview(&left, left.len(), RESOLUTION, config).unwrap();
    let right_axis = build_axis_overview(&right, right.len(), RESOLUTION, config).unwrap();
    let tile = compute_tile_adaptive(
        &left_axis,
        &right_axis,
        &left,
        &right,
        config.hash_algorithm(),
        config.hash_seed(),
        TileRequest {
            x_start: 0,
            y_start: 0,
            width: RESOLUTION,
            height: RESOLUTION,
        },
        SparseCorrectionPolicy {
            ani_floor: config.ani_floor(),
            minimum_detection_probability: config.minimum_detection_probability(),
        },
    )
    .unwrap();

    let left_exact = exact_axis(&left, RESOLUTION, K);
    let right_exact = exact_axis(&right, RESOLUTION, K);
    let mut errors = Vec::new();
    for index in 0..RESOLUTION {
        let exact = exact_moddotplot_score(
            &left_exact[index].0,
            &left_exact[index].1,
            &right_exact[index].0,
            &right_exact[index].1,
            K,
        )
        .unwrap();
        let estimated = f64::from(tile.identity[index * RESOLUTION + index]) / 10_000.0;
        errors.push((estimated - exact.ani).abs());
    }
    errors.sort_by(f64::total_cmp);
    let error_count = u32::try_from(errors.len()).unwrap();
    let mean = errors.iter().sum::<f64>() / f64::from(error_count);
    let p95 = errors[(errors.len() * 95 / 100).min(errors.len() - 1)];
    assert!(mean < 0.015, "mean ANI error was {mean:.5}");
    assert!(p95 < 0.035, "95th percentile ANI error was {p95:.5}");
}

fn exact_axis(
    sequence: &PackedSequence,
    resolution: usize,
    k: u8,
) -> Vec<(ExactKmerSet, ExactKmerSet)> {
    let domain = sequence.len();
    (0..resolution)
        .map(|bin| {
            let start = boundary(bin * 2, resolution * 2, domain);
            let end = boundary(bin * 2 + 2, resolution * 2, domain);
            let expanded_start = boundary((bin * 2).saturating_sub(1), resolution * 2, domain);
            let expanded_end = boundary((bin * 2 + 3).min(resolution * 2), resolution * 2, domain);
            (
                ExactKmerSet::from_interval(sequence, start, end, k),
                ExactKmerSet::from_interval(sequence, expanded_start, expanded_end, k),
            )
        })
        .collect()
}

fn boundary(index: usize, count: usize, domain: u64) -> u64 {
    u64::try_from(index as u128 * u128::from(domain) / count as u128).unwrap()
}

fn mutate(base: u8) -> u8 {
    match base {
        b'A' => b'C',
        b'C' => b'G',
        b'G' => b'T',
        _ => b'A',
    }
}

fn pseudo_random_sequence(length: usize) -> Vec<u8> {
    let mut state = 0x1319_8a2e_0370_7344_u64;
    let mut sequence = Vec::with_capacity(length);
    for _ in 0..length {
        state = state
            .wrapping_mul(2_862_933_555_777_941_757)
            .wrapping_add(3_037_000_493);
        sequence.push(b"ACGT"[((state >> 61) & 3) as usize]);
    }
    sequence
}
