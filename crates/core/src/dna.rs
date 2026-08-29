//! Packed DNA storage and canonical rolling k-mers.

use std::fmt;

/// Orientation of a canonical k-mer relative to its source sequence.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[repr(u8)]
pub enum Orientation {
    /// The forward representation is canonical.
    Forward = 0,
    /// The reverse-complement representation is canonical.
    Reverse = 1,
    /// Both orientations were observed for a repeated hash or are indistinguishable.
    Both = 2,
    /// No orientation evidence is available.
    #[default]
    Unknown = 3,
}

impl Orientation {
    /// Combines observations of the same canonical hash.
    #[must_use]
    pub fn combine(self, other: Self) -> Self {
        match (self, other) {
            (Self::Unknown, value) | (value, Self::Unknown) => value,
            (left, right) if left == right => left,
            _ => Self::Both,
        }
    }
}

/// A canonical k-mer produced by [`PackedSequence::canonical_kmers`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CanonicalKmer {
    /// Zero-based start coordinate.
    pub start: u64,
    /// Two-bit canonical nucleotide encoding.
    pub bits: u64,
    /// Orientation of the canonical encoding.
    pub orientation: Orientation,
}

const SPARSE_BIT_BLOCK_SHIFT: usize = 12;
const SPARSE_BIT_BLOCK_BITS: usize = 1 << SPARSE_BIT_BLOCK_SHIFT;
const SPARSE_BIT_WORDS: usize = SPARSE_BIT_BLOCK_BITS / u64::BITS as usize;

/// Two-level sparse bit vector used for the uncommon invalid-base positions.
///
/// The first level costs one `u32` only through the last block containing an invalid
/// base. Second-level 4-Kibit blocks are allocated only when at least one bit is set.
/// Lookup remains constant-time in sequence-scanning hot paths.
#[derive(Clone, Default, Eq, PartialEq)]
struct SparseBitVector {
    block_ids: Vec<u32>,
    blocks: Vec<[u64; SPARSE_BIT_WORDS]>,
}

impl SparseBitVector {
    fn insert(&mut self, position: usize) {
        let block_index = position >> SPARSE_BIT_BLOCK_SHIFT;
        if self.block_ids.len() <= block_index {
            self.block_ids.resize(block_index + 1, 0);
        }
        let stored_id = self.block_ids[block_index];
        let block_id = if stored_id == 0 {
            self.blocks.push([0; SPARSE_BIT_WORDS]);
            let new_id = u32::try_from(self.blocks.len())
                .expect("supported sequence has fewer than u32::MAX sparse blocks");
            self.block_ids[block_index] = new_id;
            new_id
        } else {
            stored_id
        };
        let within_block = position & (SPARSE_BIT_BLOCK_BITS - 1);
        self.blocks[block_id as usize - 1][within_block / u64::BITS as usize] |=
            1_u64 << (within_block % u64::BITS as usize);
    }

    fn contains(&self, position: usize) -> bool {
        let block_index = position >> SPARSE_BIT_BLOCK_SHIFT;
        let Some(&block_id) = self.block_ids.get(block_index) else {
            return false;
        };
        if block_id == 0 {
            return false;
        }
        let within_block = position & (SPARSE_BIT_BLOCK_BITS - 1);
        self.blocks[block_id as usize - 1][within_block / u64::BITS as usize]
            & (1_u64 << (within_block % u64::BITS as usize))
            != 0
    }

    fn estimated_heap_bytes(&self) -> usize {
        self.block_ids
            .capacity()
            .saturating_mul(std::mem::size_of::<u32>())
            .saturating_add(
                self.blocks
                    .capacity()
                    .saturating_mul(std::mem::size_of::<[u64; SPARSE_BIT_WORDS]>()),
            )
    }

    fn shrink_to_fit(&mut self) {
        self.block_ids.shrink_to_fit();
        self.blocks.shrink_to_fit();
    }
}

