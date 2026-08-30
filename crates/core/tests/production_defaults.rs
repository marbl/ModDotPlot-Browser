//! Assertion-backed acceptance for the exact browser-default production path.

#[cfg(feature = "validation")]
use moddotplot_core::validation::{SparseCorrectionPolicy, compute_frozen_tile_adaptive};
use moddotplot_core::{
    DEFAULT_B_BITS, ExactKmerSet, FrozenAxis, MatrixTile, PackedSequence, ScientificConfig,
    TileRequest, build_axis_overview, compute_frozen_tile, estimate_containment_bit_sliced,
    exact_moddotplot_score,
};
#[cfg(feature = "validation")]
use std::time::Instant;

const K: u8 = 21;
const RESOLUTION: usize = 12;
const THRESHOLDS: [f64; 4] = [0.80, 0.85, 0.90, 0.95];

#[derive(Clone, Copy, Default)]
struct Confusion {
    false_negative: usize,
    false_positive: usize,
}

#[derive(Default)]
struct AcceptanceMetrics {
    ani_c_errors: Vec<f64>,
    confusion: [Confusion; THRESHOLDS.len()],
    valid_cells: usize,
    missing_disagreements: usize,
}

impl AcceptanceMetrics {
    fn record(&mut self, exact: Option<(f64, f64)>, estimated: Option<(f64, f64)>) {
        match (exact, estimated) {
            (Some((_, exact_ani_c)), Some((_, estimated_ani_c))) => {
                self.valid_cells += 1;
                for (index, threshold) in THRESHOLDS.into_iter().enumerate() {
                    self.confusion[index].false_negative +=
                        usize::from(exact_ani_c >= threshold && estimated_ani_c < threshold);
                    self.confusion[index].false_positive +=
                        usize::from(exact_ani_c < threshold && estimated_ani_c >= threshold);
                }
                if exact_ani_c >= THRESHOLDS[0] {
                    self.ani_c_errors
                        .push((estimated_ani_c - exact_ani_c).abs());
                }
            }
            (None, None) => {}
            _ => self.missing_disagreements += 1,
        }
    }

    fn assert_within(&mut self, registers: usize) {
        self.ani_c_errors.sort_by(f64::total_cmp);
        assert!(!self.ani_c_errors.is_empty());
        assert_eq!(self.missing_disagreements, 0);

        let relevant = self.ani_c_errors.len();
        let mean_ani_c = mean(&self.ani_c_errors);
        let p95_ani_c = percentile(&self.ani_c_errors, 95);
        let (mean_ani_c_limit, p95_ani_c_limit, visibility_crossing_percent) = if registers == 256 {
            (0.050, 0.300, 10)
        } else {
            (0.010, 0.040, 5)
        };
        assert!(
            mean_ani_c <= mean_ani_c_limit,
            "{registers}-register mean ANI_c error {mean_ani_c:.6} exceeded {mean_ani_c_limit:.3}",
        );
        assert!(
            p95_ani_c <= p95_ani_c_limit,
            "{registers}-register P95 ANI_c error {p95_ani_c:.6} exceeded {p95_ani_c_limit:.3}",
        );
        let crossing_limit = (self.valid_cells * visibility_crossing_percent).div_ceil(100);
        for (threshold, confusion) in THRESHOLDS.into_iter().zip(self.confusion) {
            let crossings = confusion.false_negative + confusion.false_positive;
            eprintln!(
                "registers={registers} threshold={threshold:.2} false_negative={} false_positive={} crossing_rate={:.6}",
                confusion.false_negative,
                confusion.false_positive,
                count_as_f64(crossings) / count_as_f64(self.valid_cells),
            );
        }
        let visibility_crossings =
            self.confusion[0].false_negative + self.confusion[0].false_positive;
        eprintln!(
            "registers={registers} relevant={relevant} valid={} mean_abs_ani_c={mean_ani_c:.6} p95_abs_ani_c={p95_ani_c:.6}",
            self.valid_cells,
        );
        assert!(
            visibility_crossings <= crossing_limit,
            "{registers}-register ANI_c 0.80 crossing count {visibility_crossings} exceeded {crossing_limit}",
        );
    }
}

