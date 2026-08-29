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

/// Compact sequence storage using two bits per base and one validity bit per base.
#[derive(Clone, Default, Eq, PartialEq)]
pub struct PackedSequence {
    name: String,
    len: u64,
    bases: Vec<u8>,
    valid: Vec<u8>,
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
        if base_index.is_multiple_of(8) {
            self.valid.push(0);
        }

        let base_shift = (base_index % 4) * 2;
        self.bases[base_index / 4] |= code << base_shift;
        if is_valid {
            self.valid[base_index / 8] |= 1 << (base_index % 8);
        }
        self.len += 1;
    }

    /// Returns the two-bit base and validity at `position`.
    pub fn get(&self, position: u64) -> Option<(u8, bool)> {
        if position >= self.len {
            return None;
        }
        let position = usize::try_from(position).ok()?;
        let code = (self.bases[position / 4] >> ((position % 4) * 2)) & 0b11;
        let valid = (self.valid[position / 8] & (1 << (position % 8))) != 0;
        Some((code, valid))
    }

    /// Returns packed base bytes for persistence or Wasm transfer.
    pub fn packed_bases(&self) -> &[u8] {
        &self.bases
    }

    /// Returns the validity bitmap for persistence or Wasm transfer.
    pub fn validity_bits(&self) -> &[u8] {
        &self.valid
    }

    /// Approximate bytes owned by heap allocations, excluding allocator overhead.
    pub fn estimated_heap_bytes(&self) -> usize {
        self.name
            .capacity()
            .saturating_add(self.bases.capacity())
            .saturating_add(self.valid.capacity())
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
