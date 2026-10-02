//! Rejected fused-build projections retained only for controlled benchmarks.

use crate::ScientificConfig;
use crate::matrix::AxisOverview;
use crate::sketch::OphSketch;

impl OphSketch {
    /// Projects a fine OPH partition into an equivalent coarser partition.
    ///
    /// # Panics
    ///
    /// Panics unless the requested register count is a power-of-two divisor of the
    /// source count and is at least two.
    #[must_use]
    pub fn project_registers(&self, register_count: usize) -> Self {
        assert!(register_count >= 2 && register_count.is_power_of_two());
        assert!(register_count <= self.registers.len());
        assert_eq!(self.registers.len() % register_count, 0);
        let group = self.registers.len() / register_count;
        let registers = self
            .registers
            .chunks_exact(group)
            .map(|candidates| {
                candidates
                    .iter()
                    .copied()
                    .filter(|candidate| candidate.occupied)
                    .min_by_key(|candidate| candidate.hash)
                    .unwrap_or_default()
            })
            .collect();
        Self {
            registers,
            cardinality: self.cardinality.clone(),
            observations: self.observations,
        }
    }
}

impl AxisOverview {
    /// Derives an equivalent coarser OPH tier without rehashing the sequence.
    ///
    /// # Panics
    ///
    /// Panics unless the requested register count and fingerprint width form a valid
    /// projection of the source scientific configuration.
    #[must_use]
    pub fn project_registers(&self, register_count: usize, fingerprint_bits: u8) -> Self {
        let core = self
            .core
            .iter()
            .map(|sketch| sketch.project_registers(register_count))
            .collect::<Vec<_>>();
        let expanded = self
            .expanded
            .iter()
            .map(|sketch| sketch.project_registers(register_count))
            .collect::<Vec<_>>();
        let core_encoded = core
            .iter()
            .map(|sketch| sketch.bit_sliced(fingerprint_bits, register_count))
            .collect();
        let expanded_encoded = expanded
            .iter()
            .map(|sketch| sketch.bit_sliced(fingerprint_bits, register_count))
            .collect();
        Self {
            scientific_config: ScientificConfig::new(
                self.scientific_config.k(),
                self.scientific_config.hash_algorithm(),
                self.scientific_config.hash_seed(),
                register_count,
                fingerprint_bits.min(self.scientific_config.b_bits()),
                fingerprint_bits,
                self.scientific_config.oph_estimator(),
                self.scientific_config.hll_precision(),
                0,
                self.scientific_config.ani_floor(),
                self.scientific_config.minimum_detection_probability(),
            )
            .expect("a supported projection must produce a valid scientific identity"),
            sequence_identity: self.sequence_identity,
            sequence_name: self.sequence_name.clone(),
            sequence_length: self.sequence_length,
            domain_length: self.domain_length,
            resolution: self.resolution,
            offset: self.offset,
            bounds: self.bounds.clone(),
            core,
            expanded,
            core_encoded,
            expanded_encoded,
            sparse_core: Vec::new(),
        }
    }
}
