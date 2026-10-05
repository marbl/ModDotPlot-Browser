//! Compact, queryable sequence-composition summaries for browser feature tracks.

use crate::dna::PackedSequence;

/// Default number of bases represented by one cumulative index block.
pub const DEFAULT_COMPOSITION_BLOCK_SIZE: u64 = 1_024;

/// Incrementally builds a [`CompositionIndex`] without monopolizing a browser worker turn.
#[derive(Clone, Debug)]
pub struct CompositionIndexBuilder {
    block_size: u64,
    block_count: usize,
    next_block: usize,
    gc_prefix: Vec<u32>,
    cytosine_prefix: Vec<u32>,
    guanine_prefix: Vec<u32>,
    valid_prefix: Vec<u32>,
    cpg_prefix: Vec<u32>,
}

impl CompositionIndexBuilder {
    /// Creates an empty index builder for `sequence`.
    ///
    /// # Panics
    ///
    /// Panics if `block_size` is zero or the resulting index cannot fit in memory.
    #[must_use]
    pub fn new(sequence: &PackedSequence, block_size: u64) -> Self {
        assert!(block_size > 0, "GC block size must be positive");
        let blocks = sequence.len().div_ceil(block_size);
        let block_count = usize::try_from(blocks).expect("GC block count fits addressable memory");
        let mut gc_prefix = Vec::with_capacity(block_count.saturating_add(1));
        let mut cytosine_prefix = Vec::with_capacity(block_count.saturating_add(1));
        let mut guanine_prefix = Vec::with_capacity(block_count.saturating_add(1));
        let mut valid_prefix = Vec::with_capacity(block_count.saturating_add(1));
        let mut cpg_prefix = Vec::with_capacity(block_count.saturating_add(1));
        gc_prefix.push(0);
        cytosine_prefix.push(0);
        guanine_prefix.push(0);
        valid_prefix.push(0);
        cpg_prefix.push(0);
        Self {
            block_size,
            block_count,
            next_block: 0,
            gc_prefix,
            cytosine_prefix,
            guanine_prefix,
            valid_prefix,
            cpg_prefix,
        }
    }

    /// Processes at most `maximum_blocks` and returns completion in `[0, 1]`.
    ///
    /// # Panics
    ///
    /// Panics if `maximum_blocks` is zero or the builder was created for a longer
    /// sequence than the supplied sequence.
    pub fn advance(&mut self, sequence: &PackedSequence, maximum_blocks: usize) -> f64 {
        assert!(maximum_blocks > 0, "GC preparation chunk must be positive");
        let end_block = self
            .next_block
            .saturating_add(maximum_blocks)
            .min(self.block_count);
        let mut gc_total = *self.gc_prefix.last().expect("GC prefix starts at zero");
        let mut cytosine_total = *self
            .cytosine_prefix
            .last()
            .expect("C prefix starts at zero");
        let mut guanine_total = *self.guanine_prefix.last().expect("G prefix starts at zero");
        let mut valid_total = *self
            .valid_prefix
            .last()
            .expect("valid prefix starts at zero");
        let mut cpg_total = *self.cpg_prefix.last().expect("CpG prefix starts at zero");
        for block in self.next_block..end_block {
            let start = u64::try_from(block)
                .expect("GC block index fits u64")
                .saturating_mul(self.block_size);
            let end = start.saturating_add(self.block_size).min(sequence.len());
            for position in start..end {
                let (code, valid) = sequence
                    .get(position)
                    .expect("GC preparation range is clipped to the sequence");
                if valid {
                    valid_total = valid_total.saturating_add(1);
                    match code {
                        1 => {
                            cytosine_total = cytosine_total.saturating_add(1);
                            gc_total = gc_total.saturating_add(1);
                        }
                        2 => {
                            guanine_total = guanine_total.saturating_add(1);
                            gc_total = gc_total.saturating_add(1);
                        }
                        _ => {}
                    }
                    if code == 1
                        && sequence
                            .get(position.saturating_add(1))
                            .is_some_and(|(next, next_valid)| next_valid && next == 2)
                    {
                        cpg_total = cpg_total.saturating_add(1);
                    }
                }
            }
            self.gc_prefix.push(gc_total);
            self.cytosine_prefix.push(cytosine_total);
            self.guanine_prefix.push(guanine_total);
            self.valid_prefix.push(valid_total);
            self.cpg_prefix.push(cpg_total);
        }
        self.next_block = end_block;
        if self.block_count == 0 {
            1.0
        } else {
            let completed =
                u32::try_from(self.next_block).expect("supported GC block count fits u32");
            let total = u32::try_from(self.block_count).expect("supported GC block count fits u32");
            f64::from(completed) / f64::from(total)
        }
    }