#[test]
fn browser_default_production_tiles_track_exact_kmer_containment() {
    let mut results = Vec::new();
    for registers in [256, 1_024] {
        let mut combined = AcceptanceMetrics::default();
        for (left, right) in fixtures() {
            evaluate_fixture(&left, &right, RESOLUTION, registers, &mut combined);
        }
        results.push((registers, combined));
    }
    for (registers, mut metrics) in results {
        metrics.assert_within(registers);
    }
}

#[test]
fn browser_default_direction_sign_matches_controlled_orientation() {
    let left_bases = pseudo_random_sequence(48_000, 0x51a7);
    let forward_bases = mutate_at_rate(&left_bases, 0.01, 0x1234);
    let reverse_bases = reverse_complement(&left_bases);
    let left = PackedSequence::from_ascii("direction-left", &left_bases);
    let forward = PackedSequence::from_ascii("direction-forward", &forward_bases);
    let reverse = PackedSequence::from_ascii("direction-reverse", &reverse_bases);

    for registers in [256, 1_024] {
        let forward_tile = production_tile(&left, &forward, RESOLUTION, registers).2;
        let reverse_tile = production_tile(&left, &reverse, RESOLUTION, registers).2;
        for index in 0..RESOLUTION {
            let forward_cell = index * RESOLUTION + index;
            assert!(forward_tile.identity[forward_cell] >= 9_500);
            assert!(forward_tile.direction_support[forward_cell] > 0);
            assert!(forward_tile.direction[forward_cell] > 0);

            let reverse_cell = (RESOLUTION - index - 1) * RESOLUTION + index;
            assert!(reverse_tile.identity[reverse_cell] >= 9_500);
            assert!(reverse_tile.direction_support[reverse_cell] > 0);
            assert!(reverse_tile.direction[reverse_cell] < 0);
        }
    }
}

#[test]
fn schema_1_numeric_fixture_matches_v0_2_1_bytes() {
    let left_bases = pseudo_random_sequence(48_000, 0x0210_0300);
    let right_bases = mutate_at_rate(&left_bases, 0.07, 0x0210_0301);
    let left = PackedSequence::from_ascii("schema-1-left", &left_bases);
    let right = PackedSequence::from_ascii("schema-1-right", &right_bases);
    for (registers, expected) in [
        (256, 6_287_528_316_830_669_084_u64),
        (1_024, 15_310_234_810_913_278_692_u64),
    ] {
        let tile = production_tile(&left, &right, RESOLUTION, registers).2;
        assert_eq!(tile_digest(&tile), expected, "registers={registers}");
    }
}

