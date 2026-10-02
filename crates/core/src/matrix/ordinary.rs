//! Validation and allocation geometry for ordinary production tiles.

use super::{AxisData, TileBuildError, TileRequest};

pub(super) struct ValidatedTile {
    pub(super) width: usize,
    pub(super) height: usize,
    pub(super) cells: usize,
}

pub(super) fn validate(
    x: &impl AxisData,
    y: &impl AxisData,
    request: TileRequest,
) -> Result<ValidatedTile, TileBuildError> {
    if x.scientific_config().identity() != y.scientific_config().identity()
        || x.domain_length() != y.domain_length()
        || x.resolution() != y.resolution()
        || x.resolution() == 0
        || x.resolution() > usize::MAX / 2
        || x.core_encoded().len() != x.expanded_encoded().len()
        || y.core_encoded().len() != y.expanded_encoded().len()
        || (!x.sparse_core().is_empty() && x.sparse_core().len() != x.core_encoded().len())
        || (!y.sparse_core().is_empty() && y.sparse_core().len() != y.core_encoded().len())
    {
        return Err(TileBuildError::IncompatibleAxes);
    }
    if request.width == 0 || request.height == 0 {
        return Err(TileBuildError::Dimensions);
    }
    let x_end = x
        .offset()
        .checked_add(x.core_encoded().len())
        .ok_or(TileBuildError::Range)?;
    let y_end = y
        .offset()
        .checked_add(y.core_encoded().len())
        .ok_or(TileBuildError::Range)?;
    if !(x.offset()..x_end).contains(&request.x_start)
        || !(y.offset()..y_end).contains(&request.y_start)
    {
        return Err(TileBuildError::Range);
    }
    let config = x.scientific_config();
    let mut expected = None;
    for signature in x
        .core_encoded()
        .iter()
        .chain(x.expanded_encoded())
        .chain(y.core_encoded())
        .chain(y.expanded_encoded())
    {
        let dimensions = (signature.register_count(), signature.fingerprint_bits());
        if dimensions != (config.register_count(), config.verification_bits()) {
            return Err(TileBuildError::Parameters);
        }
        if expected.is_some_and(|expected| expected != dimensions) {
            return Err(TileBuildError::IncompatibleAxes);
        }
        expected = Some(dimensions);
    }
    expected.ok_or(TileBuildError::IncompatibleAxes)?;

    let width = request.width.min(x_end.saturating_sub(request.x_start));
    let height = request.height.min(y_end.saturating_sub(request.y_start));
    let cells = width
        .checked_mul(height)
        .ok_or(TileBuildError::Dimensions)?;
    Ok(ValidatedTile {
        width,
        height,
        cells,
    })
}