    /// Returns true after every sequence block has been processed.
    #[must_use]
    pub fn is_complete(&self) -> bool {
        self.next_block == self.block_count
    }

    /// Approximate bytes owned by the partially built prefix vectors.
    #[must_use]
    pub fn estimated_heap_bytes(&self) -> usize {
        self.gc_prefix
            .capacity()
            .saturating_add(self.cytosine_prefix.capacity())
            .saturating_add(self.guanine_prefix.capacity())
            .saturating_add(self.valid_prefix.capacity())
            .saturating_add(self.cpg_prefix.capacity())
            .saturating_mul(std::mem::size_of::<u32>())
    }

    /// Converts a completed builder into a queryable index.
    #[must_use]
    pub fn finish(self) -> Option<CompositionIndex> {
        self.is_complete().then_some(CompositionIndex {
            block_size: self.block_size,
            gc_prefix: self.gc_prefix,
            cytosine_prefix: self.cytosine_prefix,
            guanine_prefix: self.guanine_prefix,
            valid_prefix: self.valid_prefix,
            cpg_prefix: self.cpg_prefix,
        })
    }
}

/// Cumulative GC and canonical-base counts at fixed sequence block boundaries.
#[derive(Clone, Debug)]
pub struct CompositionIndex {
    block_size: u64,
    gc_prefix: Vec<u32>,
    cytosine_prefix: Vec<u32>,
    guanine_prefix: Vec<u32>,
    valid_prefix: Vec<u32>,
    cpg_prefix: Vec<u32>,
}

impl CompositionIndex {
    /// Returns one exact GC fraction per equal genomic window in `[start, end)`.
    ///
    /// Ambiguous bases are excluded from the denominator. Windows with less than
    /// 25% canonical sequence are returned as `NaN` so the renderer can leave them blank.
    #[must_use]
    pub fn sample(&self, sequence: &PackedSequence, start: u64, end: u64, bins: usize) -> Vec<f64> {
        self.sample_gc(sequence, start, end, bins)
    }

    /// Returns one exact GC fraction per equal genomic window in `[start, end)`.
    #[must_use]
    pub fn sample_gc(
        &self,
        sequence: &PackedSequence,
        start: u64,
        end: u64,
        bins: usize,
    ) -> Vec<f64> {
        if bins == 0 {
            return Vec::new();
        }
        let start = start.min(sequence.len());
        let end = end.min(sequence.len()).max(start);
        let span = end - start;
        let mut output = Vec::with_capacity(bins);
        for bin in 0..bins {
            let bin_start = partition_coordinate(start, span, bin, bins);
            let bin_end = partition_coordinate(start, span, bin + 1, bins);
            if bin_end <= bin_start {
                output.push(f64::NAN);
                continue;
            }
            let (gc, valid) = self.range_counts(sequence, bin_start, bin_end);
            let window_length = bin_end - bin_start;
            if u64::from(valid).saturating_mul(4) < window_length {
                output.push(f64::NAN);
            } else {
                output.push(f64::from(gc) / f64::from(valid.max(1)));
            }
        }
        output
    }

    /// Returns the `CpG` observed/expected ratio for equal windows in `[start, end)`.
    ///
    /// The expected count is `C * G / N`, so the returned ratio is
    /// `CpG * N / (C * G)`. Ambiguous bases are excluded from `N`; windows with
    /// less than 25% canonical sequence or no C/G denominator are missing.
    #[must_use]
    pub fn sample_cpg_observed_expected(
        &self,
        sequence: &PackedSequence,
        start: u64,
        end: u64,
        bins: usize,
    ) -> Vec<f64> {
        if bins == 0 {
            return Vec::new();
        }
        let start = start.min(sequence.len());
        let end = end.min(sequence.len()).max(start);
        let span = end - start;
        let mut output = Vec::with_capacity(bins);
        for bin in 0..bins {
            let bin_start = partition_coordinate(start, span, bin, bins);
            let bin_end = partition_coordinate(start, span, bin + 1, bins);
            if bin_end.saturating_sub(bin_start) < 2 {
                output.push(f64::NAN);
                continue;
            }
            let start_counts = self.prefix_counts(sequence, bin_start);
            let end_counts = self.prefix_counts(sequence, bin_end);
            let cpg_end = self.prefix_counts(sequence, bin_end.saturating_sub(1)).cpg;
            let valid = end_counts.valid - start_counts.valid;
            let c = end_counts.c - start_counts.c;
            let g = end_counts.g - start_counts.g;
            let cpg = cpg_end - start_counts.cpg;
            let window_length = bin_end - bin_start;
            if u64::from(valid).saturating_mul(4) < window_length || c == 0 || g == 0 {
                output.push(f64::NAN);
            } else {
                output.push(f64::from(cpg) * f64::from(valid) / (f64::from(c) * f64::from(g)));
            }
        }
        output
    }