/// Compact sequence storage using two bits per base and sparse invalid-base bits.
#[derive(Clone, Default, Eq, PartialEq)]
pub struct PackedSequence {
    name: String,
    len: u64,
    bases: Vec<u8>,
    invalid: SparseBitVector,
}

impl fmt::Debug for PackedSequence {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PackedSequence")
            .field("name", &self.name)
            .field("len", &self.len)
            .finish_non_exhaustive()
    }
}

impl PackedSequence {
    /// Creates an empty record with the supplied FASTA header.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ..Self::default()
        }
    }

    /// Creates a record from an in-memory ASCII sequence.
    pub fn from_ascii(name: impl Into<String>, sequence: &[u8]) -> Self {
        let mut packed = Self::new(name);
        for &base in sequence {
            packed.push_ascii(base);
        }
        packed
    }

    /// Returns the source FASTA header.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the sequence length in bases.
    pub fn len(&self) -> u64 {
        self.len
    }

    /// Returns true when the sequence contains no bases.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Appends an ASCII nucleotide.
    ///
    /// A/C/G/T are encoded case-insensitively. Other ASCII letters are retained as
    /// invalid bases so their coordinates remain stable and overlapping k-mers are
    /// excluded.
    ///
    /// # Panics
    ///
    /// Panics only if the sequence exceeds the platform's addressable memory. The
    /// supported one-billion-base limit is safely addressable on Wasm32.
    pub fn push_ascii(&mut self, base: u8) {
        let (code, is_valid) = encode_base(base);
        let base_index = usize::try_from(self.len).expect("sequence exceeds addressable memory");
        if base_index.is_multiple_of(4) {
            self.bases.push(0);
        }

        let base_shift = (base_index % 4) * 2;
        self.bases[base_index / 4] |= code << base_shift;
        if !is_valid {
            self.invalid.insert(base_index);
        }
        self.len += 1;
    }

    /// Appends one whitespace-free IUPAC sequence run in packed groups of eight.
    ///
    /// Returns the zero-based position of the first unsupported byte after retaining
    /// the valid prefix. FASTA parsing uses this bulk path to avoid per-base parser
    /// state transitions for ordinary wrapped sequence lines.
    #[inline]
    pub(crate) fn push_iupac_chunk(&mut self, chunk: &[u8]) -> Result<(), usize> {
        let current_len = usize::try_from(self.len).expect("sequence exceeds addressable memory");
        let final_len = current_len.saturating_add(chunk.len());
        self.bases
            .reserve(final_len.div_ceil(4).saturating_sub(self.bases.len()));

        let mut offset = 0;
        while offset < chunk.len() && !self.len.is_multiple_of(8) {
            if encode_iupac_base(chunk[offset]).is_none() {
                return Err(offset);
            }
            self.push_ascii(chunk[offset]);
            offset += 1;
        }

        while offset + 8 <= chunk.len() {
            let c0 = BASE_ENCODING[usize::from(chunk[offset])];
            let c1 = BASE_ENCODING[usize::from(chunk[offset + 1])];
            let c2 = BASE_ENCODING[usize::from(chunk[offset + 2])];
            let c3 = BASE_ENCODING[usize::from(chunk[offset + 3])];
            let c4 = BASE_ENCODING[usize::from(chunk[offset + 4])];
            let c5 = BASE_ENCODING[usize::from(chunk[offset + 5])];
            let c6 = BASE_ENCODING[usize::from(chunk[offset + 6])];
            let c7 = BASE_ENCODING[usize::from(chunk[offset + 7])];
            if (c0 | c1 | c2 | c3 | c4 | c5 | c6 | c7) & UNSUPPORTED_BASE != 0 {
                for index in 0..8 {
                    if encode_iupac_base(chunk[offset + index]).is_none() {
                        return Err(offset + index);
                    }
                    self.push_ascii(chunk[offset + index]);
                }
                offset += 8;
                continue;
            }
            let low = (c0 & 3) | ((c1 & 3) << 2) | ((c2 & 3) << 4) | ((c3 & 3) << 6);
            let high = (c4 & 3) | ((c5 & 3) << 2) | ((c6 & 3) << 4) | ((c7 & 3) << 6);
            let validity = ((c0 >> 2) & 1)
                | (((c1 >> 2) & 1) << 1)
                | (((c2 >> 2) & 1) << 2)
                | (((c3 >> 2) & 1) << 3)
                | (((c4 >> 2) & 1) << 4)
                | (((c5 >> 2) & 1) << 5)
                | (((c6 >> 2) & 1) << 6)
                | (((c7 >> 2) & 1) << 7);
            self.bases.push(low);
            self.bases.push(high);
            if validity != u8::MAX {
                let block_start =
                    usize::try_from(self.len).expect("sequence exceeds addressable memory");
                for index in 0..8 {
                    if validity & (1 << index) == 0 {
                        self.invalid.insert(block_start + index);
                    }
                }
            }
            self.len += 8;
            offset += 8;
        }

        while offset < chunk.len() {
            if encode_iupac_base(chunk[offset]).is_none() {
                return Err(offset);
            }
            self.push_ascii(chunk[offset]);
            offset += 1;
        }
        Ok(())
    }

    /// Returns the two-bit base and validity at `position`.
    pub fn get(&self, position: u64) -> Option<(u8, bool)> {
        if position >= self.len {
            return None;
        }
        let position = usize::try_from(position).ok()?;
        let code = (self.bases[position / 4] >> ((position % 4) * 2)) & 0b11;
        Some((code, !self.invalid.contains(position)))
    }

    /// Returns packed base bytes for persistence or Wasm transfer.
    pub fn packed_bases(&self) -> &[u8] {
        &self.bases
    }

    /// Approximate bytes owned by heap allocations, excluding allocator overhead.
    pub fn estimated_heap_bytes(&self) -> usize {
        self.name
            .capacity()
            .saturating_add(self.bases.capacity())
            .saturating_add(self.invalid.estimated_heap_bytes())
    }

    /// Releases geometric growth slack after a streamed FASTA record is complete.
    pub(crate) fn compact_storage(&mut self) {
        self.name.shrink_to_fit();
        self.bases.shrink_to_fit();
        self.invalid.shrink_to_fit();
    }

    /// Copies a half-open coordinate range into an independently owned sequence.
    ///
    /// This bounded helper is used by scientific fixtures and future sequence shards;
    /// it preserves invalid-base positions as `N` without materializing the complete
    /// source as ASCII.
    ///
    /// # Panics
    ///
    /// Panics only if the requested copy cannot fit in addressable memory.
    #[must_use]
    pub fn subsequence(&self, name: impl Into<String>, start: u64, end: u64) -> Self {
        let start = start.min(self.len);
        let end = end.min(self.len).max(start);
        let mut result = Self::new(name);
        for position in start..end {
            let (code, valid) = self
                .get(position)
                .expect("a position clipped to the sequence is present");
            result.push_ascii(if valid {
                b"ACGT"[usize::from(code)]
            } else {
                b'N'
            });
        }
        result
    }

    /// Iterates canonical k-mers whose starts fall in `[start, end)`.
    ///
    /// K-mers extending beyond the sequence or containing an invalid base are omitted.
    /// `k` is restricted to 31 so both orientations fit in 64 bits.
    ///
    /// # Panics
    ///
    /// Panics if `k` is not in `1..=31`.
    pub fn canonical_kmers(&self, k: u8, start: u64, end: u64) -> CanonicalKmerIter<'_> {
        assert!((1..=31).contains(&k), "k must be in 1..=31");
        CanonicalKmerIter::new(self, k, start.min(self.len), end.min(self.len))
    }
}

