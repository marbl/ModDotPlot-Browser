//! Multi-seed differential and spatial validation for OPH estimator candidates.

use moddotplot_core::hash::HashAlgorithm;
use moddotplot_core::{
    AxisOverview, DEFAULT_ANI_FLOOR, DEFAULT_B_BITS, DEFAULT_MATCH_DETECTION_PROBABILITY,
    DEFAULT_VERIFICATION_BITS, ExactKmerSet, OphJaccardEstimator, PackedSequence, ScientificConfig,
    build_axis_overview, estimate_containment_bit_sliced_with, exact_moddotplot_score,
};
use std::time::{Duration, Instant};

const K: u8 = 21;
const RESOLUTION: usize = 12;
const ANI_FLOOR: f64 = 0.80;
const THRESHOLDS: [f64; 4] = [0.80, 0.85, 0.90, 0.95];

#[derive(Clone, Copy, Default)]
struct Confusion {
    false_negative: usize,
    false_positive: usize,
}

#[derive(Default)]
struct Metrics {
    relevant_errors: Vec<f64>,
    bias_sum: f64,
    confusion: [Confusion; THRESHOLDS.len()],
    diagonal_holes_80: usize,
    one_pixel_holes_85: usize,
    isolated_false_pixels: usize,
    exact_forward_edges: usize,
    preserved_forward_edges: usize,
    exact_reverse_edges: usize,
    preserved_reverse_edges: usize,
    local_3_error_sum: f64,
    local_5_error_sum: f64,
    local_3_count: usize,
    local_5_count: usize,
    neighbor_error_correlation_sum: f64,
    top_feature_overlap_sum: f64,
    component_count_error_sum: usize,
    spatial_matrices: usize,
    compared: usize,
    fingerprint_collisions: u64,
    comparison_time: Duration,
}

impl Metrics {
    fn record(&mut self, exact: f64, estimated: f64, row: usize, column: usize) {
        self.compared += 1;
        if exact >= ANI_FLOOR {
            let difference = estimated - exact;
            self.relevant_errors.push(difference.abs());
            self.bias_sum += difference;
            if row == column && estimated < ANI_FLOOR {
                self.diagonal_holes_80 += 1;
            }
        }
        for (index, threshold) in THRESHOLDS.into_iter().enumerate() {
            self.confusion[index].false_negative +=
                usize::from(exact >= threshold && estimated < threshold);
            self.confusion[index].false_positive +=
                usize::from(exact < threshold && estimated >= threshold);
        }
    }

    fn summary(&mut self) -> (f64, f64, f64) {
        self.relevant_errors.sort_by(f64::total_cmp);
        if self.relevant_errors.is_empty() {
            return (f64::NAN, f64::NAN, f64::NAN);
        }
        let count = self.relevant_errors.len().max(1);
        let count_float = f64::from(u32::try_from(count).expect("fixture count fits u32"));
        let mean = self.relevant_errors.iter().sum::<f64>() / count_float;
        let p95 = self.relevant_errors[(self.relevant_errors.len().saturating_sub(1) * 95) / 100];
        let bias = self.bias_sum / count_float;
        (mean, p95, bias)
    }

    fn record_spatial(&mut self, exact: &[Option<f64>], estimated: &[Option<f64>], width: usize) {
        let exact_mask = threshold_mask(exact, 0.85);
        let estimated_mask = threshold_mask(estimated, 0.85);
        for index in 0..exact.len() {
            let neighbors = neighbors(index, width);
            if estimated_mask[index]
                && !exact_mask[index]
                && neighbors.iter().all(|&neighbor| !estimated_mask[neighbor])
            {
                self.isolated_false_pixels += 1;
            }
            if exact_mask[index]
                && !estimated_mask[index]
                && neighbors
                    .iter()
                    .filter(|&&neighbor| exact_mask[neighbor] && estimated_mask[neighbor])
                    .count()
                    >= 2
            {
                self.one_pixel_holes_85 += 1;
            }
        }

        for row in 0..width.saturating_sub(1) {
            for column in 0..width.saturating_sub(1) {
                let here = row * width + column;
                let forward = (row + 1) * width + column + 1;
                if exact_mask[here] && exact_mask[forward] {
                    self.exact_forward_edges += 1;
                    self.preserved_forward_edges +=
                        usize::from(estimated_mask[here] && estimated_mask[forward]);
                }
                let reverse_here = row * width + column + 1;
                let reverse = (row + 1) * width + column;
                if exact_mask[reverse_here] && exact_mask[reverse] {
                    self.exact_reverse_edges += 1;
                    self.preserved_reverse_edges +=
                        usize::from(estimated_mask[reverse_here] && estimated_mask[reverse]);
                }
            }
        }

        for index in 0..exact.len() {
            if let (Some(exact_local), Some(estimated_local)) = (
                local_mean(exact, index, width, 1),
                local_mean(estimated, index, width, 1),
            ) {
                self.local_3_error_sum += (estimated_local - exact_local).abs();
                self.local_3_count += 1;
            }
            if let (Some(exact_local), Some(estimated_local)) = (
                local_mean(exact, index, width, 2),
                local_mean(estimated, index, width, 2),
            ) {
                self.local_5_error_sum += (estimated_local - exact_local).abs();
                self.local_5_count += 1;
            }
        }

        self.neighbor_error_correlation_sum += neighbor_error_correlation(exact, estimated, width);
        self.top_feature_overlap_sum += top_feature_overlap(exact, estimated);
        self.component_count_error_sum +=
            component_count(&exact_mask, width).abs_diff(component_count(&estimated_mask, width));
        self.spatial_matrices += 1;
    }
}

