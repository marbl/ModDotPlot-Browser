//! Stable serialization for the frozen direct-OPH backend decision.

use crate::config::BenchmarkConfig;
use crate::kernel::{AdaptiveConfig, HashRun, KernelRun};
use crate::metrics::Metrics;
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::Path;

/// Schema version governed by `docs/benchmarks/backend-contract-v1.md`.
pub const BACKEND_SCHEMA_VERSION: &str = "backend-v1";

/// Schema version governed by `docs/benchmarks/backend-contract-v2.md`.
pub const ADAPTIVE_SCHEMA_VERSION: &str = "backend-v2";

/// Complete backend report in deterministic fixture/hash/tier order.
#[derive(Debug)]
pub struct BackendReport {
    text: String,
}

impl BackendReport {
    /// Creates a report with its frozen column order.
    pub fn new() -> Self {
        Self {
            text: concat!(
                "schema\tfixture\thash\tx_bases\ty_bases\tresolution\tk\tregisters\t",
                "b_bits\thll_precision\thash_mkmer_s\thash_checksum\tbuild_ms\t",
                "matrix_median_ms\tbytes\tmean_core_occupancy\tfingerprint32_collisions\t",
                "cells\tfalse_missing\tfalse_present\tmean_abs_error\tp50_abs_error\t",
                "p95_abs_error\tmax_abs_error\tmax_overestimate\tworst_column\tworst_row\t",
                "worst_estimate\tworst_exact\tmashmap_mean_abs_error\t",
                "mashmap_p95_abs_error\tdirection_correct_cells\tdirection_tested_cells\t",
                "passed\n"
            )
            .to_owned(),
        }
    }

    /// Appends one hash/tier result.
    #[allow(clippy::too_many_arguments)]
    pub fn push(
        &mut self,
        fixture: &str,
        x_bases: u64,
        y_bases: u64,
        config: BenchmarkConfig,
        hash_run: HashRun,
        run: &KernelRun,
        metrics: &Metrics,
    ) {
        let diagnostics = run
            .oph_diagnostics
            .expect("the backend report accepts direct OPH runs only");
        let hash_mkmer_s = if hash_run.elapsed.is_zero() {
            f64::INFINITY
        } else {
            f64::from(
                u32::try_from(hash_run.kmer_count)
                    .expect("two supported sequence axes contain at most two billion k-mers"),
            ) / hash_run.elapsed.as_secs_f64()
                / 1_000_000.0
        };
        let passed = metrics.missing_cells == 0
            && metrics.false_present_cells == 0
            && metrics.mean_abs_error <= 0.015
            && metrics.p95_abs_error <= 0.035
            && metrics.max_abs_error <= 0.060
            && metrics.max_overestimate <= 0.060
            && metrics.direction_correct_cells == metrics.direction_tested_cells;
        writeln!(
            self.text,
            concat!(
                "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t12\t{:.3}\t{:016x}\t",
                "{:.3}\t{:.3}\t{}\t{:.8}\t{}\t{}\t{}\t{}\t{:.8}\t{:.8}\t",
                "{:.8}\t{:.8}\t{:.8}\t{}\t{}\t{:.8}\t{:.8}\t{:.8}\t{:.8}\t",
                "{}\t{}\t{}"
            ),
            BACKEND_SCHEMA_VERSION,
            fixture,
            run.name,
            x_bases,
            y_bases,
            config.resolution,
            config.k,
            config.register_count,
            config.b_bits,
            hash_mkmer_s,
            hash_run.checksum,
            run.build_time.as_secs_f64() * 1_000.0,
            run.matrix_time.as_secs_f64() * 1_000.0,
            run.estimated_bytes,
            diagnostics.mean_core_occupancy,
            diagnostics.fingerprint32_collisions,
            config.resolution * config.resolution,
            metrics.missing_cells,
            metrics.false_present_cells,
            metrics.mean_abs_error,
            metrics.p50_abs_error,
            metrics.p95_abs_error,
            metrics.max_abs_error,
            metrics.max_overestimate,
            metrics.worst_column,
            metrics.worst_row,
            metrics.worst_estimate,
            metrics.worst_exact,
            metrics.mashmap_mean_abs_error,
            metrics.mashmap_p95_abs_error,
            metrics.direction_correct_cells,
            metrics.direction_tested_cells,
            passed,
        )
        .expect("writing to a string cannot fail");
    }

