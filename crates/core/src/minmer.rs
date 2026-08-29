//! Simple bottom-s and minmer reference algorithms.
//!
//! These routines favor clarity over asymptotic performance. The rolling production
//! index is tested against them on bounded fixtures.

use crate::containment::DirectionEvidence;
use crate::dna::{Orientation, PackedSequence};
use crate::hash::{CanonicalHash, mashmap_hash_canonical};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

/// A distinct retained hash and its observed canonical orientation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BottomSItem {
    /// Canonical k-mer hash.
    pub hash: u64,
    /// Combined orientation of occurrences producing the hash.
    pub orientation: Orientation,
}

/// Directed containment estimated from a coordinated union bottom-s sample.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BottomSContainment {
    /// Fraction of sampled x hashes also present in y.
    pub containment: f64,
    /// ANI-like transform `containment^(1/k)`.
    pub ani: f64,
    /// Directional evidence among shared sampled hashes.
    pub direction: DirectionEvidence,
    /// Sampled union hashes belonging to x.
    pub sampled_x: u32,
    /// Sampled union hashes shared by x and y.
    pub shared: u32,
}

/// Reference result for one sliding minmer window.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WindowMinmers {
    /// Zero-based start coordinate in k-mer-start space.
    pub window_start: u64,
    /// Sorted lowest distinct hashes in the window.
    pub items: Vec<BottomSItem>,
}

/// Half-open range of window starts for which a hash remains a selected minmer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MinmerInterval {
    /// MashMap-compatible canonical hash.
    pub hash: u64,
    /// First window start selecting this hash.
    pub window_start_begin: u64,
    /// First subsequent window start not selecting this hash.
    pub window_start_end: u64,
    /// Combined orientation of occurrences active in the selected windows.
    pub orientation: Orientation,
}

/// Sparse fixed-window minmer interval index for one sequence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MinmerIndex {
    /// K-mer length.
    pub k: u8,
    /// Sliding-window width in k-mer start positions.
    pub window_size: u64,
    /// Number of lowest distinct hashes selected per window.
    pub sketch_size: usize,
    /// Number of indexed window starts.
    pub window_count: u64,
    /// Intervals sorted by start, then end and hash.
    pub intervals: Vec<MinmerInterval>,
}

impl MinmerIndex {
    /// Reconstructs the sorted minmers selected at one indexed window start.
    ///
    /// This direct query is intended for validation and bounded fallback paths. A
    /// production shard query uses the same interval semantics with a sparse directory.
    ///
    /// # Panics
    ///
    /// Panics if `window_start` is outside the indexed window domain.
    pub fn window_minmers(&self, window_start: u64) -> Vec<BottomSItem> {
        assert!(window_start < self.window_count);
        let mut selected = self
            .intervals
            .iter()
            .filter(|interval| {
                interval.window_start_begin <= window_start
                    && window_start < interval.window_start_end
            })
            .map(|interval| BottomSItem {
                hash: interval.hash,
                orientation: interval.orientation,
            })
            .collect::<Vec<_>>();
        selected.sort_unstable_by_key(|item| item.hash);
        selected
    }

    /// Returns the bottom-s union of minmers selected by a range of window starts.
    ///
    /// This is the query used to reconstruct the bottom-s sketch of a sequence range
    /// at least `window_size` k-mer starts long. `window_start_end` is exclusive and
    /// both coordinates are clipped to the indexed window domain.
    pub fn range_minmers(
        &self,
        window_start_begin: u64,
        window_start_end: u64,
    ) -> Vec<BottomSItem> {
        let begin = window_start_begin.min(self.window_count);
        let end = window_start_end.min(self.window_count);
        if begin >= end {
            return Vec::new();
        }
        bottom_s(
            self.intervals
                .iter()
                .filter(|interval| {
                    interval.window_start_begin < end && begin < interval.window_start_end
                })
                .map(|interval| (interval.hash, interval.orientation)),
            self.sketch_size,
        )
    }

    /// Approximate bytes owned by the interval vector.
    pub fn estimated_heap_bytes(&self) -> usize {
        self.intervals
            .capacity()
            .saturating_mul(std::mem::size_of::<MinmerInterval>())
    }
}

