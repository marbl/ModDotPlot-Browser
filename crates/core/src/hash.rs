//! Deterministic rolling and MashMap-compatible hash backends.

use crate::dna::{CanonicalKmerIter, Orientation, PackedSequence};

/// Hash streams evaluated by the direct OPH backend.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(u8)]
pub enum HashAlgorithm {
    /// Canonical packed two-bit word followed by `fmix64`.
    PackedFmix64 = 0,
    /// Official ntHash2 canonical split-rotation hash.
    NtHash2 = 1,
    /// MashMap-compatible `MurmurHash3` over both ASCII strands.
    MashMapMurmur3 = 2,
}

impl HashAlgorithm {
    /// Stable identifier used by benchmark reports and persisted metadata.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PackedFmix64 => "packed_fmix64",
            Self::NtHash2 => "nthash2",
            Self::MashMapMurmur3 => "mashmap_murmur3",
        }
    }

    /// Converts the stable numeric representation used by the Wasm benchmark API.
    pub const fn from_id(id: u8) -> Option<Self> {
        match id {
            0 => Some(Self::PackedFmix64),
            1 => Some(Self::NtHash2),
            2 => Some(Self::MashMapMurmur3),
            _ => None,
        }
    }
}

/// One coordinate-preserving canonical hash from an interchangeable backend.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PositionedHash {
    /// Zero-based k-mer start coordinate.
    pub start: u64,
    /// Strand-invariant 64-bit hash.
    pub hash: u64,
    /// Orientation used for forward/reverse match classification.
    pub orientation: Orientation,
}

/// A canonical hash and its orientation relative to the source sequence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CanonicalHash {
    /// Lower of the forward and reverse-complement hashes.
    pub hash: u64,
    /// Orientation of the representation that produced `hash`.
    pub orientation: Orientation,
}

/// Iterator over one of the supported canonical hash streams.
pub enum CanonicalHashIter<'a> {
    /// Packed canonical two-bit k-mers with a short avalanche finalizer.
    Packed {
        /// Coordinate-preserving canonical k-mer stream.
        kmers: CanonicalKmerIter<'a>,
        /// K-mer length mixed into each hash.
        k: u8,
        /// Public deterministic seed.
        seed: u64,
    },
    /// Native ntHash2 rolling state.
    NtHash2(NtHash2Iter<'a>),
    /// MashMap-compatible `MurmurHash3` reference stream.
    MashMap {
        /// Coordinate-preserving canonical k-mer stream.
        kmers: CanonicalKmerIter<'a>,
        /// K-mer length used to restore the two ASCII strands.
        k: u8,
        /// MashMap-compatible 32-bit `MurmurHash3` seed.
        seed: u32,
    },
}

impl Iterator for CanonicalHashIter<'_> {
    type Item = PositionedHash;

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::Packed { kmers, k, seed } => kmers.next().map(|kmer| PositionedHash {
                start: kmer.start,
                hash: hash_canonical(kmer.bits, *k, *seed),
                orientation: kmer.orientation,
            }),
            Self::NtHash2(iterator) => iterator.next(),
            Self::MashMap { kmers, k, seed } => kmers.next().map(|kmer| {
                let selected = mashmap_hash_canonical(kmer.bits, *k, kmer.orientation, *seed);
                PositionedHash {
                    start: kmer.start,
                    hash: selected.hash,
                    orientation: selected.orientation,
                }
            }),
        }
    }
}