    /// Writes the completed TSV artifact.
    pub fn write(&self, path: &Path) -> io::Result<()> {
        fs::write(path, &self.text)
    }

    /// Borrows the complete TSV text.
    pub fn as_str(&self) -> &str {
        &self.text
    }
}

impl Default for BackendReport {
    fn default() -> Self {
        Self::new()
    }
}

/// Stable serialization for the adaptive containment sweep.
#[derive(Debug)]
pub struct AdaptiveBackendReport {
    text: String,
}

impl AdaptiveBackendReport {
    /// Creates a report with its frozen column order.
    pub fn new() -> Self {
        Self {
            text: concat!(
                "schema\tfixture\tx_bases\ty_bases\tresolution\tk\tregisters\tb_bits\t",
                "sparse_cap\tmin_expected_matches\tani_floor\tbuild_ms\tmatrix_median_ms\t",
                "first_view_ms\tbytes\tretained_sparse_cores\tretained_sparse_hashes\t",
                "corrected_directed_cells\tcells\tfalse_missing\tfalse_present\t",
                "relevant_cells\trelevant_mean_containment_error\t",
                "relevant_p95_containment_error\trelevant_max_containment_error\t",
                "relevant_mean_ani_error\trelevant_p95_ani_error\trelevant_max_ani_error\t",
                "all_mean_ani_error\tall_p95_ani_error\tall_max_ani_error\t",
                "mashmap_mean_ani_delta\tmashmap_p95_ani_delta\tdirection_correct_cells\t",
                "direction_tested_cells\tmean_core_occupancy\tfingerprint32_collisions\t",
                "passed\n"
            )
            .to_owned(),
        }
    }

    /// Appends one fixture/configuration result.
    #[allow(clippy::too_many_arguments)]
    pub fn push(
        &mut self,
        fixture: &str,
        x_bases: u64,
        y_bases: u64,
        config: BenchmarkConfig,
        adaptive: AdaptiveConfig,
        run: &KernelRun,
        metrics: &Metrics,
    ) {
        let oph = run
            .oph_diagnostics
            .expect("an adaptive OPH run must retain OPH diagnostics");
        let sparse = run
            .adaptive_diagnostics
            .expect("an adaptive OPH run must retain correction diagnostics");
        let relevant_pass = metrics.relevant_cells == 0
            || (metrics.relevant_mean_containment_error <= 0.010
                && metrics.relevant_p95_containment_error <= 0.030
                && metrics.relevant_max_containment_error <= 0.080
                && metrics.relevant_mean_ani_error <= 0.010
                && metrics.relevant_p95_ani_error <= 0.025
                && metrics.relevant_max_ani_error <= 0.050);
        let passed = metrics.missing_cells == 0
            && metrics.false_present_cells == 0
            && metrics.direction_correct_cells == metrics.direction_tested_cells
            && relevant_pass;
        writeln!(
            self.text,
            concat!(
                "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{:.1}\t{:.2}\t",
                "{:.3}\t{:.3}\t{:.3}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t",
                "{:.8}\t{:.8}\t{:.8}\t{:.8}\t{:.8}\t{:.8}\t{:.8}\t{:.8}\t",
                "{:.8}\t{:.8}\t{:.8}\t{}\t{}\t{:.8}\t{}\t{}"
            ),
            ADAPTIVE_SCHEMA_VERSION,
            fixture,
            x_bases,
            y_bases,
            config.resolution,
            config.k,
            config.register_count,
            config.b_bits,
            adaptive.sparse_cap,
            adaptive.min_expected_matches,
            adaptive.ani_floor,
            run.build_time.as_secs_f64() * 1_000.0,
            run.matrix_time.as_secs_f64() * 1_000.0,
            (run.build_time + run.matrix_time).as_secs_f64() * 1_000.0,
            run.estimated_bytes,
            sparse.retained_sparse_cores,
            sparse.retained_sparse_hashes,
            sparse.corrected_directed_cells,
            config.resolution * config.resolution,
            metrics.missing_cells,
            metrics.false_present_cells,
            metrics.relevant_cells,
            metrics.relevant_mean_containment_error,
            metrics.relevant_p95_containment_error,
            metrics.relevant_max_containment_error,
            metrics.relevant_mean_ani_error,
            metrics.relevant_p95_ani_error,
            metrics.relevant_max_ani_error,
            metrics.mean_abs_error,
            metrics.p95_abs_error,
            metrics.max_abs_error,
            metrics.mashmap_mean_abs_error,
            metrics.mashmap_p95_abs_error,
            metrics.direction_correct_cells,
            metrics.direction_tested_cells,
            oph.mean_core_occupancy,
            oph.fingerprint32_collisions,
            passed,
        )
        .expect("writing to a string cannot fail");
    }

