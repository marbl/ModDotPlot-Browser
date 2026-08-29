//! Statistical acceptance tests against exact k-mer-set calculations.

use moddotplot_core::{
    BottomSItem, DEFAULT_HASH_SEED, ExactHashSet, PackedSequence, TileRequest, build_axis_overview,
    compute_tile, estimate_bottom_s_containment, exact_moddotplot_score, mashmap_bottom_s_range,
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
    let left_axis = build_axis_overview(&left, left.len(), RESOLUTION, K, 42, 2_048, 12);
    let right_axis = build_axis_overview(&right, right.len(), RESOLUTION, K, 42, 2_048, 12);
    let tile = compute_tile(
        &left_axis,
        &right_axis,
        TileRequest {
            x_start: 0,
            y_start: 0,
            width: RESOLUTION,
            height: RESOLUTION,
            b_bits: 14,
            register_limit: 2_048,
            k: K,
        },
    );

    let left_exact = exact_axis(&left, RESOLUTION, K);
    let right_exact = exact_axis(&right, RESOLUTION, K);
    let mut errors = Vec::new();
    let left_mashmap = mashmap_axis(&left, RESOLUTION, K, 2_048);
    let right_mashmap = mashmap_axis(&right, RESOLUTION, K, 2_048);
    let mut mashmap_errors = Vec::new();
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
        let mashmap = mashmap_score(
            &left_mashmap[index].0,
            &left_mashmap[index].1,
            &right_mashmap[index].0,
            &right_mashmap[index].1,
            K,
            2_048,
        );
        mashmap_errors.push((estimated - mashmap).abs());
    }
    errors.sort_by(f64::total_cmp);
    let error_count = u32::try_from(errors.len()).unwrap();
    let mean = errors.iter().sum::<f64>() / f64::from(error_count);
    let p95 = errors[(errors.len() * 95 / 100).min(errors.len() - 1)];
    assert!(mean < 0.015, "mean ANI error was {mean:.5}");
    assert!(p95 < 0.035, "95th percentile ANI error was {p95:.5}");

    mashmap_errors.sort_by(f64::total_cmp);
    let mashmap_mean = mashmap_errors.iter().sum::<f64>() / f64::from(error_count);
    let mashmap_p95 =
        mashmap_errors[(mashmap_errors.len() * 95 / 100).min(mashmap_errors.len() - 1)];
    assert!(
        mashmap_mean < 0.02,
        "mean ANI error against MashMap bottom-s was {mashmap_mean:.5}"
    );
    assert!(
        mashmap_p95 < 0.04,
        "95th percentile ANI error against MashMap bottom-s was {mashmap_p95:.5}"
    );
}

fn mashmap_axis(
    sequence: &PackedSequence,
    resolution: usize,
    k: u8,
    sketch_size: usize,
) -> Vec<(Vec<BottomSItem>, Vec<BottomSItem>)> {
    let domain = sequence.len();
    (0..resolution)
        .map(|bin| {
            let start = boundary(bin * 2, resolution * 2, domain);
            let end = boundary(bin * 2 + 2, resolution * 2, domain);
            let expanded_start = boundary((bin * 2).saturating_sub(1), resolution * 2, domain);
            let expanded_end = boundary((bin * 2 + 3).min(resolution * 2), resolution * 2, domain);
            (
                mashmap_bottom_s_range(sequence, k, start, end, sketch_size, DEFAULT_HASH_SEED),
                mashmap_bottom_s_range(
                    sequence,
                    k,
                    expanded_start,
                    expanded_end,
                    sketch_size,
                    DEFAULT_HASH_SEED,
                ),
            )
        })
        .collect()
}

fn mashmap_score(
    x_core: &[BottomSItem],
    x_expanded: &[BottomSItem],
    y_core: &[BottomSItem],
    y_expanded: &[BottomSItem],
    k: u8,
    sketch_size: usize,
) -> f64 {
    let x_in_y = estimate_bottom_s_containment(x_core, y_expanded, k, sketch_size);
    let y_in_x = estimate_bottom_s_containment(y_core, x_expanded, k, sketch_size);
    match (x_in_y, y_in_x) {
        (Some(left), Some(right)) => left.ani.max(right.ani),
        (Some(value), None) | (None, Some(value)) => value.ani,
        (None, None) => f64::NAN,
    }
}

fn exact_axis(
    sequence: &PackedSequence,
    resolution: usize,
    k: u8,
) -> Vec<(ExactHashSet, ExactHashSet)> {
    let domain = sequence.len();
    (0..resolution)
        .map(|bin| {
            let start = boundary(bin * 2, resolution * 2, domain);
            let end = boundary(bin * 2 + 2, resolution * 2, domain);
            let expanded_start = boundary((bin * 2).saturating_sub(1), resolution * 2, domain);
            let expanded_end = boundary((bin * 2 + 3).min(resolution * 2), resolution * 2, domain);
            (
                ExactHashSet::from_interval(sequence, start, end, k, DEFAULT_HASH_SEED),
                ExactHashSet::from_interval(
                    sequence,
                    expanded_start,
                    expanded_end,
                    k,
                    DEFAULT_HASH_SEED,
                ),
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