    /// Approximate bytes owned by the index vectors.
    #[must_use]
    pub fn estimated_heap_bytes(&self) -> usize {
        self.gc_prefix
            .capacity()
            .saturating_add(self.cytosine_prefix.capacity())
            .saturating_add(self.guanine_prefix.capacity())
            .saturating_add(self.valid_prefix.capacity())
            .saturating_add(self.cpg_prefix.capacity())
            .saturating_mul(std::mem::size_of::<u32>())
    }

    fn range_counts(&self, sequence: &PackedSequence, start: u64, end: u64) -> (u32, u32) {
        let first_full = start.div_ceil(self.block_size);
        let last_full = end / self.block_size;
        if first_full >= last_full {
            return scan_counts(sequence, start, end);
        }

        let first_index = usize::try_from(first_full).expect("GC block index fits usize");
        let last_index = usize::try_from(last_full).expect("GC block index fits usize");
        let mut gc = self.gc_prefix[last_index] - self.gc_prefix[first_index];
        let mut valid = self.valid_prefix[last_index] - self.valid_prefix[first_index];

        let left_end = first_full.saturating_mul(self.block_size).min(end);
        let right_start = last_full.saturating_mul(self.block_size).max(start);
        let (left_gc, left_valid) = scan_counts(sequence, start, left_end);
        let (right_gc, right_valid) = scan_counts(sequence, right_start, end);
        gc = gc.saturating_add(left_gc).saturating_add(right_gc);
        valid = valid.saturating_add(left_valid).saturating_add(right_valid);
        (gc, valid)
    }

