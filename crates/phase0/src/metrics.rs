//! Accuracy and directional metrics independent of candidate implementations.

use crate::corpus::ExpectedDirection;
use crate::kernel::{KernelRun, MatrixEstimate};
use moddotplot_core::ExactSimilarity;

/// Aggregated report values for one fixture/kernel pair.
#[derive(Clone, Debug)]
pub struct Metrics {
    /// Cells without an approximate estimate.
    pub missing_cells: usize,
    /// Approximate cells emitted where the exact display contract is missing.
    pub false_present_cells: usize,
    /// Mean absolute ANI error against exact sets.
    pub mean_abs_error: f64,
    /// Median absolute ANI error against exact sets.
    pub p50_abs_error: f64,
    /// 95th percentile absolute ANI error against exact sets.
    pub p95_abs_error: f64,
    /// Maximum absolute ANI error against exact sets.
    pub max_abs_error: f64,
    /// Maximum positive ANI error against exact sets.
    pub max_overestimate: f64,
    /// Cells at or above the frozen useful display floor of 0.80 ANI.
    pub relevant_cells: usize,
    /// Mean absolute raw-containment error among useful-display cells.
    pub relevant_mean_containment_error: f64,
    /// 95th-percentile absolute raw-containment error among useful-display cells.
    pub relevant_p95_containment_error: f64,
    /// Maximum absolute raw-containment error among useful-display cells.
    pub relevant_max_containment_error: f64,
    /// Mean absolute displayed-ANI error among useful-display cells.
    pub relevant_mean_ani_error: f64,
    /// 95th-percentile absolute displayed-ANI error among useful-display cells.
    pub relevant_p95_ani_error: f64,
    /// Maximum absolute displayed-ANI error among useful-display cells.
    pub relevant_max_ani_error: f64,
    /// Column of the maximum absolute-error cell.
    pub worst_column: usize,
    /// Row of the maximum absolute-error cell.
    pub worst_row: usize,
    /// Approximate ANI at the maximum absolute-error cell.
    pub worst_estimate: f64,
    /// Exact ANI at the maximum absolute-error cell.
    pub worst_exact: f64,
    /// Mean absolute ANI delta from the `MashMap` oracle.
    pub mashmap_mean_abs_error: f64,
    /// 95th percentile absolute ANI delta from the `MashMap` oracle.
    pub mashmap_p95_abs_error: f64,
    /// Total unambiguous same-orientation votes.
    pub forward_votes: u64,
    /// Total unambiguous opposite-orientation votes.
    pub reverse_votes: u64,
    /// Total ambiguous votes.
    pub ambiguous_votes: u64,
    /// Corresponding diagonal cells with the expected dominant direction.
    pub direction_correct_cells: usize,
    /// Corresponding diagonal cells with informative direction evidence.
    pub direction_tested_cells: usize,
}

