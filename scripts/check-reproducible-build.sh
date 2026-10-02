#!/bin/sh
set -eu

repository_root=$(git rev-parse --show-toplevel)
if [ -n "$(git -C "$repository_root" status --porcelain)" ]; then
  echo "reproducibility checking requires a clean Git worktree" >&2
  exit 1
fi

scratch_parent=${TMPDIR:-/tmp}
scratch_root=$(mktemp -d "${scratch_parent%/}/moddotplot-interactive-reproducibility.XXXXXX")
trap 'rm -rf "$scratch_root"' EXIT INT TERM

for clone_name in first second; do
  clone_root="$scratch_root/$clone_name"
  git clone --quiet --no-hardlinks "$repository_root" "$clone_root"
  (
    cd "$clone_root/web"
    npm ci --ignore-scripts --no-audit --no-fund
    npm run build
  )
  (
    cd "$clone_root/web/dist"
    find . -type f -print | LC_ALL=C sort | xargs shasum -a 256
  ) > "$scratch_root/$clone_name.sha256"
done

diff -u "$scratch_root/first.sha256" "$scratch_root/second.sha256"
echo "two clean builds produced byte-identical static assets"
