//! Deterministic canonical ntHash2 stream used by the production estimator.

use crate::dna::{Orientation, PackedSequence};

/// Selected production hash stream.
///
/// The enum remains part of scientific provenance so a future hash change requires an
/// explicit configuration-version change. No runtime-selectable alternative is shipped.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(u8)]
pub enum HashAlgorithm {
    /// Official ntHash2 canonical split-rotation hash.
    NtHash2 = 1,
}

impl HashAlgorithm {
    /// Stable identifier used by configuration digests and provenance.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NtHash2 => "nthash2",
        }
    }
}

/// One coordinate-preserving canonical hash.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PositionedHash {
    /// Zero-based k-mer start coordinate.
    pub start: u64,
    /// Strand-invariant 64-bit hash.
    pub hash: u64,
    /// Orientation used for forward/reverse match classification.
    pub orientation: Orientation,
}

/// Streams canonical ntHash2 hashes for k-mer starts in `[start, end)`.
///
/// Seed zero returns the exact published ntHash2 canonical stream and is the only
/// production setting. Nonzero seeds apply `fmix64(hash ^ seed)` and exist solely for
/// multi-seed statistical validation; the direct production iterator pays no extra
/// finalizer or per-k-mer seed branch.
///
/// # Panics
///
/// Panics if `k` is outside `1..=31`.
pub fn canonical_hashes(
    sequence: &PackedSequence,
    k: u8,
    start: u64,
    end: u64,
    algorithm: HashAlgorithm,
    seed: u64,
) -> CanonicalHashIter<'_> {
    match algorithm {
        HashAlgorithm::NtHash2 if seed == 0 => {
            CanonicalHashIter::NtHash2(NtHash2Iter::new(sequence, k, start, end))
        }
        HashAlgorithm::NtHash2 => CanonicalHashIter::SeededNtHash2 {
            inner: NtHash2Iter::new(sequence, k, start, end),
            seed,
        },
    }
}

/// Direct production ntHash2 stream or a validation-only seeded permutation of it.
pub enum CanonicalHashIter<'a> {
    /// Exact published ntHash2 output used by production seed zero.
    NtHash2(NtHash2Iter<'a>),
    /// Seeded avalanche used only to sample independent validation layouts.
    SeededNtHash2 {
        /// Underlying exact published ntHash2 stream.
        inner: NtHash2Iter<'a>,
        /// Nonzero validation-only avalanche seed.
        seed: u64,
    },
}

impl Iterator for CanonicalHashIter<'_> {
    type Item = PositionedHash;

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::NtHash2(inner) => inner.next(),
            Self::SeededNtHash2 { inner, seed } => inner.next().map(|mut item| {
                item.hash = fmix64(item.hash ^ *seed);
                item
            }),
        }
    }
}

const NTHASH_SEEDS: [u64; 4] = [
    0x3c8b_fbb3_95c6_0474,
    0x3193_c185_62a0_2b4c,
    0x2032_3ed0_8257_2324,
    0x2955_49f5_4be2_4456,
];

/// Rolling ntHash2 state over packed DNA.
pub struct NtHash2Iter<'a> {
    sequence: &'a PackedSequence,
    k: u8,
    next_base: u64,
    first_start: u64,
    end_start: u64,
    forward_bits: u64,
    reverse_bits: u64,
    forward_hash: u64,
    reverse_hash: u64,
    valid_run: u8,
    mask: u64,
}

impl<'a> NtHash2Iter<'a> {
    fn new(sequence: &'a PackedSequence, k: u8, start: u64, end: u64) -> Self {
        assert!((1..=31).contains(&k), "k must be in 1..=31");
        let start = start.min(sequence.len());
        Self {
            sequence,
            k,
            next_base: start.saturating_sub(u64::from(k - 1)),
            first_start: start,
            end_start: end.min(sequence.len()),
            forward_bits: 0,
            reverse_bits: 0,
            forward_hash: 0,
            reverse_hash: 0,
            valid_run: 0,
            mask: (1_u64 << (2 * k)) - 1,
        }
    }

    fn reset(&mut self) {
        self.forward_bits = 0;
        self.reverse_bits = 0;
        self.forward_hash = 0;
        self.reverse_hash = 0;
        self.valid_run = 0;
    }
}

