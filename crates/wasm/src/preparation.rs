//! Comparison preparation state and progressive tile composition.

use super::{
    CoreScientificConfig, FrozenAxis, HashSet, MatrixTile, TileRequest, compute_frozen_tile,
};

pub(super) struct PreparedComparison {
    pub(super) x: FrozenAxis,
    pub(super) y: Option<FrozenAxis>,
    pub(super) x_index: usize,
    pub(super) y_index: usize,
    pub(super) config: CoreScientificConfig,
}

pub(super) struct ComparisonPreparation {
    pub(super) x_index: usize,
    pub(super) y_index: usize,
    pub(super) domain_length: u64,
    pub(super) resolution: usize,
    pub(super) config: CoreScientificConfig,
    pub(super) axis: u8,
    pub(super) x_next_bin: usize,
    pub(super) y_next_bin: usize,
    pub(super) progressive_tiles: bool,
    pub(super) progressive_tile_origins: Option<HashSet<(usize, usize)>>,
    pub(super) x_parts: Vec<FrozenAxis>,
    pub(super) y_parts: Vec<FrozenAxis>,
}

pub(super) struct PendingPreparationTile {
    pub(super) x: usize,
    pub(super) y: usize,
    pub(super) inner: MatrixTile,
}

pub(super) fn join_axis_parts(parts: Vec<FrozenAxis>) -> FrozenAxis {
    FrozenAxis::join_contiguous(parts)
        .expect("prepared axis parts must be compatible and contiguous")
}

pub(super) fn progressive_tiles_for_part(
    state: &ComparisonPreparation,
    building_axis: u8,
) -> Vec<PendingPreparationTile> {
    if state.x_index == state.y_index {
        let Some(current) = state.x_parts.last() else {
            return Vec::new();
        };
        return state
            .x_parts
            .iter()
            .filter_map(|previous| selected_pending_tile(state, current, previous))
            .collect();
    }
    if building_axis == 0 {
        let Some(current) = state.x_parts.last() else {
            return Vec::new();
        };
        state
            .y_parts
            .iter()
            .filter_map(|y_part| selected_pending_tile(state, current, y_part))
            .collect()
    } else {
        let Some(current) = state.y_parts.last() else {
            return Vec::new();
        };
        state
            .x_parts
            .iter()
            .filter_map(|x_part| selected_pending_tile(state, x_part, current))
            .collect()
    }
}

fn selected_pending_tile(
    state: &ComparisonPreparation,
    x: &FrozenAxis,
    y: &FrozenAxis,
) -> Option<PendingPreparationTile> {
    if state
        .progressive_tile_origins
        .as_ref()
        .is_some_and(|origins| !origins.contains(&(x.offset(), y.offset())))
    {
        return None;
    }
    Some(PendingPreparationTile {
        x: x.offset(),
        y: y.offset(),
        inner: compute_frozen_tile(
            x,
            y,
            TileRequest {
                x_start: x.offset(),
                y_start: y.offset(),
                width: x.core_encoded().len(),
                height: y.core_encoded().len(),
            },
        )
        .ok()?,
    })
}
