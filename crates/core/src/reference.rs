//! Exact small-input set calculations used for scientific validation.

use crate::dna::{Orientation, PackedSequence};
use crate::hash::hash_canonical;
use std::collections::BTreeMap;

/// Exact distinct canonical k-mer hash set with combined strand observations.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ExactHashSet {
    items: BTreeMap<u64, Orientation>,
}

impl ExactHashSet {
    /// Constructs the exact set of valid k-mers starting in `[start, end)`.
    ///
    /// # Panics
    ///
    /// Panics if `k` is outside `1..=31`.
    pub fn from_interval(
        sequence: &PackedSequence,
        start: u64,
        end: u64,
        k: u8,
        seed: u64,
    ) -> Self {
        let mut items = BTreeMap::<u64, Orientation>::new();
        for kmer in sequence.canonical_kmers(k, start, end) {
            let hash = hash_canonical(kmer.bits, k, seed);
            items
                .entry(hash)
                .and_modify(|orientation| {
                    *orientation = orientation.combine(kmer.orientation);
                })
                .or_insert(kmer.orientation);
        }
        Self { items }
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
    pub fn containment_in(&self, other: &Self) -> Option<f64> {
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
    pub fn jaccard(&self, other: &Self) -> Option<f64> {
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
    x_core: &ExactHashSet,
    x_expanded: &ExactHashSet,
    y_core: &ExactHashSet,
    y_expanded: &ExactHashSet,
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
        let core = ExactHashSet::from_interval(&sequence, 5, 15, 7, 42);
        let expanded = ExactHashSet::from_interval(&sequence, 0, 25, 7, 42);
        assert_eq!(core.containment_in(&expanded), Some(1.0));
    }
}