#[test]
fn current_selective_composite_is_bounded_against_all_detailed_output() {
    const COMPOSITE_RESOLUTION: usize = 24;
    const CHARACTERIZATION_TILE_EDGE: usize = 4;
    assert_scheduler_contract_is_current();
    let random = pseudo_random_sequence(48_000, 0xa11d);
    let periodic = (0..48_000)
        .map(|index| b"ACGTTGCAAGTC"[index % 12])
        .collect::<Vec<_>>();
    let mut aggregate_refined_tiles = 0_usize;
    let mut aggregate_all_detail_tiles = 0_usize;
    let mut aggregate_last_visible_change = 0_usize;
    for (left_bases, right_bases) in [
        (random.clone(), mutate_at_rate(&random, 0.01, 0xc001)),
        (random.clone(), mutate_at_rate(&random, 0.10, 0xc002)),
        (periodic.clone(), mutate_at_rate(&periodic, 0.10, 0xc003)),
    ] {
        let left = PackedSequence::from_ascii("composite-left", &left_bases);
        let right = PackedSequence::from_ascii("composite-right", &right_bases);
        let (_, _, preview) = production_tile(&left, &right, COMPOSITE_RESOLUTION, 256);
        let (left_detailed, right_detailed, detailed) =
            production_tile(&left, &right, COMPOSITE_RESOLUTION, 1_024);
        let exact = exact_matrix(&left, &right, COMPOSITE_RESOLUTION);
        assert_first_coherent_structure(&preview, &exact);
        let (composite, refined_tiles, last_visible_change) =
            selective_composite(&preview, &detailed, CHARACTERIZATION_TILE_EDGE);
        assert_composite(&composite, &detailed, &exact);
        let total_tiles = COMPOSITE_RESOLUTION
            .div_ceil(CHARACTERIZATION_TILE_EDGE)
            .pow(2);
        aggregate_refined_tiles += refined_tiles;
        aggregate_all_detail_tiles += total_tiles;
        aggregate_last_visible_change += last_visible_change;
        assert!(
            last_visible_change < refined_tiles,
            "scheduler must finish visible corrections before its final selected tile"
        );

        // Keep the complete detailed axes live through the comparison so the test
        // exercises the same frozen production representation as the browser.
        assert_eq!(left_detailed.resolution(), COMPOSITE_RESOLUTION);
        assert_eq!(right_detailed.resolution(), COMPOSITE_RESOLUTION);
    }
    assert!(
        aggregate_refined_tiles * 100 <= aggregate_all_detail_tiles * 80,
        "scheduler refined {aggregate_refined_tiles}/{aggregate_all_detail_tiles} tiles"
    );
    eprintln!(
        "scheduler_refined_tiles={aggregate_refined_tiles}\tall_detail_tiles={aggregate_all_detail_tiles}\twork_fraction={:.6}\tlast_visible_change_sum={aggregate_last_visible_change}",
        count_as_f64(aggregate_refined_tiles) / count_as_f64(aggregate_all_detail_tiles),
    );
}

