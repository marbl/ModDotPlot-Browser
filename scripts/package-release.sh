#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: scripts/package-release.sh VERSION" >&2
  exit 2
fi

release_version=$1
case "$release_version" in
  *[!0-9A-Za-z.-]*|'') echo "invalid release version" >&2; exit 2 ;;
esac

repository_root=$(git rev-parse --show-toplevel)
cd "$repository_root"
if [ -n "$(git status --porcelain)" ]; then
  echo "release packaging requires a clean Git worktree" >&2
  exit 1
fi

cargo_version=$(sed -n 's/^version = "\([^"]*\)"/\1/p' Cargo.toml | head -1)
npm_version=$(node -p "require('./web/package.json').version")
citation_version=$(sed -n 's/^version: //p' CITATION.cff | head -1)
for manifest_version in "$cargo_version" "$npm_version" "$citation_version"; do
  if [ "$manifest_version" != "$release_version" ]; then
    echo "release version $release_version does not match manifest version $manifest_version" >&2
    exit 1
  fi
done
release_notes="docs/releases/v$release_version.md"
if [ ! -f "$release_notes" ]; then
  echo "missing release notes: $release_notes" >&2
  exit 1
fi

npm --prefix web run build
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "release build changed tracked generated files; regenerate and commit them first" >&2
  exit 1
fi

artifact_directory="$repository_root/release-artifacts"
mkdir -p "$artifact_directory"
source_archive="$artifact_directory/moddotplot-interactive-$release_version-source.tar.gz"
binary_archive="$artifact_directory/moddotplot-interactive-$release_version-web.tar.gz"
provenance_file="$artifact_directory/moddotplot-interactive-$release_version-provenance.txt"
checksum_file="$artifact_directory/moddotplot-interactive-$release_version-SHA256SUMS"

git archive --format=tar --prefix="moddotplot-interactive-$release_version-source/" HEAD | gzip -n > "$source_archive"

staging_directory=$(mktemp -d "${TMPDIR:-/tmp}/moddotplot-interactive-release.XXXXXX")
trap 'rm -rf "$staging_directory"' EXIT INT TERM
binary_root="$staging_directory/moddotplot-interactive-$release_version-web"
mkdir -p "$binary_root/docs"
cp -R web/dist/. "$binary_root/"
cp LICENSE CITATION.cff SBOM.cdx.json THIRD_PARTY_NOTICES.md THIRD_PARTY_LICENSES.txt "$binary_root/"
cp docs/USER_GUIDE.md docs/PRIVACY.md docs/SCIENTIFIC_SPEC.md docs/CURRENT_PARAMETERS.md docs/CITATIONS.md docs/PROVENANCE.md docs/EXPORT_FORMATS.md "$binary_root/docs/"
cp "$release_notes" "$binary_root/docs/"
find "$binary_root" -exec touch -t 198001010000 {} +
(
  cd "$staging_directory"
  find "moddotplot-interactive-$release_version-web" -print | LC_ALL=C sort | tar --no-recursion -cf - -T -
) | gzip -n > "$binary_archive"

{
  echo "moddotplot-interactive $release_version"
  echo "commit=$(git rev-parse HEAD)"
  echo "source-date-epoch=$(git show -s --format=%ct HEAD)"
  echo "host=$(uname -srm)"
  echo "rustc=$(rustc --version)"
  echo "cargo=$(cargo --version)"
  echo "wasm-pack=$(wasm-pack --version)"
  echo "wasm-bindgen=0.2.127 (Cargo.lock)"
  echo "wasm-opt=117 (wasm-pack-managed)"
  echo "node=$(node --version)"
  echo "npm=$(npm --version)"
  echo "scientific-config-version=1"
} > "$provenance_file"

(
  cd "$artifact_directory"
  shasum -a 256 "$(basename "$source_archive")" "$(basename "$binary_archive")" "$(basename "$provenance_file")" > "$checksum_file"
)

echo "release artifacts written to $artifact_directory"
