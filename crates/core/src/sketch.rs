//! Mergeable one-permutation and cardinality sketches.

use crate::dna::Orientation;
use crate::hash::fmix64;

/// One occupied one-permutation register.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct OphRegister {
    pub(crate) hash: u64,
    pub(crate) orientation: Orientation,
    pub(crate) occupied: bool,
}

/// Evidence obtained by comparing aligned one-permutation registers.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RegisterComparison {
    /// Collision-corrected b-bit Jaccard estimate.
    pub jaccard: Option<f64>,
    /// Registers occupied in at least one input.
    pub considered: u32,
    /// Registers whose truncated b-bit values matched.
    pub bbit_matches: u32,
    /// Registers whose winner verification fingerprint matched.
    pub verified_matches: u32,
    /// Verified matches with equal canonical orientation.
    pub forward_matches: u32,
    /// Verified matches with opposite canonical orientation.
    pub reverse_matches: u32,
    /// Verified matches without unambiguous direction.
    pub ambiguous_matches: u32,
}

/// Jaccard statistic derived from aligned OPH register winners.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(u8)]
pub enum OphJaccardEstimator {
    /// Legacy truncated-bit statistic with a constant collision correction.
    #[cfg(feature = "validation")]
    BbitCollisionCorrected = 1,
    /// Standard OPH matched-winner count divided by non-jointly-empty bins.
    VerifiedWinners = 2,
}

impl OphJaccardEstimator {
    /// Stable identifier used in scientific provenance.
    pub const fn as_str(self) -> &'static str {
        match self {
            #[cfg(feature = "validation")]
            Self::BbitCollisionCorrected => "bbit_collision_corrected",
            Self::VerifiedWinners => "verified_winners",
        }
    }
}

/// Word-parallel fixed-register signature derived from an [`OphSketch`].
///
/// Each hash bit is stored as a separate bit plane. Comparing 64 registers therefore
/// requires one word operation per retained bit rather than 64 branch-heavy scalar
/// comparisons. A wider verification fingerprint protects directional votes from the
/// expected collisions in the shorter similarity signature.
#[derive(Clone, Debug, PartialEq)]
pub struct BitSlicedSignature {
    register_count: usize,
    words: usize,
    fingerprint_bits: u8,
    occupancy: Vec<u64>,
    planes: Vec<u64>,
    reverse_orientation: Vec<u64>,
    ambiguous_orientation: Vec<u64>,
    estimated_cardinality: f64,
    observations: u64,
}

impl BitSlicedSignature {
    /// Number of represented registers.
    pub fn register_count(&self) -> usize {
        self.register_count
    }

    pub(crate) fn fingerprint_bits(&self) -> u8 {
        self.fingerprint_bits
    }

    /// Estimated distinct cardinality copied from the source sketch.
    pub fn estimated_cardinality(&self) -> f64 {
        self.estimated_cardinality
    }

    /// Number of valid k-mer occurrences in the summarized interval.
    pub fn observations(&self) -> u64 {
        self.observations
    }

    /// Registers occupied in at least one of two signatures.
    ///
    /// # Panics
    ///
    /// Panics if the signatures have incompatible dimensions.
    pub fn considered_with(&self, other: &Self, register_limit: usize) -> u32 {
        assert_eq!(self.register_count, other.register_count);
        let effective_registers = register_limit.min(self.register_count);
        let effective_words = effective_registers.div_ceil(64);
        (0..effective_words)
            .map(|word| {
                let word_mask =
                    if word + 1 == effective_words && !effective_registers.is_multiple_of(64) {
                        (1_u64 << (effective_registers % 64)) - 1
                    } else {
                        u64::MAX
                    };
                ((self.occupancy[word] | other.occupancy[word]) & word_mask).count_ones()
            })
            .sum()
    }

    /// Approximate bytes owned by heap allocations, excluding allocator overhead.
    pub fn estimated_heap_bytes(&self) -> usize {
        [
            self.occupancy.capacity(),
            self.planes.capacity(),
            self.reverse_orientation.capacity(),
            self.ambiguous_orientation.capacity(),
        ]
        .into_iter()
        .sum::<usize>()
        .saturating_mul(std::mem::size_of::<u64>())
    }