impl Iterator for NtHash2Iter<'_> {
    type Item = PositionedHash;

    fn next(&mut self) -> Option<Self::Item> {
        while self.next_base < self.sequence.len() {
            let position = self.next_base;
            self.next_base += 1;
            let (code, valid) = self.sequence.get(position)?;
            if !valid {
                self.reset();
                continue;
            }

            if self.valid_run < self.k {
                self.forward_hash = nthash_srol(self.forward_hash) ^ nthash_seed(code);
                self.reverse_hash ^=
                    nthash_srol_by(nthash_seed(3 - code), u32::from(self.valid_run));
                self.valid_run += 1;
            } else {
                let outgoing_position = position - u64::from(self.k);
                let (outgoing, outgoing_valid) = self
                    .sequence
                    .get(outgoing_position)
                    .expect("the outgoing rolling base is within the sequence");
                debug_assert!(outgoing_valid);
                self.forward_hash = nthash_srol(self.forward_hash)
                    ^ nthash_srol_by(nthash_seed(outgoing), u32::from(self.k))
                    ^ nthash_seed(code);
                self.reverse_hash ^= nthash_srol_by(nthash_seed(3 - code), u32::from(self.k));
                self.reverse_hash ^= nthash_seed(3 - outgoing);
                self.reverse_hash = nthash_sror(self.reverse_hash);
            }

            self.forward_bits = ((self.forward_bits << 2) | u64::from(code)) & self.mask;
            self.reverse_bits =
                (self.reverse_bits >> 2) | (u64::from(3 - code) << (2 * (self.k - 1)));
            if self.valid_run < self.k {
                continue;
            }

            let kmer_start = position + 1 - u64::from(self.k);
            if kmer_start < self.first_start {
                continue;
            }
            if kmer_start >= self.end_start {
                return None;
            }
            let orientation = match self.forward_bits.cmp(&self.reverse_bits) {
                std::cmp::Ordering::Less => Orientation::Forward,
                std::cmp::Ordering::Greater => Orientation::Reverse,
                std::cmp::Ordering::Equal => Orientation::Both,
            };
            return Some(PositionedHash {
                start: kmer_start,
                hash: self.forward_hash.wrapping_add(self.reverse_hash),
                orientation,
            });
        }
        None
    }
}

fn nthash_seed(code: u8) -> u64 {
    NTHASH_SEEDS[usize::from(code)]
}

/// ntHash2 split-rotates independent 33- and 31-bit subwords.
fn nthash_srol(value: u64) -> u64 {
    let wrapped = ((value & 0x8000_0000_0000_0000) >> 30) | ((value & 0x1_0000_0000) >> 32);
    ((value << 1) & 0xffff_fffd_ffff_ffff) | wrapped
}

fn nthash_srol_by(value: u64, distance: u32) -> u64 {
    if distance == 0 {
        return value;
    }
    debug_assert!(distance <= 31);
    let rotated = value.rotate_left(distance);
    let crossing = (rotated ^ (rotated >> 33)) & (u64::MAX >> (64 - distance));
    rotated ^ (crossing | (crossing << 33))
}

fn nthash_sror(value: u64) -> u64 {
    let wrapped = ((value & 0x2_0000_0000) << 30) | ((value & 1) << 32);
    ((value >> 1) & 0xffff_fffe_ffff_ffff) | wrapped
}

