//! Scientific axis-cache identity and retained entries.

use super::{CoreScientificConfig, FrozenAxis, Rc, ScientificConfigIdentity};

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(super) struct AxisCacheKey {
    pub(super) sequence_index: usize,
    pub(super) resolution: usize,
    pub(super) start: usize,
    pub(super) count: usize,
    pub(super) scientific_identity: ScientificConfigIdentity,
}

pub(super) struct AxisCacheEntry {
    pub(super) axis: Rc<FrozenAxis>,
    pub(super) bytes: usize,
    pub(super) last_used: u64,
}

pub(super) fn validate_axis_cache_identity(
    key: AxisCacheKey,
    config: CoreScientificConfig,
) -> Result<(), &'static str> {
    if key.scientific_identity == config.identity() {
        Ok(())
    } else {
        Err("zoom-axis cache key does not match its scientific configuration")
    }
}