    /// Compares two signatures using word-parallel equality.
    ///
    /// # Panics
    ///
    /// Panics if the signatures have different dimensions or if `b` is zero or wider
    /// than the stored verification fingerprint.
    #[inline]
    pub fn compare(&self, other: &Self, b: u8, register_limit: usize) -> RegisterComparison {
        assert_eq!(self.register_count, other.register_count);
        assert_eq!(self.fingerprint_bits, other.fingerprint_bits);
        assert!((1..=self.fingerprint_bits).contains(&b));

        let effective_registers = register_limit.min(self.register_count);
        let effective_words = effective_registers.div_ceil(64);
        let mut comparison = RegisterComparison::default();
        for word in 0..effective_words {
            let word_mask =
                if word + 1 == effective_words && !effective_registers.is_multiple_of(64) {
                    (1_u64 << (effective_registers % 64)) - 1
                } else {
                    u64::MAX
                };
            let left_occupied = self.occupancy[word] & word_mask;
            let right_occupied = other.occupancy[word] & word_mask;
            comparison.considered += (left_occupied | right_occupied).count_ones();

            let mut equal = left_occupied & right_occupied;
            for bit in 0..b {
                let plane = usize::from(bit) * self.words + word;
                equal &= !(self.planes[plane] ^ other.planes[plane]);
                if equal == 0 {
                    break;
                }
            }
            comparison.bbit_matches += equal.count_ones();

            if equal != 0 {
                for bit in b..self.fingerprint_bits {
                    let plane = usize::from(bit) * self.words + word;
                    equal &= !(self.planes[plane] ^ other.planes[plane]);
                    if equal == 0 {
                        break;
                    }
                }
            }
            comparison.verified_matches += equal.count_ones();

            let ambiguous =
                equal & (self.ambiguous_orientation[word] | other.ambiguous_orientation[word]);
            let informative = equal & !ambiguous;
            let orientation_difference =
                self.reverse_orientation[word] ^ other.reverse_orientation[word];
            comparison.forward_matches += (informative & !orientation_difference).count_ones();
            comparison.reverse_matches += (informative & orientation_difference).count_ones();
            comparison.ambiguous_matches += ambiguous.count_ones();
        }

        comparison.jaccard =
            verified_winner_jaccard(comparison.verified_matches, comparison.considered);
        comparison
    }

    /// Scalar comparator retained solely as an independent check of bit-sliced logic.
    #[cfg(test)]
    pub(crate) fn compare_scalar(
        &self,
        other: &Self,
        b: u8,
        register_limit: usize,
    ) -> RegisterComparison {
        assert_eq!(self.register_count, other.register_count);
        assert_eq!(self.fingerprint_bits, other.fingerprint_bits);
        assert!((1..=self.fingerprint_bits).contains(&b));
        let mut comparison = RegisterComparison::default();
        for register in 0..register_limit.min(self.register_count) {
            let word = register / 64;
            let mask = 1_u64 << (register % 64);
            let left_occupied = self.occupancy[word] & mask != 0;
            let right_occupied = other.occupancy[word] & mask != 0;
            if !left_occupied && !right_occupied {
                continue;
            }
            comparison.considered += 1;
            if !(left_occupied && right_occupied) {
                continue;
            }
            let bit_equal = |bit: u8| {
                let plane = usize::from(bit) * self.words + word;
                (self.planes[plane] ^ other.planes[plane]) & mask == 0
            };
            if !(0..b).all(bit_equal) {
                continue;
            }
            comparison.bbit_matches += 1;
            if !(b..self.fingerprint_bits).all(bit_equal) {
                continue;
            }
            comparison.verified_matches += 1;
            let ambiguous =
                (self.ambiguous_orientation[word] | other.ambiguous_orientation[word]) & mask != 0;
            if ambiguous {
                comparison.ambiguous_matches += 1;
            } else if (self.reverse_orientation[word] ^ other.reverse_orientation[word]) & mask != 0
            {
                comparison.reverse_matches += 1;
            } else {
                comparison.forward_matches += 1;
            }
        }
        comparison.jaccard =
            verified_winner_jaccard(comparison.verified_matches, comparison.considered);
        comparison
    }
}

/// Mergeable one-permutation sketch with full register winners.
///
/// Full winners are retained in the scientific core. A bit-sliced representation is
/// derived for the optimized matrix kernel, while full hashes remain available for
/// differential testing and collision-free direction votes.
#[derive(Clone, Debug, PartialEq)]
pub struct OphSketch {
    pub(crate) registers: Vec<OphRegister>,
    pub(crate) cardinality: HllSketch,
    pub(crate) observations: u64,
}