#[test]
#[cfg(feature = "validation")]
#[ignore = "diagnostic for an explicit sparse-policy decision"]
fn report_sparse_correction_effect_on_repeat_ani_c() {
    let periodic = (0..48_000)
        .map(|index| b"ACGTTGCAAGTC"[index % 12])
        .collect::<Vec<_>>();
    let mutated = mutate_at_rate(&periodic, 0.10, 23);
    let left = PackedSequence::from_ascii("periodic-left", &periodic);
    let right = PackedSequence::from_ascii("periodic-right", &mutated);
    let exact = exact_matrix(&left, &right, RESOLUTION);
    for registers in [256, 1_024] {
        let config = ScientificConfig::production_default(K, registers, true).unwrap();
        let domain = left.len().max(right.len());
        let left_axis = build_axis_overview(&left, domain, RESOLUTION, config)
            .unwrap()
            .freeze();
        let right_axis = build_axis_overview(&right, domain, RESOLUTION, config)
            .unwrap()
            .freeze();
        let tile = compute_frozen_tile_adaptive(
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
        let mut ani_c_errors = Vec::new();
        for (index, exact_score) in exact.iter().enumerate() {
            let Some((_, exact_ani_c)) = exact_score else {
                continue;
            };
            if *exact_ani_c < 0.80 || tile.identity[index] == u16::MAX {
                continue;
            }
            let estimated_ani_c = f64::from(tile.identity[index]) / 10_000.0;
            ani_c_errors.push((estimated_ani_c - exact_ani_c).abs());
        }
        ani_c_errors.sort_by(f64::total_cmp);
        eprintln!(
            "sparse=true registers={registers} mean_abs_ani_c={:.6} p95_abs_ani_c={:.6}",
            mean(&ani_c_errors),
            percentile(&ani_c_errors, 95),
        );
    }
}

#[test]
#[cfg(feature = "validation")]
#[ignore = "explicit sparse-policy runtime benchmark"]
fn report_sparse_correction_runtime_cost() {
    const LENGTH: usize = 2_000_000;
    const BENCHMARK_RESOLUTION: usize = 128;
    let random = pseudo_random_sequence(LENGTH, 0x5eed);
    let periodic = (0..LENGTH)
        .map(|index| b"ACGTTGCAAGTC"[index % 12])
        .collect::<Vec<_>>();
    for (label, left_bases, mutation_seed) in
        [("dense", random, 0xd35e), ("periodic", periodic, 0x7eae)]
    {
        let right_bases = mutate_at_rate(&left_bases, 0.10, mutation_seed);
        let left = PackedSequence::from_ascii(format!("{label}-left"), &left_bases);
        let right = PackedSequence::from_ascii(format!("{label}-right"), &right_bases);
        for registers in [256, 1_024] {
            for sparse in [false, true] {
                let mut build_times = Vec::new();
                let mut matrix_times = Vec::new();
                let mut retained_bytes = 0;
                for _ in 0..5 {
                    let config =
                        ScientificConfig::production_default(K, registers, sparse).unwrap();
                    let started = Instant::now();
                    let left_axis = build_axis_overview(
                        &left,
                        left.len().max(right.len()),
                        BENCHMARK_RESOLUTION,
                        config,
                    )
                    .unwrap()
                    .freeze();
                    let right_axis = build_axis_overview(
                        &right,
                        left.len().max(right.len()),
                        BENCHMARK_RESOLUTION,
                        config,
                    )
                    .unwrap()
                    .freeze();
                    build_times.push(started.elapsed().as_secs_f64() * 1_000.0);
                    retained_bytes = left_axis
                        .estimated_heap_bytes()
                        .saturating_add(right_axis.estimated_heap_bytes());

                    let request = TileRequest {
                        x_start: 0,
                        y_start: 0,
                        width: BENCHMARK_RESOLUTION,
                        height: BENCHMARK_RESOLUTION,
                    };
                    let started = Instant::now();
                    let tile = if sparse {
                        compute_frozen_tile_adaptive(
                            &left_axis,
                            &right_axis,
                            &left,
                            &right,
                            config.hash_algorithm(),
                            config.hash_seed(),
                            request,
                            SparseCorrectionPolicy {
                                ani_floor: config.ani_floor(),
                                minimum_detection_probability: config
                                    .minimum_detection_probability(),
                            },
                        )
                        .unwrap()
                    } else {
                        compute_frozen_tile(&left_axis, &right_axis, request).unwrap()
                    };
                    matrix_times.push(started.elapsed().as_secs_f64() * 1_000.0);
                    std::hint::black_box(tile.identity[tile.identity.len() / 2]);
                }
                build_times.sort_by(f64::total_cmp);
                matrix_times.sort_by(f64::total_cmp);
                eprintln!(
                    "case={label} registers={registers} sparse={sparse} build_median_ms={:.3} matrix_median_ms={:.3} retained_mib={:.3}",
                    build_times[build_times.len() / 2],
                    matrix_times[matrix_times.len() / 2],
                    count_as_f64(retained_bytes) / 1024.0 / 1024.0,
                );
            }
        }
    }
}

fn evaluate_fixture(
    left: &PackedSequence,
    right: &PackedSequence,
    resolution: usize,
    registers: usize,
    metrics: &mut AcceptanceMetrics,
) {
    let starting_ani_c_errors = metrics.ani_c_errors.len();
    let (left_axis, right_axis, tile) = production_tile(left, right, resolution, registers);
    let exact = exact_matrix(left, right, resolution);
    for row in 0..resolution {
        for column in 0..resolution {
            let index = row * resolution + column;
            let estimated = approximate_max_containment(&left_axis, &right_axis, column, row);
            let exact_score = exact[index];
            metrics.record(exact_score, estimated);
            match estimated {
                Some((_, ani_c)) => {
                    assert_eq!(tile.identity[index], encode_ani_c(ani_c));
                }
                None => assert_eq!(tile.identity[index], u16::MAX),
            }
        }
    }
    let ani_c_errors = &metrics.ani_c_errors[starting_ani_c_errors..];
    if !ani_c_errors.is_empty() {
        eprintln!(
            "fixture={} registers={registers} relevant={} mean_abs_ani_c={:.6}",
            left.name(),
            ani_c_errors.len(),
            mean(ani_c_errors),
        );
    }
}

fn production_tile(
    left: &PackedSequence,
    right: &PackedSequence,
    resolution: usize,
    registers: usize,
) -> (FrozenAxis, FrozenAxis, MatrixTile) {
    let domain = left.len().max(right.len());
    let config = ScientificConfig::production_default(K, registers, false).unwrap();
    assert_eq!(config.hll_precision(), 10);
    assert_eq!(config.sparse_core_cap(), 0);
    let left_axis = build_axis_overview(left, domain, resolution, config)
        .unwrap()
        .freeze();
    let right_axis = build_axis_overview(right, domain, resolution, config)
        .unwrap()
        .freeze();
    let tile = compute_frozen_tile(
        &left_axis,
        &right_axis,
        TileRequest {
            x_start: 0,
            y_start: 0,
            width: resolution,
            height: resolution,
        },
    )
    .unwrap();
    (left_axis, right_axis, tile)
}

fn approximate_max_containment(
    left: &FrozenAxis,
    right: &FrozenAxis,
    column: usize,
    row: usize,
) -> Option<(f64, f64)> {
    if left.core_encoded()[column].observations() == 0
        || right.core_encoded()[row].observations() == 0
    {
        return None;
    }
    let registers = left.core_encoded()[column].register_count();
    let left_score = estimate_containment_bit_sliced(
        &left.core_encoded()[column],
        &right.expanded_encoded()[row],
        K,
        DEFAULT_B_BITS,
        registers,
    );
    let right_score = estimate_containment_bit_sliced(
        &right.core_encoded()[row],
        &left.expanded_encoded()[column],
        K,
        DEFAULT_B_BITS,
        registers,
    );
    match (left_score, right_score) {
        (Some(left), Some(right)) => {
            let selected = if left.containment >= right.containment {
                left
            } else {
                right
            };
            Some((selected.containment, selected.ani))
        }
        (Some(value), None) | (None, Some(value)) => Some((value.containment, value.ani)),
        (None, None) => None,
    }
}

fn exact_matrix(
    left: &PackedSequence,
    right: &PackedSequence,
    resolution: usize,
) -> Vec<Option<(f64, f64)>> {
    let domain = left.len().max(right.len());
    let left_exact = exact_axis(left, domain, resolution);
    let right_exact = exact_axis(right, domain, resolution);
    right_exact
        .iter()
        .flat_map(|right_sets| {
            left_exact.iter().map(move |left_sets| {
                if left_sets.0.is_empty() || right_sets.0.is_empty() {
                    return None;
                }
                exact_moddotplot_score(&left_sets.0, &left_sets.1, &right_sets.0, &right_sets.1, K)
                    .map(|score| (score.containment, score.ani))
            })
        })
        .collect()
}

fn exact_axis(
    sequence: &PackedSequence,
    domain: u64,
    resolution: usize,
) -> Vec<(ExactKmerSet, ExactKmerSet)> {
    (0..resolution)
        .map(|bin| {
            let start = boundary(bin * 2, resolution * 2, domain).min(sequence.len());
            let end = boundary(bin * 2 + 2, resolution * 2, domain).min(sequence.len());
            let expanded_start =
                boundary((bin * 2).saturating_sub(1), resolution * 2, domain).min(sequence.len());
            let expanded_end = boundary((bin * 2 + 3).min(resolution * 2), resolution * 2, domain)
                .min(sequence.len());
            (
                ExactKmerSet::from_interval(sequence, start, end, K),
                ExactKmerSet::from_interval(sequence, expanded_start, expanded_end, K),
            )
        })
        .collect()
}

fn selective_composite(
    preview: &MatrixTile,
    detailed: &MatrixTile,
    tile_edge: usize,
) -> (MatrixTile, usize, usize) {
    assert_eq!(
        (preview.width, preview.height),
        (detailed.width, detailed.height)
    );
    let mut composite = MatrixTile {
        width: preview.width,
        height: preview.height,
        identity: preview.identity.clone(),
        direction: preview.direction.clone(),
        direction_support: preview.direction_support.clone(),
    };
    let tile_columns = preview.width.div_ceil(tile_edge);
    let selected = scheduler_order(preview, tile_edge);
    let mut refined_tiles = 0;
    let mut last_visible_change = 0;
    for selected_index in selected {
        let tile_y = selected_index / tile_columns;
        let tile_x = selected_index % tile_columns;
        refined_tiles += 1;
        let y = tile_y * tile_edge;
        let x = tile_x * tile_edge;
        let width = tile_edge.min(preview.width - x);
        let height = tile_edge.min(preview.height - y);
        let visible_change = (0..height).any(|row| {
            (0..width).any(|column| {
                let index = (y + row) * preview.width + x + column;
                (preview.identity[index] >= 8_500) != (detailed.identity[index] >= 8_500)
            })
        });
        if visible_change {
            last_visible_change = refined_tiles;
        }
        for row in 0..height {
            let start = (y + row) * preview.width + x;
            let end = start + width;
            composite.identity[start..end].copy_from_slice(&detailed.identity[start..end]);
            composite.direction[start..end].copy_from_slice(&detailed.direction[start..end]);
            composite.direction_support[start..end]
                .copy_from_slice(&detailed.direction_support[start..end]);
        }
    }
    (composite, refined_tiles, last_visible_change)
}

fn scheduler_order(preview: &MatrixTile, tile_edge: usize) -> Vec<usize> {
    let tile_columns = preview.width.div_ceil(tile_edge);
    let tile_rows = preview.height.div_ceil(tile_edge);
    let mut scores = vec![0.0_f64; tile_columns * tile_rows];
    for tile_y in 0..tile_rows {
        for tile_x in 0..tile_columns {
            let y = tile_y * tile_edge;
            let x = tile_x * tile_edge;
            let width = tile_edge.min(preview.width - x);
            let height = tile_edge.min(preview.height - y);
            let mut non_missing = 0_usize;
            let mut missing = 0_usize;
            let mut maximum_identity = 0_u16;
            let mut identity_histogram = [0_usize; 101];
            let mut low_support_histogram = [0_usize; 101];
            for row in 0..height {
                for column in 0..width {
                    let index = (y + row) * preview.width + x + column;
                    let identity = preview.identity[index];
                    if identity == u16::MAX {
                        missing += 1;
                        continue;
                    }
                    non_missing += 1;
                    maximum_identity = maximum_identity.max(identity);
                    let bin = usize::from(identity / 100).min(100);
                    identity_histogram[bin] += 1;
                    if preview.direction_support[index] < 8 {
                        low_support_histogram[bin] += 1;
                    }
                }
            }
            if non_missing > 0 {
                let decision_cells = identity_histogram[80..=90].iter().sum::<usize>();
                let low_support_cells = low_support_histogram[80..=100].iter().sum::<usize>();
                let decision_score = if decision_cells >= 2.max(non_missing.div_ceil(100)) {
                    1.0 + count_as_f64(decision_cells) / count_as_f64(non_missing)
                } else {
                    0.0
                };
                let support_score =
                    if low_support_cells >= 2.max((non_missing * 25).div_ceil(10_000)) {
                        0.5 + count_as_f64(low_support_cells) / count_as_f64(non_missing)
                    } else {
                        0.0
                    };
                let missing_score = if maximum_identity >= 8_000 {
                    count_as_f64(missing) / count_as_f64(non_missing + missing) * 0.25
                } else {
                    0.0
                };
                scores[tile_y * tile_columns + tile_x] =
                    decision_score + support_score + missing_score;
            }
        }
    }
    let direct = scores.clone();
    for tile_y in 0..tile_rows {
        for tile_x in 0..tile_columns {
            let direct_score = direct[tile_y * tile_columns + tile_x];
            if direct_score <= 0.0 {
                continue;
            }
            for neighbor_y in tile_y.saturating_sub(1)..=(tile_y + 1).min(tile_rows - 1) {
                for neighbor_x in tile_x.saturating_sub(1)..=(tile_x + 1).min(tile_columns - 1) {
                    let index = neighbor_y * tile_columns + neighbor_x;
                    scores[index] = scores[index].max(direct_score * 0.25);
                }
            }
        }
    }
    for tile_y in 0..tile_rows {
        for tile_x in 0..tile_columns {
            if (tile_x + 3 * tile_y + preview.width).is_multiple_of(16) {
                let index = tile_y * tile_columns + tile_x;
                scores[index] = scores[index].max(0.05);
            }
        }
    }
    let mut selected = scores
        .iter()
        .enumerate()
        .filter_map(|(index, score)| (*score > 0.0).then_some(index))
        .collect::<Vec<_>>();
    selected.sort_by(|left, right| {
        scores[*right]
            .total_cmp(&scores[*left])
            .then_with(|| (left / tile_columns).cmp(&(right / tile_columns)))
            .then_with(|| (left % tile_columns).cmp(&(right % tile_columns)))
    });
    selected
}

fn assert_scheduler_contract_is_current() {
    let implementation = include_str!("../../../web/src/refinement.ts");
    for declaration in [
        "export const REFINEMENT_POLICY_VERSION = 2;",
        "export const REFINEMENT_DISPLAY_MARGIN = 500;",
        "export const REFINEMENT_MIN_SUPPORT = 8;",
        "export const REFINEMENT_EXPLORATION_MODULUS = 16;",
    ] {
        assert!(implementation.contains(declaration));
    }
}

fn assert_first_coherent_structure(preview: &MatrixTile, exact: &[Option<(f64, f64)>]) {
    let mut exact_visible = 0;
    let mut preview_visible = 0;
    for (index, score) in exact.iter().enumerate() {
        if score.is_some_and(|(_, ani_c)| ani_c >= 0.85) {
            exact_visible += 1;
            preview_visible += usize::from(preview.identity[index] >= 8_000);
        }
    }
    assert!(exact_visible > 0);
    assert!(preview_visible * 100 >= exact_visible * 80);
}

fn assert_composite(composite: &MatrixTile, detailed: &MatrixTile, exact: &[Option<(f64, f64)>]) {
    let mut differences = Vec::new();
    let mut valid = 0_usize;
    let mut visibility_crossings = 0;
    for (index, exact_score) in exact.iter().enumerate() {
        let composite_value = composite.identity[index];
        let detailed_value = detailed.identity[index];
        assert_eq!(composite_value == u16::MAX, detailed_value == u16::MAX);
        if let Some((_, exact_ani_c)) = exact_score {
            valid += 1;
            if *exact_ani_c >= THRESHOLDS[0] {
                differences.push(
                    (f64::from(composite_value) - f64::from(detailed_value)).abs() / 10_000.0,
                );
            }
            let visibility_floor = THRESHOLDS[0] * 10_000.0;
            visibility_crossings += usize::from(
                (f64::from(detailed_value) >= visibility_floor)
                    != (f64::from(composite_value) >= visibility_floor),
            );
        }
    }
    differences.sort_by(f64::total_cmp);
    assert!(mean(&differences) <= 0.030);
    assert!(percentile(&differences, 95) <= 0.100);
    let crossing_limit = (valid * 2).div_ceil(100);
    assert!(visibility_crossings <= crossing_limit);
}

fn fixtures() -> Vec<(PackedSequence, PackedSequence)> {
    let mut fixtures = Vec::new();
    for realization in [1, 0x22, 0x33, 0x44] {
        let random = pseudo_random_sequence(48_000, realization);
        for (label, rate, mutation_seed) in [("99", 0.01, 11), ("90", 0.10, 13), ("80", 0.20, 19)] {
            fixtures.push(pair(
                &format!("point-{realization:x}-{label}"),
                &random,
                &mutate_at_rate(&random, rate, mutation_seed ^ realization),
            ));
        }
    }
    let random = pseudo_random_sequence(48_000, 1);
    let periodic = (0..48_000)
        .map(|index| b"ACGTTGCAAGTC"[index % 12])
        .collect::<Vec<_>>();
    let tandem_motif = pseudo_random_sequence(257, 0x7a6d);
    let tandem = (0..48_000)
        .map(|index| tandem_motif[index % tandem_motif.len()])
        .collect::<Vec<_>>();
    let mut ambiguous = mutate_at_rate(&random, 0.05, 0xa6b1);
    for index in (97..ambiguous.len()).step_by(97) {
        ambiguous[index] = b'N';
    }
    let mut deletion = random.clone();
    deletion.drain(16_000..20_000);
    let mut insertion = random[..24_000].to_vec();
    insertion.extend(pseudo_random_sequence(4_000, 0x1a5e));
    insertion.extend_from_slice(&random[24_000..]);
    let mut inversion = random.clone();
    inversion[16_000..32_000].copy_from_slice(&reverse_complement(&random[16_000..32_000]));
    let mut offset = pseudo_random_sequence(4_000, 0x000f_f5e7);
    offset.extend_from_slice(&random);
    fixtures.extend([
        pair("point-85", &random, &mutate_at_rate(&random, 0.15, 17)),
        pair(
            "periodic-90",
            &periodic,
            &mutate_at_rate(&periodic, 0.10, 23),
        ),
        pair("tandem-90", &tandem, &mutate_at_rate(&tandem, 0.10, 29)),
        pair("ambiguity", &random, &ambiguous),
        pair("large-deletion", &random, &deletion),
        pair("large-insertion", &random, &insertion),
        pair("segment-inversion", &random, &inversion),
        pair("coordinate-offset", &random, &offset),
        (
            PackedSequence::from_ascii("cardinality-long", &random),
            PackedSequence::from_ascii("cardinality-quarter", &random[..12_000]),
        ),
    ]);
    fixtures
}

fn pair(name: &str, left: &[u8], right: &[u8]) -> (PackedSequence, PackedSequence) {
    (
        PackedSequence::from_ascii(format!("{name}-left"), left),
        PackedSequence::from_ascii(format!("{name}-right"), right),
    )
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn encode_ani_c(value: f64) -> u16 {
    (value.clamp(0.0, 1.0) * 10_000.0).round() as u16
}

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / count_as_f64(values.len())
}

fn percentile(values: &[f64], percentile: usize) -> f64 {
    values[(values.len().saturating_sub(1) * percentile) / 100]
}

fn count_as_f64(count: usize) -> f64 {
    f64::from(u32::try_from(count).expect("bounded validation count fits u32"))
}

fn tile_digest(tile: &MatrixTile) -> u64 {
    let mut digest = 0xcbf2_9ce4_8422_2325_u64;
    for byte in tile
        .identity
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .chain(tile.direction.iter().flat_map(|value| value.to_le_bytes()))
        .chain(
            tile.direction_support
                .iter()
                .flat_map(|value| value.to_le_bytes()),
        )
    {
        digest ^= u64::from(byte);
        digest = digest.wrapping_mul(0x0000_0100_0000_01b3);
    }
    digest
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

fn reverse_complement(sequence: &[u8]) -> Vec<u8> {
    sequence
        .iter()
        .rev()
        .map(|base| match base {
            b'A' => b'T',
            b'C' => b'G',
            b'G' => b'C',
            _ => b'A',
        })
        .collect()
}