/// Streams canonical hashes for k-mer starts in `[start, end)`.
///
/// The ntHash2 stream is a clean Rust implementation of the published split-rotation
/// recurrence. It is pinned against official implementation vectors in this module's
/// tests. The `MashMap` stream intentionally reconstructs ASCII strands to remain a
/// faithful, slower scientific reference.
///
/// # Panics
///
/// Panics if `k` is outside `1..=31`, or if the seed cannot fit the MashMap-compatible
/// 32-bit seed when that reference backend is selected.
pub fn canonical_hashes(
    sequence: &PackedSequence,
    k: u8,
    start: u64,
    end: u64,
    algorithm: HashAlgorithm,
    seed: u64,
) -> CanonicalHashIter<'_> {
    match algorithm {
        HashAlgorithm::PackedFmix64 => CanonicalHashIter::Packed {
            kmers: sequence.canonical_kmers(k, start, end),
            k,
            seed,
        },
        HashAlgorithm::NtHash2 => {
            CanonicalHashIter::NtHash2(NtHash2Iter::new(sequence, k, start, end))
        }
        HashAlgorithm::MashMapMurmur3 => CanonicalHashIter::MashMap {
            kmers: sequence.canonical_kmers(k, start, end),
            k,
            seed: u32::try_from(seed).expect("MashMap's seed is a u32"),
        },
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

/// Hashes a canonical two-bit k-mer with a fixed integer-only finalizer.
///
/// The length is mixed explicitly so differently sized k-mers with the same leading
/// encoding do not share a hash. This backend is versioned independently from the
/// pinned MashMap-reference hash.
pub fn hash_canonical(bits: u64, k: u8, seed: u64) -> u64 {
    let length_tag = u64::from(k).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    fmix64(bits ^ seed ^ length_tag)
}

/// Hashes both orientations exactly as `MashMap3` and selects the lower value.
///
/// `MashMap3` applies `MurmurHash3_x64_128` with seed 42 to ASCII forward and
/// reverse-complement k-mers, then retains the first 64-bit word. `bits` is the
/// canonical two-bit representation produced by [`crate::dna::PackedSequence`];
/// `canonical_orientation` identifies whether that representation was forward or
/// reverse relative to the source.
///
/// # Panics
///
/// Panics if `k` is outside `1..=31`.
pub fn mashmap_hash_canonical(
    bits: u64,
    k: u8,
    canonical_orientation: Orientation,
    seed: u32,
) -> CanonicalHash {
    assert!((1..=31).contains(&k));
    let mut canonical = [0_u8; 31];
    for (index, output) in canonical.iter_mut().enumerate().take(usize::from(k)) {
        let shift = 2 * (usize::from(k) - index - 1);
        *output = b"ACGT"[((bits >> shift) & 3) as usize];
    }
    let canonical = &canonical[..usize::from(k)];
    let mut opposite = [0_u8; 31];
    for (output, &base) in opposite.iter_mut().zip(canonical.iter().rev()) {
        *output = match base {
            b'A' => b'T',
            b'C' => b'G',
            b'G' => b'C',
            b'T' => b'A',
            _ => unreachable!("the decoded two-bit alphabet is always canonical DNA"),
        };
    }
    let canonical_hash = murmur3_x64_128_first(canonical, seed);
    let opposite_hash = murmur3_x64_128_first(&opposite[..usize::from(k)], seed);
    match canonical_hash.cmp(&opposite_hash) {
        std::cmp::Ordering::Less => CanonicalHash {
            hash: canonical_hash,
            orientation: canonical_orientation,
        },
        std::cmp::Ordering::Greater => CanonicalHash {
            hash: opposite_hash,
            orientation: opposite_orientation(canonical_orientation),
        },
        std::cmp::Ordering::Equal => CanonicalHash {
            hash: canonical_hash,
            orientation: Orientation::Both,
        },
    }
}

/// Returns the first 64-bit word of `MurmurHash3_x64_128`.
///
/// This integer-only implementation explicitly reads little-endian blocks, matching
/// `MashMap`'s supported x86-64 platforms while remaining deterministic in WebAssembly.
pub fn murmur3_x64_128_first(bytes: &[u8], seed: u32) -> u64 {
    const C1: u64 = 0x87c3_7b91_1142_53d5;
    const C2: u64 = 0x4cf5_ad43_2745_937f;
    let mut h1 = u64::from(seed);
    let mut h2 = u64::from(seed);
    let (blocks, tail) = bytes.as_chunks::<16>();
    for block in blocks {
        let mut first = [0_u8; 8];
        let mut second = [0_u8; 8];
        first.copy_from_slice(&block[..8]);
        second.copy_from_slice(&block[8..]);
        let mut k1 = u64::from_le_bytes(first);
        let mut k2 = u64::from_le_bytes(second);

        k1 = k1.wrapping_mul(C1).rotate_left(31).wrapping_mul(C2);
        h1 ^= k1;
        h1 = h1
            .rotate_left(27)
            .wrapping_add(h2)
            .wrapping_mul(5)
            .wrapping_add(0x52dc_e729);

        k2 = k2.wrapping_mul(C2).rotate_left(33).wrapping_mul(C1);
        h2 ^= k2;
        h2 = h2
            .rotate_left(31)
            .wrapping_add(h1)
            .wrapping_mul(5)
            .wrapping_add(0x3849_5ab5);
    }

    let mut k1 = 0_u64;
    let mut k2 = 0_u64;
    for (index, &byte) in tail.iter().take(8).enumerate() {
        k1 ^= u64::from(byte) << (8 * index);
    }
    for (index, &byte) in tail.iter().skip(8).enumerate() {
        k2 ^= u64::from(byte) << (8 * index);
    }
    if tail.len() > 8 {
        h2 ^= k2.wrapping_mul(C2).rotate_left(33).wrapping_mul(C1);
    }
    if !tail.is_empty() {
        h1 ^= k1.wrapping_mul(C1).rotate_left(31).wrapping_mul(C2);
    }

    let length = bytes.len() as u64;
    h1 ^= length;
    h2 ^= length;
    h1 = h1.wrapping_add(h2);
    h2 = h2.wrapping_add(h1);
    h1 = fmix64(h1);
    h2 = fmix64(h2);
    h1 = h1.wrapping_add(h2);
    h1
}

fn opposite_orientation(orientation: Orientation) -> Orientation {
    match orientation {
        Orientation::Forward => Orientation::Reverse,
        Orientation::Reverse => Orientation::Forward,
        Orientation::Both => Orientation::Both,
        Orientation::Unknown => Orientation::Unknown,
    }
}

/// `MurmurHash3`'s 64-bit avalanche finalizer.
pub fn fmix64(mut value: u64) -> u64 {
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
    fn hashing_is_deterministic_and_length_separated() {
        assert_eq!(hash_canonical(123, 21, 42), hash_canonical(123, 21, 42));
        assert_ne!(hash_canonical(123, 20, 42), hash_canonical(123, 21, 42));
        assert_ne!(hash_canonical(123, 21, 41), hash_canonical(123, 21, 42));
    }

    #[test]
    fn murmur_empty_vector_matches_the_reference_definition() {
        assert_eq!(murmur3_x64_128_first(b"", 0), 0);
    }

    #[test]
    fn murmur_vectors_match_mashmap_commit_1a07d0e() {
        let fixtures = [
            (b"".as_slice(), 17_305_828_677_633_410_339_u64),
            (b"A".as_slice(), 16_750_156_190_880_784_680),
            (b"ACGA".as_slice(), 3_697_418_565_283_905_118),
            (b"ACGTACGTACGTACGT".as_slice(), 4_706_917_051_267_373_191),
            (
                b"GATTACAGATTACAGATTACA".as_slice(),
                14_386_777_217_808_752_167,
            ),
        ];
        for (sequence, expected) in fixtures {
            assert_eq!(murmur3_x64_128_first(sequence, 42), expected);
        }
    }

    #[test]
    fn mashmap_hash_is_reverse_complement_invariant_with_opposite_strand() {
        let forward = mashmap_hash_canonical(0b00_01_10_00, 4, Orientation::Forward, 42);
        let reverse = mashmap_hash_canonical(0b00_01_10_00, 4, Orientation::Reverse, 42);
        assert_eq!(forward.hash, reverse.hash);
        assert_eq!(
            forward.orientation,
            opposite_orientation(reverse.orientation)
        );
    }

    #[test]
    fn nthash2_matches_official_commit_c26bd45_vectors() {
        let sequence = PackedSequence::from_ascii("official", b"ATCGTACGATGCATGCATGCTGACG");
        let observed =
            canonical_hashes(&sequence, 6, 0, sequence.len(), HashAlgorithm::NtHash2, 42)
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
    fn every_hash_stream_is_reverse_complement_invariant() {
        let forward = PackedSequence::from_ascii("forward", b"GATTACAGATTACAGATTACA");
        let reverse = PackedSequence::from_ascii("reverse", b"TGTAATCTGTAATCTGTAATC");
        for algorithm in [
            HashAlgorithm::PackedFmix64,
            HashAlgorithm::NtHash2,
            HashAlgorithm::MashMapMurmur3,
        ] {
            let left = canonical_hashes(&forward, 21, 0, 1, algorithm, 42)
                .next()
                .unwrap();
            let right = canonical_hashes(&reverse, 21, 0, 1, algorithm, 42)
                .next()
                .unwrap();
            assert_eq!(left.hash, right.hash, "{algorithm:?}");
            assert_ne!(left.orientation, right.orientation, "{algorithm:?}");
        }
    }

    #[test]
    fn nthash2_range_and_ambiguity_match_coordinate_semantics() {
        let sequence = PackedSequence::from_ascii("range", b"ACGTACGTNACGTACGTACGT");
        let all = canonical_hashes(&sequence, 5, 0, sequence.len(), HashAlgorithm::NtHash2, 42)
            .collect::<Vec<_>>();
        let range =
            canonical_hashes(&sequence, 5, 10, 14, HashAlgorithm::NtHash2, 42).collect::<Vec<_>>();
        let expected = all
            .into_iter()
            .filter(|item| (10..14).contains(&item.start))
            .collect::<Vec<_>>();
        assert_eq!(range, expected);
    }

    #[test]
    fn backend_hashes_have_uniform_oph_buckets_without_observed_collisions() {
        let mut state = 0x6a09_e667_f3bc_c909_u64;
        let mut ascii = Vec::with_capacity(131_072);
        for _ in 0..ascii.capacity() {
            state = state
                .wrapping_mul(2_862_933_555_777_941_757)
                .wrapping_add(3_037_000_493);
            ascii.push(b"ACGT"[((state >> 61) & 3) as usize]);
        }
        let sequence = PackedSequence::from_ascii("uniformity", &ascii);
        for algorithm in [
            HashAlgorithm::PackedFmix64,
            HashAlgorithm::NtHash2,
            HashAlgorithm::MashMapMurmur3,
        ] {
            let mut buckets = vec![0_u32; 1_024];
            let mut observed = HashMap::<u64, u64>::new();
            let kmers = sequence.canonical_kmers(21, 0, sequence.len());
            let hashes = canonical_hashes(&sequence, 21, 0, sequence.len(), algorithm, 42);
            for (kmer, item) in kmers.zip(hashes) {
                let bucket = usize::try_from(item.hash >> 54).expect("ten bits fit usize");
                buckets[bucket] += 1;
                if let Some(previous) = observed.insert(item.hash, kmer.bits) {
                    assert_eq!(previous, kmer.bits, "64-bit collision in {algorithm:?}");
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
            if algorithm == HashAlgorithm::MashMapMurmur3 {
                assert!(
                    chi_square > 10_000.0,
                    "MashMap's min-of-strands hash should expose its OPH bucket bias"
                );
            } else {
                assert!(
                    chi_square < 1_350.0,
                    "nonuniform OPH buckets for {algorithm:?}: chi-square={chi_square}"
                );
            }
        }
    }
}