/// Iterator returned by [`PackedSequence::canonical_kmers`].
pub struct CanonicalKmerIter<'a> {
    sequence: &'a PackedSequence,
    k: u8,
    next_base: u64,
    first_start: u64,
    end_start: u64,
    forward: u64,
    reverse: u64,
    valid_run: u8,
    mask: u64,
}

impl<'a> CanonicalKmerIter<'a> {
    fn new(sequence: &'a PackedSequence, k: u8, start: u64, end: u64) -> Self {
        let context_start = start.saturating_sub(u64::from(k - 1));
        Self {
            sequence,
            k,
            next_base: context_start,
            first_start: start,
            end_start: end,
            forward: 0,
            reverse: 0,
            valid_run: 0,
            mask: (1_u64 << (2 * k)) - 1,
        }
    }
}

impl Iterator for CanonicalKmerIter<'_> {
    type Item = CanonicalKmer;

    fn next(&mut self) -> Option<Self::Item> {
        while self.next_base < self.sequence.len {
            let position = self.next_base;
            self.next_base += 1;
            let (code, valid) = self.sequence.get(position)?;

            if !valid {
                self.forward = 0;
                self.reverse = 0;
                self.valid_run = 0;
                continue;
            }

            self.forward = ((self.forward << 2) | u64::from(code)) & self.mask;
            let complement = u64::from(3 - code);
            self.reverse = (self.reverse >> 2) | (complement << (2 * (self.k - 1)));
            self.valid_run = self.valid_run.saturating_add(1).min(self.k);

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

            let (bits, orientation) = match self.forward.cmp(&self.reverse) {
                std::cmp::Ordering::Less => (self.forward, Orientation::Forward),
                std::cmp::Ordering::Greater => (self.reverse, Orientation::Reverse),
                std::cmp::Ordering::Equal => (self.forward, Orientation::Both),
            };
            return Some(CanonicalKmer {
                start: kmer_start,
                bits,
                orientation,
            });
        }
        None
    }
}

