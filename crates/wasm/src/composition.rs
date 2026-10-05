//! Owned GC and `CpG` preparation state.

use super::{
    CompositionIndex, CompositionIndexBuilder, DEFAULT_COMPOSITION_BLOCK_SIZE, HashMap, JsError,
    PackedSequence,
};

#[derive(Default)]
pub(super) struct CompositionState {
    indices: HashMap<usize, CompositionIndex>,
    builders: HashMap<usize, CompositionIndexBuilder>,
}

impl CompositionState {
    pub(super) fn estimated_heap_bytes(&self) -> usize {
        self.indices
            .capacity()
            .saturating_mul(std::mem::size_of::<(usize, CompositionIndex)>())
            .saturating_add(
                self.indices
                    .values()
                    .map(CompositionIndex::estimated_heap_bytes)
                    .sum::<usize>(),
            )
            .saturating_add(
                self.builders
                    .capacity()
                    .saturating_mul(std::mem::size_of::<(usize, CompositionIndexBuilder)>()),
            )
            .saturating_add(
                self.builders
                    .values()
                    .map(CompositionIndexBuilder::estimated_heap_bytes)
                    .sum::<usize>(),
            )
    }

    pub(super) fn begin(
        &mut self,
        sequences: &[PackedSequence],
        sequence_index: usize,
    ) -> Result<bool, JsError> {
        if self.indices.contains_key(&sequence_index) {
            return Ok(true);
        }
        let sequence = sequences
            .get(sequence_index)
            .ok_or_else(|| JsError::new("GC sequence index is out of range"))?;
        self.builders.entry(sequence_index).or_insert_with(|| {
            CompositionIndexBuilder::new(sequence, DEFAULT_COMPOSITION_BLOCK_SIZE)
        });
        Ok(false)
    }

    pub(super) fn advance(
        &mut self,
        sequences: &[PackedSequence],
        sequence_index: usize,
        maximum_blocks: usize,
    ) -> Result<f64, JsError> {
        if maximum_blocks == 0 {
            return Err(JsError::new("GC preparation chunk size must be positive"));
        }
        let sequence = sequences
            .get(sequence_index)
            .ok_or_else(|| JsError::new("GC sequence index is out of range"))?;
        let builder = self
            .builders
            .get_mut(&sequence_index)
            .ok_or_else(|| JsError::new("begin_composition_index must be called first"))?;
        let progress = builder.advance(sequence, maximum_blocks);
        if builder.is_complete() {
            let builder = self
                .builders
                .remove(&sequence_index)
                .ok_or_else(|| JsError::new("completed GC builder was not retained"))?;
            let complete = builder
                .finish()
                .ok_or_else(|| JsError::new("GC index completion was inconsistent"))?;
            self.indices.insert(sequence_index, complete);
        }
        Ok(progress)
    }

    pub(super) fn gc_bins(
        &self,
        sequences: &[PackedSequence],
        sequence_index: usize,
        start: u64,
        end: u64,
        bins: usize,
    ) -> Result<Vec<f64>, JsError> {
        let (sequence, index) = self.query(sequences, sequence_index, start, end, bins, "GC")?;
        Ok(index.sample_gc(sequence, start, end, bins))
    }

    pub(super) fn cpg_bins(
        &self,
        sequences: &[PackedSequence],
        sequence_index: usize,
        start: u64,
        end: u64,
        bins: usize,
    ) -> Result<Vec<f64>, JsError> {
        let (sequence, index) = self.query(sequences, sequence_index, start, end, bins, "CpG")?;
        Ok(index.sample_cpg_observed_expected(sequence, start, end, bins))
    }

    fn query<'a>(
        &'a self,
        sequences: &'a [PackedSequence],
        sequence_index: usize,
        start: u64,
        end: u64,
        bins: usize,
        label: &str,
    ) -> Result<(&'a PackedSequence, &'a CompositionIndex), JsError> {
        if bins == 0 {
            return Err(JsError::new(&format!("{label} bin count must be positive")));
        }
        let sequence = sequences
            .get(sequence_index)
            .ok_or_else(|| JsError::new(&format!("{label} sequence index is out of range")))?;
        if start > end || end > sequence.len() {
            return Err(JsError::new(&format!(
                "{label} sequence range is out of bounds"
            )));
        }
        let index = self
            .indices
            .get(&sequence_index)
            .ok_or_else(|| JsError::new("composition index is not ready"))?;
        Ok((sequence, index))
    }

    pub(super) fn clear(&mut self) {
        self.indices.clear();
        self.builders.clear();
    }
}