    fn prefix_counts(&self, sequence: &PackedSequence, coordinate: u64) -> CompositionCounts {
        let coordinate = coordinate.min(sequence.len());
        let block = usize::try_from(coordinate / self.block_size)
            .expect("composition block index fits usize")
            .min(self.gc_prefix.len().saturating_sub(1));
        let block_start = u64::try_from(block)
            .expect("composition block index fits u64")
            .saturating_mul(self.block_size);
        let mut counts = CompositionCounts {
            gc: self.gc_prefix[block],
            c: self.cytosine_prefix[block],
            g: self.guanine_prefix[block],
            valid: self.valid_prefix[block],
            cpg: self.cpg_prefix[block],
        };
        for position in block_start..coordinate {
            let (code, valid) = sequence
                .get(position)
                .expect("composition prefix range is clipped to the sequence");
            if !valid {
                continue;
            }
            counts.valid = counts.valid.saturating_add(1);
            match code {
                1 => {
                    counts.c = counts.c.saturating_add(1);
                    counts.gc = counts.gc.saturating_add(1);
                }
                2 => {
                    counts.g = counts.g.saturating_add(1);
                    counts.gc = counts.gc.saturating_add(1);
                }
                _ => {}
            }
            if code == 1
                && sequence
                    .get(position.saturating_add(1))
                    .is_some_and(|(next, next_valid)| next_valid && next == 2)
            {
                counts.cpg = counts.cpg.saturating_add(1);
            }
        }
        counts
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct CompositionCounts {
    gc: u32,
    c: u32,
    g: u32,
    valid: u32,
    cpg: u32,
}

fn partition_coordinate(start: u64, span: u64, bin: usize, bins: usize) -> u64 {
    let offset = u128::from(span).saturating_mul(bin as u128) / bins as u128;
    start.saturating_add(u64::try_from(offset).expect("partition offset fits u64"))
}

fn scan_counts(sequence: &PackedSequence, start: u64, end: u64) -> (u32, u32) {
    let mut gc = 0_u32;
    let mut valid = 0_u32;
    for position in start..end {
        let (code, is_valid) = sequence
            .get(position)
            .expect("GC query range is clipped to the sequence");
        if is_valid {
            valid = valid.saturating_add(1);
            if code == 1 || code == 2 {
                gc = gc.saturating_add(1);
            }
        }
    }
    (gc, valid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(sequence: &PackedSequence, block_size: u64) -> CompositionIndex {
        let mut builder = CompositionIndexBuilder::new(sequence, block_size);
        while !builder.is_complete() {
            builder.advance(sequence, 2);
        }
        builder.finish().expect("completed GC index")
    }

    #[test]
    fn samples_exact_unsmoothed_windows_across_block_boundaries() {
        let sequence = PackedSequence::from_ascii("gc", b"AAAACCCCGGGGTTTT");
        let result = index(&sequence, 3).sample(&sequence, 0, sequence.len(), 4);
        assert!(
            result
                .iter()
                .zip([0.0, 1.0, 1.0, 0.0])
                .all(|(observed, expected)| (observed - expected).abs() < f64::EPSILON)
        );
    }

    #[test]
    fn excludes_ambiguous_bases_and_marks_low_coverage_windows_missing() {
        let sequence = PackedSequence::from_ascii("ambiguous", b"GCNNNNNNATNNNNNN");
        let result = index(&sequence, 4).sample(&sequence, 0, sequence.len(), 2);
        assert!((result[0] - 1.0).abs() < f64::EPSILON);
        assert!(result[1].abs() < f64::EPSILON);
        let missing = index(&sequence, 4).sample(&sequence, 2, 8, 1);
        assert!(missing[0].is_nan());
    }

    #[test]
    fn handles_partial_terminal_windows_and_more_bins_than_bases() {
        let sequence = PackedSequence::from_ascii("short", b"ACGTA");
        let index = index(&sequence, 2);
        let partial = index.sample(&sequence, 0, 5, 2);
        assert!((partial[0] - 0.5).abs() < f64::EPSILON);
        assert!((partial[1] - 1.0 / 3.0).abs() < f64::EPSILON);
        let oversampled = index.sample(&sequence, 0, 2, 4);
        assert!(oversampled[0].is_nan());
        assert!(oversampled[1].abs() < f64::EPSILON);
        assert!(oversampled[2].is_nan());
        assert!((oversampled[3] - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn computes_cpg_observed_expected_across_index_blocks() {
        let sequence = PackedSequence::from_ascii("cpg", b"AACGCGTTCCGG");
        let index = index(&sequence, 3);
        let ratios = index.sample_cpg_observed_expected(&sequence, 2, 12, 2);
        assert!((ratios[0] - 2.5).abs() < f64::EPSILON);
        assert!((ratios[1] - 1.25).abs() < f64::EPSILON);
    }

    #[test]
    fn cpg_index_matches_a_direct_window_count_at_every_boundary() {
        let bases = b"ACGTCGCCGATGCGTACCGG";
        let sequence = PackedSequence::from_ascii("differential", bases);
        for block_size in 1..=7 {
            let index = index(&sequence, block_size);
            for start in 0..bases.len() - 1 {
                for end in start + 2..=bases.len() {
                    let observed =
                        index.sample_cpg_observed_expected(&sequence, start as u64, end as u64, 1)
                            [0];
                    let window = &bases[start..end];
                    let (cytosines, guanines) = window.iter().fold(
                        (0_u32, 0_u32),
                        |(cytosine_count, guanine_count), base| {
                            (
                                cytosine_count + u32::from(*base == b'C'),
                                guanine_count + u32::from(*base == b'G'),
                            )
                        },
                    );
                    let cpgs =
                        u32::try_from(window.windows(2).filter(|pair| *pair == b"CG").count())
                            .expect("test window length fits u32");
                    if cytosines == 0 || guanines == 0 {
                        assert!(observed.is_nan());
                    } else {
                        let window_length =
                            u32::try_from(window.len()).expect("test window length fits u32");
                        let expected = f64::from(cpgs) * f64::from(window_length)
                            / f64::from(cytosines * guanines);
                        assert!((observed - expected).abs() < f64::EPSILON);
                    }
                }
            }
        }
    }
}