    /// Writes the completed TSV artifact.
    pub fn write(&self, path: &Path) -> io::Result<()> {
        fs::write(path, &self.text)
    }

    /// Borrows the complete TSV text.
    pub fn as_str(&self) -> &str {
        &self.text
    }
}

impl Default for AdaptiveBackendReport {
    fn default() -> Self {
        Self::new()
    }
}

/// Performance-only serialization for inputs too large for an all-k-mer oracle.
#[derive(Debug)]
pub struct AdaptivePerformanceReport {
    text: String,
}

impl AdaptivePerformanceReport {
    /// Creates the stable performance-only header.
    pub fn new() -> Self {
        Self {
            text: concat!(
                "schema\tfixture\tx_bases\ty_bases\tresolution\tk\tregisters\tb_bits\t",
                "sparse_cap\tmin_expected_matches\tani_floor\tbuild_ms\tmatrix_median_ms\t",
                "correction_ms\tselection_ms\tfirst_view_ms\tbytes\tretained_sparse_cores\tretained_sparse_hashes\t",
                "corrected_directed_cells\n"
            )
            .to_owned(),
        }
    }

    /// Appends one performance result without constructing an exact oracle.
    pub fn push(
        &mut self,
        fixture: &str,
        x_bases: u64,
        y_bases: u64,
        config: BenchmarkConfig,
        adaptive: AdaptiveConfig,
        run: &KernelRun,
    ) {
        let sparse = run
            .adaptive_diagnostics
            .expect("an adaptive run must retain correction diagnostics");
        writeln!(
            self.text,
            concat!(
                "backend-v2-performance\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{:.1}\t",
                "{:.2}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{}\t{}\t{}\t{}"
            ),
            fixture,
            x_bases,
            y_bases,
            config.resolution,
            config.k,
            config.register_count,
            config.b_bits,
            adaptive.sparse_cap,
            adaptive.min_expected_matches,
            adaptive.ani_floor,
            run.build_time.as_secs_f64() * 1_000.0,
            run.matrix_time.as_secs_f64() * 1_000.0,
            sparse.correction_time.as_secs_f64() * 1_000.0,
            sparse.selection_time.as_secs_f64() * 1_000.0,
            (run.build_time + run.matrix_time).as_secs_f64() * 1_000.0,
            run.estimated_bytes,
            sparse.retained_sparse_cores,
            sparse.retained_sparse_hashes,
            sparse.corrected_directed_cells,
        )
        .expect("writing to a string cannot fail");
    }

    /// Writes the report artifact.
    pub fn write(&self, path: &Path) -> io::Result<()> {
        fs::write(path, &self.text)
    }

    /// Borrows the complete TSV text.
    pub fn as_str(&self) -> &str {
        &self.text
    }
}

impl Default for AdaptivePerformanceReport {
    fn default() -> Self {
        Self::new()
    }
}