impl OphSketch {
    /// Creates an empty sketch. `register_count` must be a power of two.
    ///
    /// # Panics
    ///
    /// Panics if the register count is not a power of two of at least two, or if the
    /// HLL precision is outside `4..=16`.
    pub fn new(register_count: usize, hll_precision: u8) -> Self {
        assert!(register_count >= 2 && register_count.is_power_of_two());
        Self {
            registers: vec![OphRegister::default(); register_count],
            cardinality: HllSketch::new(hll_precision),
            observations: 0,
        }
    }

    /// Number of one-permutation registers.
    pub fn register_count(&self) -> usize {
        self.registers.len()
    }

    /// Number of valid k-mer occurrences offered to the sketch.
    pub fn observations(&self) -> u64 {
        self.observations
    }

    /// Estimated number of distinct canonical hashes.
    pub fn estimated_cardinality(&self) -> f64 {
        self.cardinality.estimate()
    }

    /// Number of registers containing a retained winner.
    pub fn occupied_registers(&self) -> usize {
        self.registers
            .iter()
            .filter(|register| register.occupied)
            .count()
    }

    /// Returns an occupied register's full winner and combined orientation.
    pub fn winner(&self, register: usize) -> Option<(u64, Orientation)> {
        self.registers
            .get(register)
            .and_then(|winner| winner.occupied.then_some((winner.hash, winner.orientation)))
    }

    /// Approximate bytes owned by heap allocations, excluding allocator overhead.
    pub fn estimated_heap_bytes(&self) -> usize {
        self.registers
            .capacity()
            .saturating_mul(std::mem::size_of::<OphRegister>())
            .saturating_add(self.cardinality.estimated_heap_bytes())
    }

    /// Adds one pre-hashed canonical k-mer.
    #[allow(clippy::cast_possible_truncation)]
    pub fn insert(&mut self, hash: u64, orientation: Orientation) {
        let bucket_bits = self.registers.len().trailing_zeros();
        // Only bucket_bits are retained, and register_count is addressable usize.
        let bucket = (hash >> (64 - bucket_bits)) as usize;
        let register = &mut self.registers[bucket];
        if !register.occupied || hash < register.hash {
            *register = OphRegister {
                hash,
                orientation,
                occupied: true,
            };
        } else if hash == register.hash {
            register.orientation = register.orientation.combine(orientation);
        }
        self.cardinality.insert(hash);
        self.observations += 1;
    }

    /// Merges a disjoint coordinate summary into this sketch.
    ///
    /// # Panics
    ///
    /// Panics if the sketches have different register counts or HLL precision.
    pub fn merge(&mut self, other: &Self) {
        assert_eq!(self.registers.len(), other.registers.len());
        for (left, right) in self.registers.iter_mut().zip(&other.registers) {
            if !right.occupied {
                continue;
            }
            if !left.occupied || right.hash < left.hash {
                *left = *right;
            } else if right.hash == left.hash {
                left.orientation = left.orientation.combine(right.orientation);
            }
        }
        self.cardinality.merge(&other.cardinality);
        self.observations = self.observations.saturating_add(other.observations);
    }

    /// Compares a prefix of aligned registers with `b` retained hash bits.
    ///
    /// Empty registers remain empty in the selected undensified production estimator.
    ///
    /// # Panics
    ///
    /// Panics if register counts differ or `b` is outside `1..=32`.
    pub fn compare_bbit(&self, other: &Self, b: u8, register_limit: usize) -> RegisterComparison {
        assert_eq!(self.registers.len(), other.registers.len());
        assert!((1..=32).contains(&b));
        let limit = register_limit.min(self.registers.len());
        let mask = (1_u64 << b) - 1;
        let mut comparison = RegisterComparison::default();

        for (left, right) in self.registers[..limit]
            .iter()
            .zip(&other.registers[..limit])
        {
            if !left.occupied && !right.occupied {
                continue;
            }
            comparison.considered += 1;
            if left.occupied && right.occupied && (left.hash & mask) == (right.hash & mask) {
                comparison.bbit_matches += 1;
            }

            if left.occupied && right.occupied && left.hash == right.hash {
                comparison.verified_matches += 1;
                match (left.orientation, right.orientation) {
                    (Orientation::Forward, Orientation::Forward)
                    | (Orientation::Reverse, Orientation::Reverse) => {
                        comparison.forward_matches += 1;
                    }
                    (Orientation::Forward, Orientation::Reverse)
                    | (Orientation::Reverse, Orientation::Forward) => {
                        comparison.reverse_matches += 1;
                    }
                    _ => comparison.ambiguous_matches += 1,
                }
            }
        }

        comparison.jaccard =
            verified_winner_jaccard(comparison.verified_matches, comparison.considered);
        comparison
    }

