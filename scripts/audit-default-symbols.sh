#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repository_root"

cargo build --release -p moddotplot-core

rejected='BbitCollisionCorrected|project_registers|compute_(frozen_)?tile_adaptive|exact_sparse_tile_direction'
if nm -g target/release/libmoddotplot_core.rlib 2>/dev/null | rg "$rejected"; then
  echo "default core artifact contains a validation-only global symbol" >&2
  exit 1
fi

echo "default core global-symbol audit passed"