/// Returns the lowest `s` distinct hashes in sorted order.
pub fn bottom_s<I>(items: I, s: usize) -> Vec<BottomSItem>
where
    I: IntoIterator<Item = (u64, Orientation)>,
{
    if s == 0 {
        return Vec::new();
    }

    let mut selected = BTreeMap::<u64, Orientation>::new();
    for (hash, orientation) in items {
        selected
            .entry(hash)
            .and_modify(|stored| *stored = stored.combine(orientation))
            .or_insert(orientation);
        if selected.len() > s {
            selected.pop_last();
        }
    }
    selected
        .into_iter()
        .map(|(hash, orientation)| BottomSItem { hash, orientation })
        .collect()
}

/// Computes a MashMap-compatible bottom-s sketch for a k-mer-start range.
///
/// # Panics
///
/// Panics if `k` is invalid or `seed` does not fit `MashMap`'s 32-bit parameter.
pub fn mashmap_bottom_s_range(
    sequence: &PackedSequence,
    k: u8,
    start: u64,
    end: u64,
    s: usize,
    seed: u64,
) -> Vec<BottomSItem> {
    let seed = u32::try_from(seed).expect("MashMap's seed is a u32");
    bottom_s(
        sequence.canonical_kmers(k, start, end).map(|kmer| {
            let selected = mashmap_hash_canonical(kmer.bits, k, kmer.orientation, seed);
            (selected.hash, selected.orientation)
        }),
        s,
    )
}

/// Estimates directed containment using the lowest `s` hashes of the sketch union.
///
/// Both inputs must be sorted, distinct bottom-s sketches built with the same hash
/// function and maximum sketch size. When the union has at most `s` hashes, the result
/// is exact. Otherwise it is an unbiased coordinated sample conditional on the number
/// of sampled x hashes.
///
/// # Panics
///
/// Panics if either input contains more than `s` items or is not strictly hash-sorted.
pub fn estimate_bottom_s_containment(
    x: &[BottomSItem],
    y: &[BottomSItem],
    k: u8,
    s: usize,
) -> Option<BottomSContainment> {
    assert!(x.len() <= s && y.len() <= s);
    assert!(x.windows(2).all(|pair| pair[0].hash < pair[1].hash));
    assert!(y.windows(2).all(|pair| pair[0].hash < pair[1].hash));
    let mut x_index = 0;
    let mut y_index = 0;
    let mut sampled = 0;
    let mut sampled_x = 0_u32;
    let mut shared = 0_u32;
    let mut direction = DirectionEvidence::default();
    while sampled < s && (x_index < x.len() || y_index < y.len()) {
        let x_item = x.get(x_index);
        let y_item = y.get(y_index);
        match (x_item, y_item) {
            (Some(left), Some(right)) if left.hash == right.hash => {
                sampled_x += 1;
                shared += 1;
                add_direction(&mut direction, left.orientation, right.orientation);
                x_index += 1;
                y_index += 1;
            }
            (Some(left), Some(right)) if left.hash < right.hash => {
                sampled_x += 1;
                x_index += 1;
            }
            (Some(_) | None, Some(_)) => y_index += 1,
            (Some(_), None) => {
                sampled_x += 1;
                x_index += 1;
            }
            (None, None) => break,
        }
        sampled += 1;
    }
    if sampled_x == 0 {
        return None;
    }
    let containment = f64::from(shared) / f64::from(sampled_x);
    let ani = if containment == 0.0 {
        0.0
    } else {
        containment.powf(1.0 / f64::from(k))
    };
    Some(BottomSContainment {
        containment,
        ani,
        direction,
        sampled_x,
        shared,
    })
}

fn add_direction(evidence: &mut DirectionEvidence, left: Orientation, right: Orientation) {
    match (left, right) {
        (Orientation::Forward, Orientation::Forward)
        | (Orientation::Reverse, Orientation::Reverse) => evidence.forward += 1,
        (Orientation::Forward, Orientation::Reverse)
        | (Orientation::Reverse, Orientation::Forward) => evidence.reverse += 1,
        _ => evidence.ambiguous += 1,
    }
}

