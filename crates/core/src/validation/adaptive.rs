//! Statistical policy for validation of the bounded exact sparse-window fallback.

/// ANI floor below which an occasional missed window is acceptable in the interactive plot.
pub const DEFAULT_ANI_FLOOR: f64 = 0.80;

/// Desired probability of observing at least one true matching OPH register at the ANI floor.
pub const DEFAULT_MATCH_DETECTION_PROBABILITY: f64 = 0.99;

/// Maximum distinct canonical hashes retained exactly for one sparse core window.
pub const DEFAULT_EXACT_CORE_CAP: usize = 2_048;

/// Fast first-pass register count used by the browser.
pub const DEFAULT_PREVIEW_REGISTERS: usize = 256;

/// Default background-refinement register count used by the browser.
pub const DEFAULT_DETAILED_REGISTERS: usize = 1_024;

/// Converts a desired nonzero-match probability into a Poisson expected-match threshold.
///
/// For example, 99% requires `-ln(0.01)`, or approximately 4.605 expected matches.
///
/// # Panics
///
/// Panics unless `probability` lies in `[0, 1)`.
pub fn expected_matches_for_probability(probability: f64) -> f64 {
    assert!((0.0..1.0).contains(&probability));
    -(1.0 - probability).ln()
}

/// Expected true OPH register matches at a directed containment floor.
///
/// The occupancy term accounts for an undensified sketch. Cardinalities may be exact
/// or estimated; the model is used as a scheduling decision, not as an accuracy claim.
///
/// # Panics
///
/// Panics if `register_count` does not fit in `u32`; supported browser tiers are at
/// most 4,096 registers.
pub fn expected_oph_matches(
    core_cardinality: f64,
    target_cardinality: f64,
    register_count: usize,
    containment_floor: f64,
) -> f64 {
    if core_cardinality <= 0.0 || target_cardinality <= 0.0 {
        return f64::INFINITY;
    }
    let intersection = containment_floor * core_cardinality;
    if intersection > target_cardinality {
        // This directed comparison cannot attain the requested containment floor.
        return f64::INFINITY;
    }
    let union = core_cardinality + target_cardinality - intersection;
    let registers =
        f64::from(u32::try_from(register_count).expect("a supported register count must fit u32"));
    let load = union / registers;
    let occupied_union_registers = if load >= 20.0 {
        registers
    } else {
        registers * (-load).exp_m1().abs()
    };
    occupied_union_registers * intersection / union
}

/// Poisson probability that an OPH comparison observes at least one true match.
pub fn probability_of_at_least_one_match(expected_matches: f64) -> f64 {
    if expected_matches.is_infinite() {
        return 1.0;
    }
    -(-expected_matches.max(0.0)).exp_m1()
}

/// Whether a retained exact core should replace an underpowered sketch comparison.
///
/// # Panics
///
/// Panics if `core_cardinality` does not fit in `u32`; the production exact cap is
/// 2,048 distinct hashes. It also inherits the register-count constraint from
/// [`expected_oph_matches`].
pub fn needs_exact_correction(
    core_cardinality: usize,
    target_cardinality: f64,
    register_count: usize,
    k: u8,
    ani_floor: f64,
    minimum_detection_probability: f64,
) -> bool {
    let containment_floor = ani_floor.powi(i32::from(k));
    let expected = expected_oph_matches(
        f64::from(
            u32::try_from(core_cardinality).expect("an exact sparse-core cardinality must fit u32"),
        ),
        target_cardinality,
        register_count,
        containment_floor,
    );
    probability_of_at_least_one_match(expected) < minimum_detection_probability
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ninety_nine_percent_threshold_is_four_point_six_matches() {
        let threshold = expected_matches_for_probability(0.99);
        assert!((threshold - 4.605_170_185_988_091).abs() < 1e-12);
        assert!((probability_of_at_least_one_match(threshold) - 0.99).abs() < 1e-12);
    }

    #[test]
    fn equal_dense_windows_match_expected_detection_rates() {
        let containment = DEFAULT_ANI_FLOOR.powi(21);
        let expected_256 = expected_oph_matches(1_000_000.0, 1_000_000.0, 256, containment);
        let expected_1024 = expected_oph_matches(1_000_000.0, 1_000_000.0, 1_024, containment);
        let expected_2048 = expected_oph_matches(1_000_000.0, 1_000_000.0, 2_048, containment);
        assert!((probability_of_at_least_one_match(expected_256) - 0.695).abs() < 0.002);
        assert!(probability_of_at_least_one_match(expected_1024) > 0.99);
        assert!(probability_of_at_least_one_match(expected_2048) > 0.9999);
    }

    #[test]
    fn cardinality_imbalance_can_trigger_exact_fallback() {
        assert!(!needs_exact_correction(
            2_000,
            2_000.0,
            DEFAULT_DETAILED_REGISTERS,
            21,
            DEFAULT_ANI_FLOOR,
            DEFAULT_MATCH_DETECTION_PROBABILITY,
        ));
        assert!(needs_exact_correction(
            2_000,
            20_000.0,
            DEFAULT_DETAILED_REGISTERS,
            21,
            DEFAULT_ANI_FLOOR,
            DEFAULT_MATCH_DETECTION_PROBABILITY,
        ));
    }
}