#[test]
#[ignore = "explicit scientific benchmark; run with --release --ignored --nocapture"]
fn report_estimator_hll_and_fingerprint_sweep() {
    println!(
        "estimator\tregisters\thll\tmean_abs_ani\tp95_abs_ani\tbias\tfn80\tfp80\tfn85\tfp85\tfn90\tfp90\tfn95\tfp95\tdiagonal_holes80\tone_pixel_holes85\tisolated_false85\tforward_continuity85\treverse_continuity85\tlocal3_error\tlocal5_error\tneighbor_error_corr\ttop_feature_overlap\tcomponent_count_error85\tfingerprint_collisions\tcomparison_ms"
    );
    for registers in [256, 1_024, 2_048] {
        for hll_precision in [8, 9, 10, 11, 12] {
            for estimator in [
                OphJaccardEstimator::BbitCollisionCorrected,
                OphJaccardEstimator::VerifiedWinners,
            ] {
                let mut combined = Metrics::default();
                for seed in [0, 42, 7_919, 0xd6e8_feb8_6659_fd93] {
                    for (left, right) in fixtures() {
                        evaluate_pair(
                            &left,
                            &right,
                            seed,
                            registers,
                            hll_precision,
                            estimator,
                            &mut combined,
                        );
                    }
                }
                let (mean, p95, bias) = combined.summary();
                println!(
                    "{estimator:?}\t{registers}\t{hll_precision}\t{mean:.6}\t{p95:.6}\t{bias:.6}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{}\t{:.3}",
                    combined.confusion[0].false_negative,
                    combined.confusion[0].false_positive,
                    combined.confusion[1].false_negative,
                    combined.confusion[1].false_positive,
                    combined.confusion[2].false_negative,
                    combined.confusion[2].false_positive,
                    combined.confusion[3].false_negative,
                    combined.confusion[3].false_positive,
                    combined.diagonal_holes_80,
                    combined.one_pixel_holes_85,
                    combined.isolated_false_pixels,
                    ratio(
                        combined.preserved_forward_edges,
                        combined.exact_forward_edges
                    ),
                    ratio(
                        combined.preserved_reverse_edges,
                        combined.exact_reverse_edges
                    ),
                    mean_error(combined.local_3_error_sum, combined.local_3_count),
                    mean_error(combined.local_5_error_sum, combined.local_5_count),
                    mean_error(
                        combined.neighbor_error_correlation_sum,
                        combined.spatial_matrices
                    ),
                    mean_error(combined.top_feature_overlap_sum, combined.spatial_matrices),
                    ratio(
                        combined.component_count_error_sum,
                        combined.spatial_matrices
                    ),
                    combined.fingerprint_collisions,
                    combined.comparison_time.as_secs_f64() * 1_000.0,
                );
            }
        }
    }
}

#[test]
fn verified_estimator_is_exact_for_identical_winner_sets() {
    let sequence = PackedSequence::from_ascii("self", &pseudo_random_sequence(32_000, 17));
    let config = ScientificConfig::production(K, 256, 10, false).unwrap();
    let axis = build_axis_overview(&sequence, sequence.len(), 8, config).unwrap();
    for signature in &axis.core_encoded {
        let estimate = estimate_containment_bit_sliced_with(
            signature,
            signature,
            K,
            14,
            256,
            OphJaccardEstimator::VerifiedWinners,
        )
        .unwrap();
        assert!((estimate.jaccard - 1.0).abs() < f64::EPSILON);
        assert!((estimate.containment - 1.0).abs() < f64::EPSILON);
    }
}