/// Computes exact bottom-s minmers independently for every `w`-k-mer window.
///
/// `w` counts consecutive k-mer start positions, matching the minmer definition. A
/// window containing ambiguous sequence may contain fewer than `w` valid k-mers.
///
/// # Panics
///
/// Panics if `w` is zero or if `k` is outside the range supported by packed k-mers.
pub fn reference_window_minmers(
    sequence: &PackedSequence,
    k: u8,
    w: u64,
    s: usize,
    seed: u64,
) -> Vec<WindowMinmers> {
    assert!((1..=31).contains(&k), "k must be in 1..=31");
    assert!(w > 0, "w must be positive");
    let start_count = sequence
        .len()
        .checked_sub(u64::from(k))
        .map_or(0, |difference| difference + 1);
    if start_count < w {
        return Vec::new();
    }

    (0..=start_count - w)
        .map(|window_start| {
            let values = sequence
                .canonical_kmers(k, window_start, window_start + w)
                .map(|kmer| {
                    let selected = mashmap_hash_canonical(
                        kmer.bits,
                        k,
                        kmer.orientation,
                        u32::try_from(seed).expect("MashMap's seed is a u32"),
                    );
                    (selected.hash, selected.orientation)
                });
            WindowMinmers {
                window_start,
                items: bottom_s(values, s),
            }
        })
        .collect()
}

