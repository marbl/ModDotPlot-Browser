//! Versioned scientific configuration shared by native tests and browser production.

use crate::DEFAULT_HASH_SEED;
use crate::hash::HashAlgorithm;
use crate::sketch::OphJaccardEstimator;
use std::fmt::{Display, Formatter};

const DEFAULT_ANI_FLOOR: f64 = 0.80;
const DEFAULT_EXACT_CORE_CAP: usize = 2_048;
const DEFAULT_MATCH_DETECTION_PROBABILITY: f64 = 0.99;

/// Current serialized scientific-contract version.
pub const SCIENTIFIC_CONFIG_VERSION: u16 = 1;

/// Default number of low winner bits used by the candidate comparison stage.
pub const DEFAULT_B_BITS: u8 = 14;

/// Winner fingerprint width used to verify candidates and determine orientation.
pub const DEFAULT_VERIFICATION_BITS: u8 = 32;

/// Default HLL precision pending the documented precision sweep.
pub const DEFAULT_HLL_PRECISION: u8 = 10;

/// Fixed-point scale used for ANI values in matrix tiles.
pub const DEFAULT_IDENTITY_SCALE: u16 = 10_000;

/// Missing-value sentinel in the unsigned identity channel.
pub const DEFAULT_MISSING_IDENTITY: u16 = u16::MAX;

/// Exact canonical identity of a validated scientific configuration.
///
/// This value is suitable for in-process equality, ordering, and cache keys. The
/// shorter 64-bit digest remains the external provenance label and is not used as the
/// sole proof that two cached scientific objects are compatible.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ScientificConfigIdentity([u8; 54]);

impl ScientificConfigIdentity {
    /// Canonical little-endian field encoding.
    pub const fn as_bytes(&self) -> &[u8; 54] {
        &self.0
    }
}

/// How neighboring context is added to the target interval.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(u8)]
pub enum AxisExpansionPolicy {
    /// Expand by one half of the core interval on both sides.
    HalfWindow = 1,
}

/// Transform from directed containment to displayed identity.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(u8)]
pub enum AniTransform {
    /// Display `containment^(1/k)`.
    ContainmentKthRoot = 1,
}

/// A validated, immutable description of every parameter that can affect a sketch tile.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScientificConfig {
    version: u16,
    k: u8,
    hash_algorithm: HashAlgorithm,
    hash_seed: u64,
    register_count: usize,
    b_bits: u8,
    verification_bits: u8,
    oph_estimator: OphJaccardEstimator,
    hll_precision: u8,
    expansion: AxisExpansionPolicy,
    ani_transform: AniTransform,
    sparse_core_cap: usize,
    ani_floor: f64,
    minimum_detection_probability: f64,
    missing_identity: u16,
    identity_scale: u16,
}

impl ScientificConfig {
    /// Constructs the production configuration using the release-default HLL precision.
    ///
    /// # Errors
    ///
    /// Returns a validation error when `k` or `register_count` is unsupported.
    pub fn production_default(
        k: u8,
        register_count: usize,
        sparse_correction: bool,
    ) -> Result<Self, ConfigError> {
        Self::production(k, register_count, DEFAULT_HLL_PRECISION, sparse_correction)
    }

    /// Constructs the production ntHash2 configuration for one quality tier.
    ///
    /// # Errors
    ///
    /// Returns a validation error for an unsupported k-mer length, register count,
    /// or `HyperLogLog` precision.
    pub fn production(
        k: u8,
        register_count: usize,
        hll_precision: u8,
        sparse_correction: bool,
    ) -> Result<Self, ConfigError> {
        Self::new(
            k,
            HashAlgorithm::NtHash2,
            DEFAULT_HASH_SEED,
            register_count,
            DEFAULT_B_BITS,
            DEFAULT_VERIFICATION_BITS,
            OphJaccardEstimator::VerifiedWinners,
            hll_precision,
            if sparse_correction {
                DEFAULT_EXACT_CORE_CAP
            } else {
                0
            },
            DEFAULT_ANI_FLOOR,
            DEFAULT_MATCH_DETECTION_PROBABILITY,
        )
    }

