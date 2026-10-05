//! Exact small-input set calculations used for scientific validation.

use crate::dna::{Orientation, PackedSequence};
use std::collections::BTreeMap;

/// Exact distinct canonical k-mer set with combined strand observations.
///
/// Canonical two-bit words are injective for the supported `k <= 31`, so this
/// reference is independent of every production hash function and its collision
/// behavior.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ExactKmerSet {
    k: u8,
    items: BTreeMap<u64, Orientation>,
}

impl ExactKmerSet {
    /// Constructs the exact set of valid k-mers starting in `[start, end)`.
    ///
    /// # Panics
    ///
    /// Panics if `k` is outside `1..=31`.
    pub fn from_interval(sequence: &PackedSequence, start: u64, end: u64, k: u8) -> Self {
        let mut items = BTreeMap::<u64, Orientation>::new();
        for kmer in sequence.canonical_kmers(k, start, end) {
            items
                .entry(kmer.bits)
                .and_modify(|orientation| {
                    *orientation = orientation.combine(kmer.orientation);
                })
                .or_insert(kmer.orientation);
        }
        Self { k, items }
    }

    /// Number of distinct hashes.
    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// Returns true when no valid k-mer is present.
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Exact directed containment of this set in `other`.
    ///
    /// # Panics
    ///
    /// Panics if the two exact sets were constructed with different k-mer lengths.
    pub fn containment_in(&self, other: &Self) -> Option<f64> {
        assert_eq!(self.k, other.k, "exact k-mer sets must use the same k");
        if self.is_empty() {
            return None;
        }
        let shared = self
            .items
            .keys()
            .filter(|hash| other.items.contains_key(hash))
            .count();
        Some(count_as_f64(shared) / count_as_f64(self.len()))
    }

    /// Exact Jaccard similarity.
    ///
    /// # Panics
    ///
    /// Panics if the two exact sets were constructed with different k-mer lengths.
    pub fn jaccard(&self, other: &Self) -> Option<f64> {
        assert_eq!(self.k, other.k, "exact k-mer sets must use the same k");
        let union = self
            .items
            .keys()
            .chain(other.items.keys())
            .collect::<std::collections::BTreeSet<_>>();
        if union.is_empty() {
            return None;
        }
        let intersection = self
            .items
            .keys()
            .filter(|hash| other.items.contains_key(hash))
            .count();
        Some(count_as_f64(intersection) / count_as_f64(union.len()))
    }
}

fn count_as_f64(count: usize) -> f64 {
    // Exact reference sets are bounded by the supported one-billion-base sequence
    // length, so their cardinality is representable exactly as both u32 and f64.
    f64::from(u32::try_from(count).expect("exact set exceeds supported sequence length"))
}

/// Exact ModDotPlot-style maximum-containment result.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ExactSimilarity {
    /// Maximum of the two directed core-to-expanded containments.
    pub containment: f64,
    /// ANI transform of `containment`.
    pub ani: f64,
}

/// Computes the exact score for two core sets and their expanded neighbors.
pub fn exact_moddotplot_score(
    x_core: &ExactKmerSet,
    x_expanded: &ExactKmerSet,
    y_core: &ExactKmerSet,
    y_expanded: &ExactKmerSet,
    k: u8,
) -> Option<ExactSimilarity> {
    let x_in_y = x_core.containment_in(y_expanded);
    let y_in_x = y_core.containment_in(x_expanded);
    let containment = match (x_in_y, y_in_x) {
        (Some(left), Some(right)) => left.max(right),
        (Some(value), None) | (None, Some(value)) => value,
        (None, None) => return None,
    };
    let ani = if containment == 0.0 {
        0.0
    } else {
        containment.powf(1.0 / f64::from(k))
    };
    Some(ExactSimilarity { containment, ani })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_is_exactly_contained_in_its_expansion() {
        let sequence = PackedSequence::from_ascii("seq", b"ACGTTGCATGTCGCATGATGCATGAGAGCT");
        let core = ExactKmerSet::from_interval(&sequence, 5, 15, 7);
        let expanded = ExactKmerSet::from_interval(&sequence, 0, 25, 7);
        assert_eq!(core.containment_in(&expanded), Some(1.0));
    }

    #[test]
    fn uracil_and_thymine_have_identical_exact_sets() {
        let rna = PackedSequence::from_ascii("rna", b"ACUUGCUUACGU");
        let dna = PackedSequence::from_ascii("dna", b"ACTTGCTTACGT");
        let rna_set = ExactKmerSet::from_interval(&rna, 0, rna.len(), 5);
        let dna_set = ExactKmerSet::from_interval(&dna, 0, dna.len(), 5);
        assert_eq!(rna_set, dna_set);
        assert_eq!(rna_set.containment_in(&dna_set), Some(1.0));
    }
}
