//! Wasm retained-memory estimates and pre-allocation admission.

use super::{ComputeSession, CoreScientificConfig, MatrixTile, PackedSequence};

pub(super) const MAX_CACHED_AXIS_BYTES: usize = 192 * 1024 * 1024;
pub(super) const MAX_PREPARED_AXIS_BYTES: usize = 384 * 1024 * 1024;
pub(super) const MAX_WASM_SESSION_BYTES: usize = 3 * 1024 * 1024 * 1024;
pub(super) const MAX_PENDING_PREPARATION_TILE_BYTES: usize = 16 * 1024 * 1024;
pub(super) const MAX_TILE_EDGE: usize = 256;

pub(super) fn estimated_frozen_axis_bytes(
    resolution: usize,
    config: CoreScientificConfig,
) -> usize {
    let words = config.register_count().div_ceil(64);
    let signature_words = usize::from(config.verification_bits()).saturating_add(3);
    let one_signature = signature_words
        .saturating_mul(words)
        .saturating_mul(std::mem::size_of::<u64>())
        .saturating_add(std::mem::size_of::<moddotplot_core::BitSlicedSignature>());
    resolution
        .saturating_mul(
            one_signature
                .saturating_mul(2)
                .saturating_add(std::mem::size_of::<(u64, u64)>()),
        )
        .saturating_add(std::mem::size_of::<super::FrozenAxis>())
        .saturating_add(1_024)
}

pub(super) fn estimated_sequence_bytes(sequence_heap_bytes: usize, capacity: usize) -> usize {
    std::mem::size_of::<ComputeSession>()
        .saturating_add(capacity.saturating_mul(std::mem::size_of::<PackedSequence>()))
        .saturating_add(sequence_heap_bytes)
}

pub(super) fn validate_prepared_axis_admission(
    resolution: usize,
    config: CoreScientificConfig,
    axis_count: usize,
    current_session_bytes: usize,
) -> Result<usize, &'static str> {
    let admitted = estimated_frozen_axis_bytes(resolution, config)
        .checked_mul(axis_count)
        .ok_or("prepared-axis estimate overflowed")?;
    if admitted > MAX_PREPARED_AXIS_BYTES {
        return Err(
            "This quality tier exceeds the 384 MiB prepared-axis budget; lower plot resolution or sketch accuracy.",
        );
    }
    if current_session_bytes.saturating_add(admitted) > MAX_WASM_SESSION_BYTES {
        return Err(
            "This comparison exceeds the Wasm session memory budget; lower plot resolution or sketch accuracy.",
        );
    }
    Ok(admitted)
}

pub(super) fn matrix_tile_heap_bytes(tile: &MatrixTile) -> usize {
    tile.identity
        .capacity()
        .saturating_mul(std::mem::size_of::<u16>())
        .saturating_add(
            tile.direction
                .capacity()
                .saturating_mul(std::mem::size_of::<i16>()),
        )
        .saturating_add(
            tile.direction_support
                .capacity()
                .saturating_mul(std::mem::size_of::<u16>()),
        )
}