#[test]
#[ignore = "explicit scheduling benchmark; run with --release --ignored --nocapture"]
fn report_fused_projection_tradeoff() {
    let sequence = PackedSequence::from_ascii(
        "projection-benchmark",
        &pseudo_random_sequence(8_000_000, 0x5eed),
    );
    let quick_config = ScientificConfig::production(K, 256, 10, false).unwrap();
    let detailed_config = ScientificConfig::production(K, 2_048, 10, false).unwrap();

    let quick_started = Instant::now();
    let quick = build_axis_overview(&sequence, sequence.len(), 1_000, quick_config).unwrap();
    let quick_elapsed = quick_started.elapsed();

    let detailed_started = Instant::now();
    let detailed = build_axis_overview(&sequence, sequence.len(), 1_000, detailed_config).unwrap();
    let detailed_elapsed = detailed_started.elapsed();
    let projection_started = Instant::now();
    let projected = detailed.project_registers(256, 32);
    let projection_elapsed = projection_started.elapsed();

    assert_eq!(quick.core, projected.core);
    assert_eq!(quick.expanded, projected.expanded);
    println!(
        "separate_quick_ms={:.3}\tdetailed_ms={:.3}\tprojection_ms={:.3}\tseparate_total_ms={:.3}\tfused_total_ms={:.3}",
        quick_elapsed.as_secs_f64() * 1_000.0,
        detailed_elapsed.as_secs_f64() * 1_000.0,
        projection_elapsed.as_secs_f64() * 1_000.0,
        (quick_elapsed + detailed_elapsed).as_secs_f64() * 1_000.0,
        (detailed_elapsed + projection_elapsed).as_secs_f64() * 1_000.0,
    );
}

#[allow(clippy::too_many_arguments)]
fn evaluate_pair(
    left: &PackedSequence,
    right: &PackedSequence,
    seed: u64,
    registers: usize,
    hll_precision: u8,
    estimator: OphJaccardEstimator,
    metrics: &mut Metrics,
) {
    let domain = left.len().max(right.len());
    let config = ScientificConfig::new(
        K,
        HashAlgorithm::NtHash2,
        seed,
        registers,
        DEFAULT_B_BITS,
        DEFAULT_VERIFICATION_BITS,
        estimator,
        hll_precision,
        0,
        DEFAULT_ANI_FLOOR,
        DEFAULT_MATCH_DETECTION_PROBABILITY,
    )
    .unwrap();
    let left_axis = build_axis_overview(left, domain, RESOLUTION, config).unwrap();
    let right_axis = build_axis_overview(right, domain, RESOLUTION, config).unwrap();
    let left_exact = exact_axis(left, domain);
    let right_exact = exact_axis(right, domain);
    let mut exact_matrix = vec![None; RESOLUTION * RESOLUTION];
    let mut estimated_matrix = vec![None; RESOLUTION * RESOLUTION];
    for (row, right_sets) in right_exact.iter().enumerate() {
        for (column, left_sets) in left_exact.iter().enumerate() {
            let started = Instant::now();
            let estimated =
                approximate_score(&left_axis, &right_axis, column, row, registers, estimator);
            metrics.comparison_time += started.elapsed();
            let exact =
                exact_moddotplot_score(&left_sets.0, &left_sets.1, &right_sets.0, &right_sets.1, K);
            let index = row * RESOLUTION + column;
            exact_matrix[index] = exact.map(|value| value.ani);
            estimated_matrix[index] = estimated;
            if let (Some(exact), Some(estimated)) = (exact, estimated) {
                metrics.record(exact.ani, estimated, row, column);
            }
            metrics.fingerprint_collisions +=
                fingerprint_collision_count(&left_axis, &right_axis, column, row, registers);
        }
    }
    metrics.record_spatial(&exact_matrix, &estimated_matrix, RESOLUTION);
}

fn threshold_mask(values: &[Option<f64>], threshold: f64) -> Vec<bool> {
    values
        .iter()
        .map(|value| value.is_some_and(|value| value >= threshold))
        .collect()
}

fn neighbors(index: usize, width: usize) -> Vec<usize> {
    let row = index / width;
    let column = index % width;
    let mut result = Vec::with_capacity(8);
    for neighbor_row in row.saturating_sub(1)..=(row + 1).min(width - 1) {
        for neighbor_column in column.saturating_sub(1)..=(column + 1).min(width - 1) {
            let neighbor = neighbor_row * width + neighbor_column;
            if neighbor != index {
                result.push(neighbor);
            }
        }
    }
    result
}

