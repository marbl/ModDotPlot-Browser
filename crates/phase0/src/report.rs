//! Stable TSV serialization for machine- and human-readable benchmark results.

use crate::config::{BenchmarkConfig, SCHEMA_VERSION};
use crate::kernel::KernelRun;
use crate::metrics::Metrics;
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::Path;

/// Complete report accumulated in deterministic fixture/kernel order.
#[derive(Debug)]
pub struct Report {
    text: String,
}

impl Report {
    /// Creates a report with the frozen column header.
    pub fn new() -> Self {
        Self {
            text: concat!(
                "schema\tfixture\tkernel\tsequence_bases\tresolution\tk\tsketch_units\t",
                "build_ms\tmatrix_median_ms\tbytes\tcells\tmissing_cells\t",
                "mean_abs_error\tp50_abs_error\tp95_abs_error\tmax_abs_error\t",
                "mashmap_mean_abs_error\tmashmap_p95_abs_error\tforward_votes\t",
                "reverse_votes\tambiguous_votes\tdirection_correct_cells\t",
                "direction_tested_cells\n"
            )
            .to_owned(),
        }
    }

    /// Appends one fixture/kernel row.
    pub fn push(
        &mut self,
        fixture: &str,
        config: BenchmarkConfig,
        run: &KernelRun,
        metrics: &Metrics,
    ) {
        let cells = config.resolution * config.resolution;
        writeln!(
            self.text,
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{:.3}\t{:.3}\t{}\t{}\t{}\t{:.8}\t{:.8}\t{:.8}\t{:.8}\t{:.8}\t{:.8}\t{}\t{}\t{}\t{}\t{}",
            SCHEMA_VERSION,
            fixture,
            run.name,
            config.sequence_length,
            config.resolution,
            config.k,
            if run.name.contains("bottom_s") || run.name.contains("postings") {
                config.sketch_size
            } else {
                config.register_count
            },
            run.build_time.as_secs_f64() * 1_000.0,
            run.matrix_time.as_secs_f64() * 1_000.0,
            run.estimated_bytes,
            cells,
            metrics.missing_cells,
            metrics.mean_abs_error,
            metrics.p50_abs_error,
            metrics.p95_abs_error,
            metrics.max_abs_error,
            metrics.mashmap_mean_abs_error,
            metrics.mashmap_p95_abs_error,
            metrics.forward_votes,
            metrics.reverse_votes,
            metrics.ambiguous_votes,
            metrics.direction_correct_cells,
            metrics.direction_tested_cells,
        )
        .expect("writing to a string cannot fail");
    }

    /// Writes the report atomically enough for a local benchmark artifact.
    pub fn write(&self, path: &Path) -> io::Result<()> {
        fs::write(path, &self.text)
    }

    /// Borrows the complete TSV text.
    pub fn as_str(&self) -> &str {
        &self.text
    }
}

impl Default for Report {
    fn default() -> Self {
        Self::new()
    }
}