    /// Encodes a register prefix into a word-parallel bit-sliced signature.
    ///
    /// # Panics
    ///
    /// Panics if `fingerprint_bits` is outside `1..=64`.
    pub fn bit_sliced(&self, fingerprint_bits: u8, register_limit: usize) -> BitSlicedSignature {
        assert!((1..=64).contains(&fingerprint_bits));
        let register_count = register_limit.min(self.registers.len());
        let words = register_count.div_ceil(64);
        let mut signature = BitSlicedSignature {
            register_count,
            words,
            fingerprint_bits,
            occupancy: vec![0; words],
            planes: vec![0; words * usize::from(fingerprint_bits)],
            reverse_orientation: vec![0; words],
            ambiguous_orientation: vec![0; words],
            estimated_cardinality: self.estimated_cardinality(),
            observations: self.observations,
        };

        for (index, register) in self.registers[..register_count].iter().enumerate() {
            if !register.occupied {
                continue;
            }
            let word = index / 64;
            let flag = 1_u64 << (index % 64);
            signature.occupancy[word] |= flag;
            for bit in 0..fingerprint_bits {
                if register.hash & (1_u64 << bit) != 0 {
                    signature.planes[usize::from(bit) * words + word] |= flag;
                }
            }
            match register.orientation {
                Orientation::Reverse => signature.reverse_orientation[word] |= flag,
                Orientation::Both | Orientation::Unknown => {
                    signature.ambiguous_orientation[word] |= flag;
                }
                Orientation::Forward => {}
            }
        }
        signature
    }
}

/// Estimates OPH resemblance from verified winner equality over union-occupied bins.
pub fn verified_winner_jaccard(matches: u32, considered: u32) -> Option<f64> {
    (considered > 0).then(|| f64::from(matches) / f64::from(considered))
}

/// Mergeable `HyperLogLog` cardinality sidecar.
#[derive(Clone, Debug, PartialEq)]
pub struct HllSketch {
    precision: u8,
    registers: Vec<u8>,
}

impl HllSketch {
    /// Creates an HLL with `2^precision` registers.
    ///
    /// # Panics
    ///
    /// Panics if precision is outside `4..=16`.
    pub fn new(precision: u8) -> Self {
        assert!((4..=16).contains(&precision));
        Self {
            precision,
            registers: vec![0; 1 << precision],
        }
    }

    /// Adds one 64-bit hash.
    #[allow(clippy::cast_possible_truncation)]
    pub fn insert(&mut self, hash: u64) {
        // A second avalanche prevents OPH bucket bits and HLL registers from being
        // identical random variables while retaining deterministic behavior.
        let hash = fmix64(hash ^ 0xd6e8_feb8_6659_fd93);
        // Precision is at most 16, so the retained value is addressable on Wasm32.
        let index = (hash >> (64 - self.precision)) as usize;
        let remainder = hash << self.precision;
        let max_rank = 64 - self.precision + 1;
        let rank = (remainder.leading_zeros() + 1).min(u32::from(max_rank)) as u8;
        self.registers[index] = self.registers[index].max(rank);
    }

    /// Merges the union of another HLL into this one.
    ///
    /// # Panics
    ///
    /// Panics if the HLL precisions differ.
    pub fn merge(&mut self, other: &Self) {
        assert_eq!(self.precision, other.precision);
        for (left, right) in self.registers.iter_mut().zip(&other.registers) {
            *left = (*left).max(*right);
        }
    }

    /// Estimates distinct cardinality, including the standard small-range correction.
    pub fn estimate(&self) -> f64 {
        let register_count = 1_u32 << self.precision;
        let m = f64::from(register_count);
        let zeros = self.registers.iter().fold(
            0_u32,
            |count, &value| if value == 0 { count + 1 } else { count },
        );
        if zeros == register_count {
            return 0.0;
        }

        let alpha = match self.registers.len() {
            16 => 0.673,
            32 => 0.697,
            64 => 0.709,
            _ => 0.7213 / (1.0 + 1.079 / m),
        };
        let harmonic: f64 = self
            .registers
            .iter()
            .map(|&rank| 2_f64.powi(-i32::from(rank)))
            .sum();
        let raw = alpha * m * m / harmonic;
        if raw <= 2.5 * m && zeros > 0 {
            m * (m / f64::from(zeros)).ln()
        } else {
            raw
        }
    }