fn local_mean(values: &[Option<f64>], index: usize, width: usize, radius: usize) -> Option<f64> {
    let row = index / width;
    let column = index % width;
    let mut sum = 0.0;
    let mut count = 0_u32;
    for local_row in row.saturating_sub(radius)..=(row + radius).min(width - 1) {
        for local_column in column.saturating_sub(radius)..=(column + radius).min(width - 1) {
            if let Some(value) = values[local_row * width + local_column] {
                sum += value;
                count += 1;
            }
        }
    }
    (count > 0).then(|| sum / f64::from(count))
}

fn neighbor_error_correlation(
    exact: &[Option<f64>],
    estimated: &[Option<f64>],
    width: usize,
) -> f64 {
    let errors = exact
        .iter()
        .zip(estimated)
        .map(|(exact, estimated)| match (exact, estimated) {
            (Some(exact), Some(estimated)) => Some(estimated - exact),
            _ => None,
        })
        .collect::<Vec<_>>();
    let valid = errors.iter().flatten().copied().collect::<Vec<_>>();
    if valid.is_empty() {
        return 0.0;
    }
    let mean = valid.iter().sum::<f64>()
        / f64::from(u32::try_from(valid.len()).expect("validation matrix fits u32"));
    let mut product = 0.0;
    let mut left_square = 0.0;
    let mut right_square = 0.0;
    for row in 0..width {
        for column in 0..width {
            let here = row * width + column;
            for neighbor in [
                (column + 1 < width).then_some(here + 1),
                (row + 1 < width).then_some(here + width),
            ]
            .into_iter()
            .flatten()
            {
                if let (Some(left), Some(right)) = (errors[here], errors[neighbor]) {
                    let left = left - mean;
                    let right = right - mean;
                    product += left * right;
                    left_square += left * left;
                    right_square += right * right;
                }
            }
        }
    }
    let scale = (left_square * right_square).sqrt();
    if scale > 0.0 { product / scale } else { 0.0 }
}

fn top_feature_overlap(exact: &[Option<f64>], estimated: &[Option<f64>]) -> f64 {
    let mut exact_rank = exact
        .iter()
        .enumerate()
        .filter_map(|(index, value)| value.map(|value| (index, value)))
        .collect::<Vec<_>>();
    let mut estimated_rank = estimated
        .iter()
        .enumerate()
        .filter_map(|(index, value)| value.map(|value| (index, value)))
        .collect::<Vec<_>>();
    exact_rank.sort_by(|left, right| right.1.total_cmp(&left.1));
    estimated_rank.sort_by(|left, right| right.1.total_cmp(&left.1));
    let count = exact_rank
        .len()
        .min(estimated_rank.len())
        .div_ceil(10)
        .max(1);
    let mut selected = vec![false; exact.len()];
    for &(index, _) in exact_rank.iter().take(count) {
        selected[index] = true;
    }
    let overlap = estimated_rank
        .iter()
        .take(count)
        .filter(|&&(index, _)| selected[index])
        .count();
    ratio(overlap, count)
}

fn component_count(mask: &[bool], width: usize) -> usize {
    let mut visited = vec![false; mask.len()];
    let mut components = 0;
    for start in 0..mask.len() {
        if !mask[start] || visited[start] {
            continue;
        }
        components += 1;
        visited[start] = true;
        let mut pending = std::collections::VecDeque::from([start]);
        while let Some(index) = pending.pop_front() {
            for neighbor in neighbors(index, width) {
                if mask[neighbor] && !visited[neighbor] {
                    visited[neighbor] = true;
                    pending.push_back(neighbor);
                }
            }
        }
    }
    components
}

fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        return 1.0;
    }
    let numerator = u32::try_from(numerator).expect("validation count fits u32");
    let denominator = u32::try_from(denominator).expect("validation count fits u32");
    f64::from(numerator) / f64::from(denominator)
}

fn mean_error(sum: f64, count: usize) -> f64 {
    let count = u32::try_from(count.max(1)).expect("validation count fits u32");
    sum / f64::from(count)
}