/// `MurmurHash3`'s `fmix64` finalizer, retained only for internal decorrelation.
pub(crate) fn fmix64(mut value: u64) -> u64 {
    value ^= value >> 33;
    value = value.wrapping_mul(0xff51_afd7_ed55_8ccd);
    value ^= value >> 33;
    value = value.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    value ^ (value >> 33)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn nthash2_matches_official_commit_c26bd45_vectors() {
        let sequence = PackedSequence::from_ascii("official", b"ATCGTACGATGCATGCATGCTGACG");
        let observed = canonical_hashes(&sequence, 6, 0, sequence.len(), HashAlgorithm::NtHash2, 0)
            .map(|item| item.hash)
            .collect::<Vec<_>>();
        let expected = [
            0x245f_4291_74d6_e9b1,
            0xadc1_da5b_636f_030c,
            0x9597_8274_7cd4_3a12,
            0xadc1_da5b_636f_030c,
            0x245f_4291_74d6_e9b1,
            0x2879_d1c7_55ac_3c6d,
            0x1f0b_21c5_3d08_9b2c,
            0x8f39_107f_fe94_2fd4,
        ];
        assert_eq!(&observed[..expected.len()], expected);
    }

    #[test]
    fn reverse_complements_have_equal_hashes_and_opposite_strands() {
        let forward = PackedSequence::from_ascii("forward", b"GATTACAGATTACAGATTACA");
        let reverse = PackedSequence::from_ascii("reverse", b"TGTAATCTGTAATCTGTAATC");
        let left = canonical_hashes(&forward, 21, 0, 1, HashAlgorithm::NtHash2, 0)
            .next()
            .unwrap();
        let right = canonical_hashes(&reverse, 21, 0, 1, HashAlgorithm::NtHash2, 0)
            .next()
            .unwrap();
        assert_eq!(left.hash, right.hash);
        assert_ne!(left.orientation, right.orientation);
    }

    #[test]
    fn validation_seed_changes_layout_without_changing_canonical_strand() {
        let forward = PackedSequence::from_ascii("forward", b"GATTACAGATTACAGATTACA");
        let reverse = PackedSequence::from_ascii("reverse", b"TGTAATCTGTAATCTGTAATC");
        let direct = canonical_hashes(&forward, 21, 0, 1, HashAlgorithm::NtHash2, 0)
            .next()
            .unwrap();
        let seeded = canonical_hashes(&forward, 21, 0, 1, HashAlgorithm::NtHash2, 17)
            .next()
            .unwrap();
        let seeded_reverse = canonical_hashes(&reverse, 21, 0, 1, HashAlgorithm::NtHash2, 17)
            .next()
            .unwrap();
        assert_ne!(direct.hash, seeded.hash);
        assert_eq!(seeded.hash, seeded_reverse.hash);
        assert_ne!(seeded.orientation, seeded_reverse.orientation);
    }

    #[test]
    fn nthash2_range_and_ambiguity_match_coordinate_semantics() {
        let sequence = PackedSequence::from_ascii("range", b"ACGTACGTNACGTACGTACGT");
        let all = canonical_hashes(&sequence, 5, 0, sequence.len(), HashAlgorithm::NtHash2, 0)
            .collect::<Vec<_>>();
        let range =
            canonical_hashes(&sequence, 5, 10, 14, HashAlgorithm::NtHash2, 0).collect::<Vec<_>>();
        let expected = all
            .into_iter()
            .filter(|item| (10..14).contains(&item.start))
            .collect::<Vec<_>>();
        assert_eq!(range, expected);
    }

    #[test]
    fn nthash2_has_uniform_oph_buckets_without_observed_collisions() {
        let mut state = 0x6a09_e667_f3bc_c909_u64;
        let mut ascii = Vec::with_capacity(131_072);
        for _ in 0..ascii.capacity() {
            state = state
                .wrapping_mul(2_862_933_555_777_941_757)
                .wrapping_add(3_037_000_493);
            ascii.push(b"ACGT"[((state >> 61) & 3) as usize]);
        }
        let sequence = PackedSequence::from_ascii("uniformity", &ascii);
        let mut buckets = vec![0_u32; 1_024];
        let mut observed = HashMap::<u64, u64>::new();
        let kmers = sequence.canonical_kmers(21, 0, sequence.len());
        let hashes = canonical_hashes(&sequence, 21, 0, sequence.len(), HashAlgorithm::NtHash2, 0);
        for (kmer, item) in kmers.zip(hashes) {
            let bucket = usize::try_from(item.hash >> 54).expect("ten bits fit usize");
            buckets[bucket] += 1;
            if let Some(previous) = observed.insert(item.hash, kmer.bits) {
                assert_eq!(previous, kmer.bits, "64-bit hash collision");
            }
        }
        let total = buckets.iter().sum::<u32>();
        let expected = f64::from(total) / 1_024.0;
        let chi_square = buckets
            .into_iter()
            .map(|count| {
                let delta = f64::from(count) - expected;
                delta * delta / expected
            })
            .sum::<f64>();
        assert!(chi_square < 1_350.0, "nonuniform OPH buckets: {chi_square}");
    }
}