    fn estimated_heap_bytes(&self) -> usize {
        self.registers.capacity()
    }
}

#[cfg(test)]
#[allow(deprecated)]
mod tests {
    use super::*;

    #[test]
    fn identical_sketches_compare_as_one() {
        let mut sketch = OphSketch::new(256, 10);
        for value in 0..20_000_u64 {
            sketch.insert(fmix64(value), Orientation::Forward);
        }
        let comparison = sketch.compare_bbit(&sketch, 14, 256);
        assert_eq!(comparison.jaccard, Some(1.0));
        assert_eq!(comparison.forward_matches, comparison.verified_matches);
    }

    #[test]
    fn merge_matches_direct_insertion() {
        let mut left = OphSketch::new(128, 8);
        let mut right = OphSketch::new(128, 8);
        let mut direct = OphSketch::new(128, 8);
        for value in 0..10_000_u64 {
            let hash = fmix64(value);
            if value % 2 == 0 {
                left.insert(hash, Orientation::Forward);
            } else {
                right.insert(hash, Orientation::Forward);
            }
            direct.insert(hash, Orientation::Forward);
        }
        left.merge(&right);
        assert_eq!(left, direct);
    }

    #[test]
    fn orientation_votes_distinguish_reverse_matches() {
        let mut left = OphSketch::new(64, 8);
        let mut right = OphSketch::new(64, 8);
        for value in 0..5000_u64 {
            let hash = fmix64(value);
            left.insert(hash, Orientation::Forward);
            right.insert(hash, Orientation::Reverse);
        }
        let comparison = left.compare_bbit(&right, 14, 64);
        assert_eq!(comparison.jaccard, Some(1.0));
        assert_eq!(comparison.reverse_matches, comparison.verified_matches);
        assert_eq!(comparison.forward_matches, 0);
    }

    #[test]
    fn bbit_only_collision_cannot_create_similarity_without_verified_evidence() {
        let mut left = OphSketch::new(2, 4);
        let mut right = OphSketch::new(2, 4);
        // Both hashes occupy register zero and share their low 14 bits, but their
        // verification fingerprints differ.
        left.insert(0x1000_0000_0000_1234, Orientation::Forward);
        right.insert(0x2000_0000_0000_1234, Orientation::Forward);
        let comparison = left.compare_bbit(&right, 14, 2);
        assert_eq!(comparison.bbit_matches, 1);
        assert_eq!(comparison.verified_matches, 0);
        assert_eq!(comparison.jaccard, Some(0.0));
    }

    #[test]
    fn bit_sliced_comparison_matches_scalar_reference() {
        let mut left = OphSketch::new(512, 10);
        let mut right = OphSketch::new(512, 10);
        for value in 0..30_000_u64 {
            let hash = fmix64(value);
            left.insert(hash, Orientation::Forward);
            if value % 5 != 0 {
                right.insert(hash, Orientation::Reverse);
            }
        }
        for value in 40_000..47_500_u64 {
            right.insert(fmix64(value), Orientation::Forward);
        }

        let scalar = left.compare_bbit(&right, 14, 512);
        let encoded_left = left.bit_sliced(64, 512);
        let encoded_right = right.bit_sliced(64, 512);
        let bit_sliced = encoded_left.compare(&encoded_right, 14, 512);
        assert_eq!(scalar, bit_sliced);
    }

    #[test]
    #[cfg(feature = "validation")]
    fn projected_registers_match_direct_coarse_insertion() {
        let mut detailed = OphSketch::new(2_048, 10);
        let mut quick = OphSketch::new(256, 10);
        for value in 0..100_000_u64 {
            let hash = fmix64(value.wrapping_mul(0xd6e8_feb8_6659_fd93));
            detailed.insert(hash, Orientation::Forward);
            quick.insert(hash, Orientation::Forward);
        }
        assert_eq!(detailed.project_registers(256), quick);
    }

    #[test]
    fn hll_cardinality_is_within_expected_error() {
        let mut hll = HllSketch::new(12);
        for value in 0..100_000_u64 {
            hll.insert(fmix64(value));
        }
        let relative_error = (hll.estimate() - 100_000.0).abs() / 100_000.0;
        assert!(relative_error < 0.05, "relative error was {relative_error}");
    }
}