    /// Constructs an explicit configuration for controlled scientific validation.
    ///
    /// # Errors
    ///
    /// Returns the field-specific [`ConfigError`] for any invalid combination.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        k: u8,
        hash_algorithm: HashAlgorithm,
        hash_seed: u64,
        register_count: usize,
        b_bits: u8,
        verification_bits: u8,
        oph_estimator: OphJaccardEstimator,
        hll_precision: u8,
        sparse_core_cap: usize,
        ani_floor: f64,
        minimum_detection_probability: f64,
    ) -> Result<Self, ConfigError> {
        if !(1..=31).contains(&k) {
            return Err(ConfigError::KmerLength);
        }
        if !(2..=4_096).contains(&register_count) || !register_count.is_power_of_two() {
            return Err(ConfigError::RegisterCount);
        }
        if b_bits == 0 || b_bits > verification_bits {
            return Err(ConfigError::ComparisonBits);
        }
        if !(b_bits..=64).contains(&verification_bits) {
            return Err(ConfigError::VerificationBits);
        }
        if !(4..=16).contains(&hll_precision) {
            return Err(ConfigError::HllPrecision);
        }
        if !(0.0..=1.0).contains(&ani_floor) || !ani_floor.is_finite() {
            return Err(ConfigError::AniFloor);
        }
        if !(0.0..1.0).contains(&minimum_detection_probability)
            || !minimum_detection_probability.is_finite()
        {
            return Err(ConfigError::DetectionProbability);
        }
        if sparse_core_cap > 0 && !cfg!(feature = "validation") {
            return Err(ConfigError::ValidationFeatureDisabled);
        }
        Ok(Self {
            version: SCIENTIFIC_CONFIG_VERSION,
            k,
            hash_algorithm,
            hash_seed,
            register_count,
            b_bits,
            verification_bits,
            oph_estimator,
            hll_precision,
            expansion: AxisExpansionPolicy::HalfWindow,
            ani_transform: AniTransform::ContainmentKthRoot,
            sparse_core_cap,
            ani_floor,
            minimum_detection_probability,
            missing_identity: DEFAULT_MISSING_IDENTITY,
            identity_scale: DEFAULT_IDENTITY_SCALE,
        })
    }

    /// Stable scientific-contract version.
    pub const fn version(self) -> u16 {
        self.version
    }
    /// Canonical k-mer length.
    pub const fn k(self) -> u8 {
        self.k
    }
    /// Canonical hash stream.
    pub const fn hash_algorithm(self) -> HashAlgorithm {
        self.hash_algorithm
    }
    /// Public deterministic hash seed.
    pub const fn hash_seed(self) -> u64 {
        self.hash_seed
    }
    /// OPH register count.
    pub const fn register_count(self) -> usize {
        self.register_count
    }
    /// Low-bit candidate width.
    pub const fn b_bits(self) -> u8 {
        self.b_bits
    }
    /// Winner verification width.
    pub const fn verification_bits(self) -> u8 {
        self.verification_bits
    }
    /// OPH resemblance statistic.
    pub const fn oph_estimator(self) -> OphJaccardEstimator {
        self.oph_estimator
    }
    /// `HyperLogLog` precision.
    pub const fn hll_precision(self) -> u8 {
        self.hll_precision
    }
    /// Neighbor expansion policy.
    pub const fn expansion(self) -> AxisExpansionPolicy {
        self.expansion
    }
    /// Display identity transform.
    pub const fn ani_transform(self) -> AniTransform {
        self.ani_transform
    }
    /// Exact sparse-core retention cap, or zero when disabled.
    pub const fn sparse_core_cap(self) -> usize {
        self.sparse_core_cap
    }
    /// ANI floor used by sparse-detection policy.
    pub const fn ani_floor(self) -> f64 {
        self.ani_floor
    }
    /// Required probability of observing a true winner match.
    pub const fn minimum_detection_probability(self) -> f64 {
        self.minimum_detection_probability
    }
    /// Missing identity sentinel.
    pub const fn missing_identity(self) -> u16 {
        self.missing_identity
    }
    /// Fixed-point identity scale.
    pub const fn identity_scale(self) -> u16 {
        self.identity_scale
    }

    /// Stable FNV-1a digest covering every scientific field.
    pub fn digest(self) -> u64 {
        let mut digest = 0xcbf2_9ce4_8422_2325_u64;
        for byte in self.identity().0 {
            digest ^= u64::from(byte);
            digest = digest.wrapping_mul(0x0000_0100_0000_01b3);
        }
        digest
    }

    /// Exact canonical identity covering every scientific field.
    ///
    /// # Panics
    ///
    /// Panics if an internal schema edit changes the canonical encoding width without
    /// updating [`ScientificConfigIdentity`]. Validated runtime values cannot trigger
    /// this invariant.
    pub fn identity(self) -> ScientificConfigIdentity {
        let mut bytes = Vec::with_capacity(64);
        bytes.extend_from_slice(&self.version.to_le_bytes());
        bytes.push(self.k);
        bytes.push(self.hash_algorithm as u8);
        bytes.extend_from_slice(&self.hash_seed.to_le_bytes());
        bytes.extend_from_slice(&(self.register_count as u64).to_le_bytes());
        bytes.push(self.b_bits);
        bytes.push(self.verification_bits);
        bytes.push(self.oph_estimator as u8);
        bytes.push(self.hll_precision);
        bytes.push(self.expansion as u8);
        bytes.push(self.ani_transform as u8);
        bytes.extend_from_slice(&(self.sparse_core_cap as u64).to_le_bytes());
        bytes.extend_from_slice(&self.ani_floor.to_bits().to_le_bytes());
        bytes.extend_from_slice(&self.minimum_detection_probability.to_bits().to_le_bytes());
        bytes.extend_from_slice(&self.missing_identity.to_le_bytes());
        bytes.extend_from_slice(&self.identity_scale.to_le_bytes());
        ScientificConfigIdentity(
            bytes
                .try_into()
                .expect("scientific configuration identity has a fixed width"),
        )
    }
}

