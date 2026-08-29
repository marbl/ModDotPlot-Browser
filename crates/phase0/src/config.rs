//! Versioned Phase 0 benchmark configuration.

/// Schema version written to every report.
pub const SCHEMA_VERSION: &str = "phase0-v1";

/// Deterministic benchmark parameters.
#[derive(Clone, Copy, Debug)]
pub struct BenchmarkConfig {
    /// Length of each synthetic sequence.
    pub sequence_length: usize,
    /// Number of intervals per synthetic axis.
    pub resolution: usize,
    /// Canonical k-mer length.
    pub k: u8,
    /// Maximum bottom-s sketch size.
    pub sketch_size: usize,
    /// Number of OPH or SetSketch-like registers.
    pub register_count: usize,
    /// Bits retained for the b-bit comparison.
    pub b_bits: u8,
    /// Public deterministic hash seed.
    pub hash_seed: u64,
    /// Number of timed matrix repetitions after warm-up.
    pub repetitions: usize,
}

impl Default for BenchmarkConfig {
    fn default() -> Self {
        Self {
            sequence_length: 262_144,
            resolution: 32,
            k: 21,
            sketch_size: 1_024,
            register_count: 1_024,
            b_bits: 14,
            hash_seed: 42,
            repetitions: 3,
        }
    }
}

impl BenchmarkConfig {
    /// Small deterministic configuration used by tests and quick local checks.
    pub fn smoke() -> Self {
        Self {
            sequence_length: 32_768,
            resolution: 8,
            sketch_size: 256,
            register_count: 256,
            repetitions: 1,
            ..Self::default()
        }
    }
}