/// Summarizes one candidate against both frozen oracles.
pub fn summarize(
    run: &KernelRun,
    exact: &[Option<ExactSimilarity>],
    mashmap: &MatrixEstimate,
    resolution: usize,
    expected_direction: ExpectedDirection,
) -> Metrics {
    assert_eq!(run.matrix.identity.len(), exact.len());
    assert_eq!(run.matrix.containment.len(), exact.len());
    assert_eq!(run.matrix.identity.len(), mashmap.identity.len());
    let mut exact_errors = Vec::new();
    let mut mashmap_errors = Vec::new();
    let mut relevant_containment_errors = Vec::new();
    let mut relevant_ani_errors = Vec::new();
    let mut missing_cells = 0;
    let mut false_present_cells = 0;
    let mut max_overestimate = 0.0_f64;
    let mut worst = (0.0_f64, 0_usize, f64::NAN, f64::NAN);
    for (index, (((estimate, containment), exact), mashmap)) in run
        .matrix
        .identity
        .iter()
        .zip(&run.matrix.containment)
        .zip(exact)
        .zip(&mashmap.identity)
        .enumerate()
    {
        match (estimate, exact) {
            (Some(estimate), Some(exact)) => {
                let absolute = (estimate - exact.ani).abs();
                exact_errors.push(absolute);
                if exact.ani >= 0.80 {
                    let containment = containment
                        .expect("an ANI estimate must carry the same cell's containment");
                    relevant_containment_errors.push((containment - exact.containment).abs());
                    relevant_ani_errors.push(absolute);
                }
                max_overestimate = max_overestimate.max(estimate - exact.ani);
                if absolute > worst.0 {
                    worst = (absolute, index, *estimate, exact.ani);
                }
            }
            (None, Some(_)) => missing_cells += 1,
            (Some(_), None) => false_present_cells += 1,
            _ => {}
        }
        if let (Some(estimate), Some(mashmap)) = (estimate, mashmap) {
            mashmap_errors.push((estimate - mashmap).abs());
        }
    }
    exact_errors.sort_by(f64::total_cmp);
    mashmap_errors.sort_by(f64::total_cmp);
    relevant_containment_errors.sort_by(f64::total_cmp);
    relevant_ani_errors.sort_by(f64::total_cmp);
    let (votes, correct_cells, tested_cells) =
        summarize_direction(run, resolution, expected_direction);
    Metrics {
        missing_cells,
        false_present_cells,
        mean_abs_error: mean(&exact_errors),
        p50_abs_error: percentile(&exact_errors, 50),
        p95_abs_error: percentile(&exact_errors, 95),
        max_abs_error: exact_errors.last().copied().unwrap_or(f64::NAN),
        max_overestimate,
        relevant_cells: relevant_ani_errors.len(),
        relevant_mean_containment_error: mean(&relevant_containment_errors),
        relevant_p95_containment_error: percentile(&relevant_containment_errors, 95),
        relevant_max_containment_error: relevant_containment_errors
            .last()
            .copied()
            .unwrap_or(f64::NAN),
        relevant_mean_ani_error: mean(&relevant_ani_errors),
        relevant_p95_ani_error: percentile(&relevant_ani_errors, 95),
        relevant_max_ani_error: relevant_ani_errors.last().copied().unwrap_or(f64::NAN),
        worst_column: worst.1 % resolution,
        worst_row: worst.1 / resolution,
        worst_estimate: worst.2,
        worst_exact: worst.3,
        mashmap_mean_abs_error: mean(&mashmap_errors),
        mashmap_p95_abs_error: percentile(&mashmap_errors, 95),
        forward_votes: votes.0,
        reverse_votes: votes.1,
        ambiguous_votes: votes.2,
        direction_correct_cells: correct_cells,
        direction_tested_cells: tested_cells,
    }
}

fn summarize_direction(
    run: &KernelRun,
    resolution: usize,
    expected: ExpectedDirection,
) -> ((u64, u64, u64), usize, usize) {
    let votes = run.matrix.direction.iter().fold(
        (0_u64, 0_u64, 0_u64),
        |(forward, reverse, ambiguous), evidence| {
            (
                forward + u64::from(evidence.forward),
                reverse + u64::from(evidence.reverse),
                ambiguous + u64::from(evidence.ambiguous),
            )
        },
    );
    let cells = match expected {
        ExpectedDirection::MixedOrNone => (0, 0),
        ExpectedDirection::Forward | ExpectedDirection::Reverse => {
            (0..resolution).fold((0, 0), |(correct, tested), index| {
                let evidence = run.matrix.direction[index * resolution + index];
                let Some(signed) = evidence.signed() else {
                    return (correct, tested);
                };
                let correct_direction = match expected {
                    ExpectedDirection::Forward => signed > 0.0,
                    ExpectedDirection::Reverse => signed < 0.0,
                    ExpectedDirection::MixedOrNone => unreachable!(),
                };
                (correct + usize::from(correct_direction), tested + 1)
            })
        }
    };
    (votes, cells.0, cells.1)
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        return f64::NAN;
    }
    values.iter().sum::<f64>() / f64::from(u32::try_from(values.len()).expect("sample fits u32"))
}

fn percentile(values: &[f64], percentile: usize) -> f64 {
    if values.is_empty() {
        return f64::NAN;
    }
    values[(values.len() * percentile / 100).min(values.len() - 1)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentile_uses_sorted_nearest_rank_index() {
        let values = [0.0, 0.1, 0.2, 0.3, 0.4];
        assert!((percentile(&values, 50) - 0.2).abs() < f64::EPSILON);
        assert!((percentile(&values, 95) - 0.4).abs() < f64::EPSILON);
    }
}