/// Validation failure for a scientific configuration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigError {
    /// `k` is outside `1..=31`.
    KmerLength,
    /// Register count is unsupported or not a power of two.
    RegisterCount,
    /// Candidate bits are zero or exceed the verification width.
    ComparisonBits,
    /// Verification width is narrower than candidate bits or wider than 64.
    VerificationBits,
    /// HLL precision is outside `4..=16`.
    HllPrecision,
    /// ANI floor is not finite or lies outside `[0,1]`.
    AniFloor,
    /// Detection probability is not finite or lies outside `[0,1)`.
    DetectionProbability,
    /// A validation-only configuration was requested from a default build.
    ValidationFeatureDisabled,
}

impl Display for ConfigError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::KmerLength => "k-mer length must be in 1..=31",
            Self::RegisterCount => "register count must be a power of two between 2 and 4096",
            Self::ComparisonBits => "comparison bits must be in 1..=verification bits",
            Self::VerificationBits => "verification bits must be in comparison bits..=64",
            Self::HllPrecision => "HLL precision must be in 4..=16",
            Self::AniFloor => "ANI floor must be finite and in 0..=1",
            Self::DetectionProbability => "detection probability must be finite and in 0..1",
            Self::ValidationFeatureDisabled => {
                "sparse correction requires the non-default validation feature"
            }
        })
    }
}

