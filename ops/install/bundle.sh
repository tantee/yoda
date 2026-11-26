#!/bin/sh
# Builds the release bundle for the internal file server (installer proposal §3.4, D1), from the repository root:
#
#   sh ops/install/bundle.sh <version> <image prefix> <out dir>
#
# writes <out dir>/releases/<version>/:
#   yoda-<version>.tar.gz  the compose files, ops/deploy/deploy.sh, ops/install/install.sh, .env.example,
#                          CHANGELOG.md, docs/operations.md and bundle.env (YODA_IMAGE_PREFIX, YODA_VERSION)
#   install.sh             the installer, also on its own (download it, check it, then run it)
#   SHA256SUMS             both of the above
# Signing is a separate step (the release job): minisign -S -s <key> -m SHA256SUMS -t "yoda release <version>"
# writes SHA256SUMS.minisig, which install.sh verifies. No secret is read here.
# Reproducible with GNU tar (CI): sorted names, owner 0:0, fixed modes, every mtime = SOURCE_DATE_EPOCH (default:
# the last commit's time), gzip -n. Other tars (macOS) give the same contents, not the same bytes.
set -eu

[ $# -eq 3 ] || { echo 'usage: bundle.sh <version> <image prefix> <out dir>' >&2; exit 2; }
version=$1
prefix=$2
out=$3
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' ||
  { echo "bundle: not a release version: $version" >&2; exit 2; }
case "$prefix" in
  '' | -* | *[!A-Za-z0-9._:/-]*) echo 'bundle: invalid image prefix' >&2; exit 2 ;;
esac

files='docker-compose.yml docker-compose.prod.yml ops/deploy/deploy.sh ops/install/install.sh .env.example CHANGELOG.md docs/operations.md'
for f in $files; do
  [ -f "$f" ] || { echo "bundle: $f is missing (run from the repository root)" >&2; exit 1; }
done

dest="$out/releases/$version"
mkdir -p "$dest"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
for f in $files; do
  mkdir -p "$stage/$(dirname "$f")"
  cp "$f" "$stage/$f"
done
printf 'YODA_IMAGE_PREFIX=%s\nYODA_VERSION=%s\n' "$prefix" "$version" > "$stage/bundle.env"
find "$stage" -type d -exec chmod 0755 {} +
find "$stage" -type f -exec chmod 0644 {} +
chmod 0755 "$stage/ops/deploy/deploy.sh" "$stage/ops/install/install.sh"

epoch=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || date +%s)}
case "$epoch" in
  '' | *[!0-9]*) echo 'bundle: SOURCE_DATE_EPOCH must be a Unix time' >&2; exit 2 ;;
esac
# Plain files only (no macOS metadata). No pipe: a failed tar must fail the build.
# shellcheck disable=SC2086 # $files is a fixed list of plain paths
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  (cd "$stage" && tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$epoch" --format=gnu \
    -cf bundle.tar bundle.env $files)
else
  (cd "$stage" && COPYFILE_DISABLE=1 tar -cf bundle.tar bundle.env $files)
fi
gzip -n -9 "$stage/bundle.tar"
mv "$stage/bundle.tar.gz" "$dest/yoda-$version.tar.gz"
cp ops/install/install.sh "$dest/install.sh"

cd "$dest"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "yoda-$version.tar.gz" install.sh > SHA256SUMS
else
  shasum -a 256 "yoda-$version.tar.gz" install.sh > SHA256SUMS
fi
echo "bundle: $dest"
cat SHA256SUMS