/// Builds exact minmer membership intervals in one bounded-memory sequence scan.
///
/// The maintained state is proportional to the base window and the distinct hashes
/// currently inside it; the function never materializes chromosome-wide k-mer hashes.
/// Every interval is split to span at most `w` window starts, matching `MashMap3`'s
/// indexing invariant.
///
/// # Panics
///
/// Panics if `w` or `s` is zero, `k` is invalid, or the seed does not fit `MashMap`'s
/// 32-bit seed parameter.
#[allow(clippy::too_many_lines)]
pub fn build_minmer_index(
    sequence: &PackedSequence,
    k: u8,
    w: u64,
    s: usize,
    seed: u64,
) -> MinmerIndex {
    assert!((1..=31).contains(&k), "k must be in 1..=31");
    assert!(w > 0, "w must be positive");
    assert!(s > 0, "s must be positive");
    let window_size = usize::try_from(w).expect("window must fit addressable memory");
    let seed = u32::try_from(seed).expect("MashMap's seed is a u32");
    let start_count = sequence
        .len()
        .checked_sub(u64::from(k))
        .map_or(0, |difference| difference + 1);
    let window_count = start_count.saturating_sub(w) + u64::from(start_count >= w);
    if window_count == 0 {
        return MinmerIndex {
            k,
            window_size: w,
            sketch_size: s,
            window_count: 0,
            intervals: Vec::new(),
        };
    }

    let mut kmer_iterator = sequence.canonical_kmers(k, 0, start_count).peekable();
    let mut queue = VecDeque::<Option<CanonicalHash>>::with_capacity(
        usize::try_from(w.min(1_000_000)).expect("bounded queue capacity fits usize"),
    );
    let mut occurrences = BTreeMap::<u64, OrientationCounts>::new();
    let mut selected = BTreeSet::<u64>::new();
    let mut unselected = BTreeSet::<u64>::new();
    let mut active = BTreeMap::<u64, (u64, Orientation)>::new();
    let mut dirty = BTreeSet::<u64>::new();
    let mut intervals = Vec::<MinmerInterval>::new();

    for position in 0..start_count {
        let item = if kmer_iterator
            .peek()
            .is_some_and(|kmer| kmer.start == position)
        {
            let kmer = kmer_iterator.next().expect("peeked k-mer must exist");
            Some(mashmap_hash_canonical(kmer.bits, k, kmer.orientation, seed))
        } else {
            None
        };
        if let Some(item) = item {
            occurrences
                .entry(item.hash)
                .or_default()
                .add(item.orientation);
            if !selected.contains(&item.hash) {
                unselected.insert(item.hash);
            }
            dirty.insert(item.hash);
        }
        queue.push_back(item);

        if queue.len() > window_size
            && let Some(Some(expired)) = queue.pop_front()
        {
            let remove_hash = occurrences
                .get_mut(&expired.hash)
                .expect("queued hash must have occurrence counts");
            remove_hash.remove(expired.orientation);
            if remove_hash.is_empty() {
                occurrences.remove(&expired.hash);
                selected.remove(&expired.hash);
                unselected.remove(&expired.hash);
            }
            dirty.insert(expired.hash);
        }

        if queue.len() == window_size {
            rebalance_selection(&mut selected, &mut unselected, s, &mut dirty);
            let window_start = position + 1 - w;
            reconcile_intervals(
                &occurrences,
                &selected,
                &mut active,
                &dirty,
                window_start,
                w,
                &mut intervals,
            );
            dirty.clear();
        }
    }

    for (hash, (begin, orientation)) in active {
        push_bounded_interval(
            &mut intervals,
            MinmerInterval {
                hash,
                window_start_begin: begin,
                window_start_end: window_count,
                orientation,
            },
            w,
        );
    }
    intervals.sort_unstable_by_key(|interval| {
        (
            interval.window_start_begin,
            interval.window_start_end,
            interval.hash,
        )
    });
    MinmerIndex {
        k,
        window_size: w,
        sketch_size: s,
        window_count,
        intervals,
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct OrientationCounts {
    forward: u32,
    reverse: u32,
    ambiguous: u32,
}

impl OrientationCounts {
    fn add(&mut self, orientation: Orientation) {
        let count = self.counter_mut(orientation);
        *count = count.saturating_add(1);
    }

    fn remove(&mut self, orientation: Orientation) {
        let count = self.counter_mut(orientation);
        assert!(*count > 0, "orientation occurrence count cannot underflow");
        *count -= 1;
    }

    fn counter_mut(&mut self, orientation: Orientation) -> &mut u32 {
        match orientation {
            Orientation::Forward => &mut self.forward,
            Orientation::Reverse => &mut self.reverse,
            Orientation::Both | Orientation::Unknown => &mut self.ambiguous,
        }
    }

    fn is_empty(self) -> bool {
        self.forward == 0 && self.reverse == 0 && self.ambiguous == 0
    }

    fn orientation(self) -> Orientation {
        if self.ambiguous > 0 || (self.forward > 0 && self.reverse > 0) {
            Orientation::Both
        } else if self.forward > 0 {
            Orientation::Forward
        } else if self.reverse > 0 {
            Orientation::Reverse
        } else {
            Orientation::Unknown
        }
    }
}

fn rebalance_selection(
    selected: &mut BTreeSet<u64>,
    unselected: &mut BTreeSet<u64>,
    sketch_size: usize,
    dirty: &mut BTreeSet<u64>,
) {
    while selected.len() < sketch_size {
        let Some(hash) = unselected.pop_first() else {
            break;
        };
        selected.insert(hash);
        dirty.insert(hash);
    }
    while selected.len() > sketch_size {
        let hash = selected.pop_last().expect("nonempty oversized selection");
        unselected.insert(hash);
        dirty.insert(hash);
    }
    while let (Some(&largest), Some(&smallest)) = (selected.last(), unselected.first()) {
        if largest <= smallest {
            break;
        }
        selected.remove(&largest);
        unselected.remove(&smallest);
        selected.insert(smallest);
        unselected.insert(largest);
        dirty.insert(largest);
        dirty.insert(smallest);
    }
}

#[allow(clippy::too_many_arguments)]
fn reconcile_intervals(
    occurrences: &BTreeMap<u64, OrientationCounts>,
    selected: &BTreeSet<u64>,
    active: &mut BTreeMap<u64, (u64, Orientation)>,
    dirty: &BTreeSet<u64>,
    window_start: u64,
    window_size: u64,
    intervals: &mut Vec<MinmerInterval>,
) {
    for &hash in dirty {
        let current = selected.contains(&hash).then(|| {
            occurrences
                .get(&hash)
                .expect("selected hash must exist")
                .orientation()
        });
        let previous = active.get(&hash).copied();
        if previous.is_some_and(|(_, orientation)| Some(orientation) != current) {
            let (begin, orientation) = active.remove(&hash).expect("active hash was just found");
            push_bounded_interval(
                intervals,
                MinmerInterval {
                    hash,
                    window_start_begin: begin,
                    window_start_end: window_start,
                    orientation,
                },
                window_size,
            );
        }
        if let Some(orientation) = current {
            active.entry(hash).or_insert((window_start, orientation));
        }
    }
}

fn push_bounded_interval(
    intervals: &mut Vec<MinmerInterval>,
    interval: MinmerInterval,
    maximum_length: u64,
) {
    let mut begin = interval.window_start_begin;
    while begin < interval.window_start_end {
        let end = begin
            .saturating_add(maximum_length)
            .min(interval.window_start_end);
        intervals.push(MinmerInterval {
            window_start_begin: begin,
            window_start_end: end,
            ..interval
        });
        begin = end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bottom_s_deduplicates_and_combines_orientation() {
        let result = bottom_s(
            [
                (8, Orientation::Forward),
                (2, Orientation::Forward),
                (5, Orientation::Reverse),
                (2, Orientation::Reverse),
            ],
            2,
        );
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].hash, 2);
        assert_eq!(result[0].orientation, Orientation::Both);
        assert_eq!(result[1].hash, 5);
    }

    #[test]
    fn coordinated_union_containment_is_exact_below_capacity() {
        let x = bottom_s([(1, Orientation::Forward), (3, Orientation::Reverse)], 8);
        let y = bottom_s(
            [
                (1, Orientation::Forward),
                (2, Orientation::Forward),
                (3, Orientation::Forward),
            ],
            8,
        );
        let estimate = estimate_bottom_s_containment(&x, &y, 1, 8).unwrap();
        assert!((estimate.containment - 1.0).abs() < f64::EPSILON);
        assert_eq!(estimate.sampled_x, 2);
        assert_eq!(estimate.shared, 2);
        assert_eq!(estimate.direction.forward, 1);
        assert_eq!(estimate.direction.reverse, 1);
    }

    #[test]
    fn every_high_complexity_window_has_s_minmers() {
        let sequence = pseudo_random_sequence(400);
        let packed = PackedSequence::from_ascii("random", &sequence);
        let windows = reference_window_minmers(&packed, 15, 50, 8, 42);
        assert!(!windows.is_empty());
        assert!(windows.iter().all(|window| window.items.len() == 8));
    }

    #[test]
    fn ambiguous_bases_reduce_only_affected_windows() {
        let packed = PackedSequence::from_ascii("ambiguous", b"AAAAANAAAAA");
        let windows = reference_window_minmers(&packed, 3, 4, 3, 42);
        assert!(windows.iter().any(|window| window.items.len() < 3));
        assert!(windows.iter().all(|window| window.items.len() <= 3));
    }

    #[test]
    fn interval_index_exactly_reconstructs_every_reference_window() {
        let mut sequence = pseudo_random_sequence(600);
        sequence[113] = b'N';
        sequence[407] = b'N';
        let packed = PackedSequence::from_ascii("fixture", &sequence);
        let reference = reference_window_minmers(&packed, 15, 47, 9, 42);
        let index = build_minmer_index(&packed, 15, 47, 9, 42);
        assert_eq!(
            usize::try_from(index.window_count).unwrap(),
            reference.len()
        );
        for window in reference {
            assert_eq!(index.window_minmers(window.window_start), window.items);
        }
        assert!(index.intervals.iter().all(|interval| {
            interval.window_start_begin < interval.window_start_end
                && interval.window_start_end - interval.window_start_begin <= 47
        }));
    }

    #[test]
    fn range_query_recovers_longer_window_bottom_s() {
        let sequence = PackedSequence::from_ascii("seq", &pseudo_random_sequence(2_000));
        let index = build_minmer_index(&sequence, 15, 200, 64, 42);
        let expected = mashmap_bottom_s_range(&sequence, 15, 300, 800, 64, 42);
        // A 500-start range contains 301 windows of 200 starts.
        assert_eq!(index.range_minmers(300, 601), expected);
    }

    #[test]
    fn index_handles_windows_with_fewer_distinct_hashes_than_the_sketch() {
        let packed = PackedSequence::from_ascii("low-complexity", b"AAAAAAAAAAAAAAAAAAAA");
        let index = build_minmer_index(&packed, 5, 8, 16, 42);
        assert!((0..index.window_count).all(|window| index.window_minmers(window).len() == 1));
    }

    fn pseudo_random_sequence(length: usize) -> Vec<u8> {
        let mut state = 0x4d59_5df4_d0f3_3173_u64;
        let mut sequence = Vec::with_capacity(length);
        for _ in 0..length {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            sequence.push(b"ACGT"[((state >> 62) & 3) as usize]);
        }
        sequence
    }
}