fn encode_base(base: u8) -> (u8, bool) {
    match base.to_ascii_uppercase() {
        b'A' => (0, true),
        b'C' => (1, true),
        b'G' => (2, true),
        b'T' | b'U' => (3, true),
        _ => (0, false),
    }
}

fn encode_iupac_base(base: u8) -> Option<(u8, bool)> {
    let encoded = BASE_ENCODING[usize::from(base)];
    (encoded & UNSUPPORTED_BASE == 0).then_some((encoded & 3, encoded & VALID_BASE != 0))
}

const VALID_BASE: u8 = 0b0000_0100;
const UNSUPPORTED_BASE: u8 = 0b1000_0000;
const BASE_ENCODING: [u8; 256] = base_encoding();

const fn base_encoding() -> [u8; 256] {
    let mut table = [UNSUPPORTED_BASE; 256];
    table[b'A' as usize] = VALID_BASE;
    table[b'a' as usize] = VALID_BASE;
    table[b'C' as usize] = VALID_BASE | 1;
    table[b'c' as usize] = VALID_BASE | 1;
    table[b'G' as usize] = VALID_BASE | 2;
    table[b'g' as usize] = VALID_BASE | 2;
    table[b'T' as usize] = VALID_BASE | 3;
    table[b't' as usize] = VALID_BASE | 3;
    table[b'U' as usize] = VALID_BASE | 3;
    table[b'u' as usize] = VALID_BASE | 3;
    let ambiguous = b"RYSWKMBDHVNryswkmbdhvn-.";
    let mut index = 0;
    while index < ambiguous.len() {
        table[ambiguous[index] as usize] = 0;
        index += 1;
    }
    table
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packed_round_trip_preserves_validity() {
        let sequence = PackedSequence::from_ascii("test", b"ACGTNacgt");
        assert_eq!(sequence.len(), 9);
        let decoded: Vec<_> = (0..sequence.len())
            .map(|position| sequence.get(position).unwrap())
            .collect();
        assert_eq!(decoded[0], (0, true));
        assert_eq!(decoded[3], (3, true));
        assert_eq!(decoded[4], (0, false));
        assert_eq!(decoded[8], (3, true));
    }

    #[test]
    fn sparse_invalid_bits_cross_block_boundaries() {
        let mut bits = SparseBitVector::default();
        for position in [
            0,
            SPARSE_BIT_BLOCK_BITS - 1,
            SPARSE_BIT_BLOCK_BITS,
            1_000_000,
        ] {
            bits.insert(position);
        }
        for position in [
            0,
            SPARSE_BIT_BLOCK_BITS - 1,
            SPARSE_BIT_BLOCK_BITS,
            1_000_000,
        ] {
            assert!(bits.contains(position));
        }
        for position in [
            1,
            SPARSE_BIT_BLOCK_BITS - 2,
            SPARSE_BIT_BLOCK_BITS + 1,
            999_999,
        ] {
            assert!(!bits.contains(position));
        }
        assert_eq!(bits.blocks.len(), 3);
        assert!(bits.estimated_heap_bytes() < 4_096);
    }

    #[test]
    fn canonical_sequence_does_not_allocate_invalidity_storage() {
        let mut sequence = PackedSequence::from_ascii("valid", &vec![b'A'; 1_000_000]);
        sequence.compact_storage();
        assert_eq!(sequence.invalid.estimated_heap_bytes(), 0);
        assert_eq!(sequence.bases.len(), 250_000);
    }

    #[test]
    fn bulk_iupac_packing_matches_scalar_packing_at_unaligned_boundaries() {
        let mut bulk = PackedSequence::from_ascii("test", b"ACG");
        bulk.push_iupac_chunk(b"TacgUN.-ACGT").unwrap();
        let scalar = PackedSequence::from_ascii("test", b"ACGTacgUN.-ACGT");
        assert_eq!(bulk, scalar);

        let invalid = bulk.push_iupac_chunk(b"ACGT!AAA").unwrap_err();
        assert_eq!(invalid, 4);
        assert_eq!(bulk.len(), scalar.len() + 4);
    }

    #[test]
    fn invalid_bases_break_kmers_without_changing_coordinates() {
        let sequence = PackedSequence::from_ascii("test", b"AAANAAA");
        let starts: Vec<_> = sequence
            .canonical_kmers(3, 0, sequence.len())
            .map(|kmer| kmer.start)
            .collect();
        assert_eq!(starts, vec![0, 4]);
    }

    #[test]
    fn reverse_complements_have_identical_canonical_bits() {
        let forward = PackedSequence::from_ascii("f", b"AACCG");
        let reverse = PackedSequence::from_ascii("r", b"CGGTT");
        let left = forward.canonical_kmers(5, 0, 1).next().unwrap();
        let right = reverse.canonical_kmers(5, 0, 1).next().unwrap();
        assert_eq!(left.bits, right.bits);
        assert_ne!(left.orientation, right.orientation);
    }

    #[test]
    fn range_uses_kmer_start_coordinates() {
        let sequence = PackedSequence::from_ascii("test", b"ACGTACGT");
        let starts: Vec<_> = sequence
            .canonical_kmers(3, 2, 5)
            .map(|kmer| kmer.start)
            .collect();
        assert_eq!(starts, vec![2, 3, 4]);
    }

    #[test]
    fn subsequence_preserves_bases_and_invalid_positions() {
        let sequence = PackedSequence::from_ascii("whole", b"AACGTNCCA");
        let slice = sequence.subsequence("slice", 2, 8);
        let expected = PackedSequence::from_ascii("slice", b"CGTNCC");
        assert_eq!(slice, expected);
    }

    #[test]
    fn uracil_is_normalized_to_thymine_without_coordinate_changes() {
        let uracil = PackedSequence::from_ascii("rna", b"aCuUGcUu");
        let thymine = PackedSequence::from_ascii("dna", b"ACTTGCTT");
        assert_eq!(uracil.len(), thymine.len());
        assert_eq!(
            uracil
                .canonical_kmers(5, 0, uracil.len())
                .collect::<Vec<_>>(),
            thymine
                .canonical_kmers(5, 0, thymine.len())
                .collect::<Vec<_>>(),
        );
    }
}