fn approximate_score(
    left: &AxisOverview,
    right: &AxisOverview,
    column: usize,
    row: usize,
    registers: usize,
    estimator: OphJaccardEstimator,
) -> Option<f64> {
    let left_score = estimate_containment_bit_sliced_with(
        &left.core_encoded[column],
        &right.expanded_encoded[row],
        K,
        14,
        registers,
        estimator,
    );
    let right_score = estimate_containment_bit_sliced_with(
        &right.core_encoded[row],
        &left.expanded_encoded[column],
        K,
        14,
        registers,
        estimator,
    );
    match (left_score, right_score) {
        (Some(left), Some(right)) => Some(left.ani.max(right.ani)),
        (Some(value), None) | (None, Some(value)) => Some(value.ani),
        (None, None) => None,
    }
}

fn fingerprint_collision_count(
    left: &AxisOverview,
    right: &AxisOverview,
    column: usize,
    row: usize,
    registers: usize,
) -> u64 {
    let encoded_left =
        left.core_encoded[column].compare(&right.expanded_encoded[row], 14, registers);
    let full_left = left.core[column].compare_bbit(&right.expanded[row], 14, registers);
    let encoded_right =
        right.core_encoded[row].compare(&left.expanded_encoded[column], 14, registers);
    let full_right = right.core[row].compare_bbit(&left.expanded[column], 14, registers);
    u64::from(
        encoded_left
            .verified_matches
            .saturating_sub(full_left.verified_matches),
    ) + u64::from(
        encoded_right
            .verified_matches
            .saturating_sub(full_right.verified_matches),
    )
}

fn exact_axis(sequence: &PackedSequence, domain: u64) -> Vec<(ExactKmerSet, ExactKmerSet)> {
    (0..RESOLUTION)
        .map(|bin| {
            let start = boundary(bin * 2, RESOLUTION * 2, domain).min(sequence.len());
            let end = boundary(bin * 2 + 2, RESOLUTION * 2, domain).min(sequence.len());
            let expanded_start =
                boundary((bin * 2).saturating_sub(1), RESOLUTION * 2, domain).min(sequence.len());
            let expanded_end = boundary((bin * 2 + 3).min(RESOLUTION * 2), RESOLUTION * 2, domain)
                .min(sequence.len());
            (
                ExactKmerSet::from_interval(sequence, start, end, K),
                ExactKmerSet::from_interval(sequence, expanded_start, expanded_end, K),
            )
        })
        .collect()
}

fn fixtures() -> Vec<(PackedSequence, PackedSequence)> {
    let random = pseudo_random_sequence(48_000, 1);
    let periodic = (0..48_000)
        .map(|index| b"ACGTTGCAAGTC"[index % 12])
        .collect::<Vec<_>>();
    vec![
        pair("random-99", &random, &mutate_at_rate(&random, 0.01, 11)),
        pair("random-90", &random, &mutate_at_rate(&random, 0.10, 13)),
        pair("random-85", &random, &mutate_at_rate(&random, 0.15, 17)),
        pair("random-80", &random, &mutate_at_rate(&random, 0.20, 19)),
        pair(
            "periodic-90",
            &periodic,
            &mutate_at_rate(&periodic, 0.10, 23),
        ),
        (
            PackedSequence::from_ascii("long", &random),
            PackedSequence::from_ascii("short", &random[..24_000]),
        ),
    ]
}

fn pair(name: &str, left: &[u8], right: &[u8]) -> (PackedSequence, PackedSequence) {
    (
        PackedSequence::from_ascii(format!("{name}-left"), left),
        PackedSequence::from_ascii(format!("{name}-right"), right),
    )
}

fn boundary(index: usize, count: usize, domain: u64) -> u64 {
    u64::try_from(index as u128 * u128::from(domain) / count as u128).unwrap()
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn mutate_at_rate(sequence: &[u8], rate: f64, seed: u64) -> Vec<u8> {
    let threshold = (rate * f64::from(u32::MAX)) as u32;
    sequence
        .iter()
        .enumerate()
        .map(|(index, &base)| {
            let random = splitmix64(seed ^ index as u64);
            let low = u32::from_le_bytes(random.to_le_bytes()[..4].try_into().unwrap());
            if low <= threshold { mutate(base) } else { base }
        })
        .collect()
}

fn pseudo_random_sequence(length: usize, seed: u64) -> Vec<u8> {
    (0..length)
        .map(|index| b"ACGT"[(splitmix64(seed ^ index as u64) & 3) as usize])
        .collect()
}

fn splitmix64(mut value: u64) -> u64 {
    value = value.wrapping_add(0x9e37_79b9_7f4a_7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn mutate(base: u8) -> u8 {
    match base {
        b'A' => b'C',
        b'C' => b'G',
        b'G' => b'T',
        _ => b'A',
    }
}
