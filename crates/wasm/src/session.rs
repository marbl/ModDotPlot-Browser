//! Immutable session selection context.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ComparisonContext {
    pub(super) x_index: usize,
    pub(super) y_index: usize,
    pub(super) domain_length: u64,
    pub(super) k: u8,
}