impl std::error::Error for ConfigError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_digest_is_stable_and_sensitive_to_quality() {
        let preview = ScientificConfig::production_default(21, 256, false).unwrap();
        let same = ScientificConfig::production_default(21, 256, false).unwrap();
        let detailed = ScientificConfig::production_default(21, 1_024, false).unwrap();
        assert_eq!(preview.digest(), same.digest());
        assert_ne!(preview.digest(), detailed.digest());
        assert_eq!(preview.digest(), 0x58e0_84b7_190f_4d93);
        assert_eq!(detailed.digest(), 0xbc5c_5131_ad1c_9a20);
        assert_eq!(preview.version(), SCIENTIFIC_CONFIG_VERSION);
        assert_eq!(preview.identity().as_bytes().len(), 54);
        assert_ne!(preview.identity(), detailed.identity());
    }

    #[test]
    fn invalid_fields_are_rejected_before_allocation() {
        assert_eq!(
            ScientificConfig::production(21, 300, 12, false),
            Err(ConfigError::RegisterCount)
        );
        assert_eq!(
            ScientificConfig::production(32, 256, 12, false),
            Err(ConfigError::KmerLength)
        );
        #[cfg(not(feature = "validation"))]
        assert_eq!(
            ScientificConfig::production_default(21, 256, true),
            Err(ConfigError::ValidationFeatureDisabled)
        );
    }

    #[test]
    #[cfg(feature = "validation")]
    #[allow(clippy::too_many_lines)]
    fn canonical_identity_distinguishes_every_configurable_scientific_field() {
        let configurations = [
            ScientificConfig::new(
                21,
                HashAlgorithm::NtHash2,
                0,
                256,
                14,
                32,
                OphJaccardEstimator::VerifiedWinners,
                10,
                0,
                0.80,
                0.99,
            )
            .unwrap(),
            ScientificConfig::new(
                19,
                HashAlgorithm::NtHash2,
                0,
                256,
                14,
                32,
                OphJaccardEstimator::VerifiedWinners,
                10,
                0,
                0.80,
                0.99,
            )
            .unwrap(),
            ScientificConfig::new(
                21,
                HashAlgorithm::NtHash2,
                1,
                256,
                14,
                32,
                OphJaccardEstimator::VerifiedWinners,
                10,
                0,
                0.80,
                0.99,
            )
            .unwrap(),
            ScientificConfig::new(
                21,
                HashAlgorithm::NtHash2,
                0,
                512,
                14,
                32,
                OphJaccardEstimator::VerifiedWinners,
                10,
                0,
                0.80,
                0.99,
            )
            .unwrap(),
            ScientificConfig::new(
                21,
                HashAlgorithm::NtHash2,
                0,
                256,
                12,
                32,
                OphJaccardEstimator::VerifiedWinners,
                10,
                0,
                0.80,
                0.99,
            )
            .unwrap(),
            ScientificConfig::new(
                21,
                HashAlgorithm::NtHash2,
                0,
                256,
                14,
                40,
                OphJaccardEstimator::VerifiedWinners,
                10,
                0,
                0.80,
                0.99,
            )
            .unwrap(),
            ScientificConfig::new(
                21,
                HashAlgorithm::NtHash2,
                0,
                256,
                14,
                32,
                OphJaccardEstimator::BbitCollisionCorrected,
                10,
                0,
                0.80,
                0.99,
            )
            .unwrap(),
            ScientificConfig::new(
                21,
                HashAlgorithm::NtHash2,
                0,
                256,
                14,
                32,
                OphJaccardEstimator::VerifiedWinners,
                11,
                0,
                0.80,
                0.99,
            )
            .unwrap(),
            ScientificConfig::new(
                21,
                HashAlgorithm::NtHash2,
                0,
                256,
                14,
                32,
                OphJaccardEstimator::VerifiedWinners,
                10,
                2_048,
                0.80,
                0.99,
            )
            .unwrap(),
            ScientificConfig::new(
                21,
                HashAlgorithm::NtHash2,
                0,
                256,
                14,
                32,
                OphJaccardEstimator::VerifiedWinners,
                10,
                0,
                0.81,
                0.99,
            )
            .unwrap(),
            ScientificConfig::new(
                21,
                HashAlgorithm::NtHash2,
                0,
                256,
                14,
                32,
                OphJaccardEstimator::VerifiedWinners,
                10,
                0,
                0.80,
                0.98,
            )
            .unwrap(),
        ];
        let identities = configurations
            .into_iter()
            .map(ScientificConfig::identity)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(identities.len(), configurations.len());
    }
}
