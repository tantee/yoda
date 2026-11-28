#!/bin/sh
# Merges the two single-arch builds of one image into its multi-arch index and pushes that index BY DIGEST ONLY,
# untagged, to the same repository (release.yml, jobs manifest and manifest-dry). Prints the index digest, the one
# the bundle pins. The tags come later, after the bundle is signed (job tag).
#
# Usage: merge-image.sh <repository> <linux/amd64 digest> <linux/arm64 digest>
#   e.g. merge-image.sh ghcr.io/tantee/yoda/core sha256:… sha256:…
#
# docker buildx imagetools create --dry-run prints the index it would push; its sha256 is the index digest, and
# --tag <repository>@<that digest> pushes it to that digest and no tag. The index is then read back from the registry
# and must be that digest, with exactly linux/amd64 and linux/arm64.
set -eu

[ $# -eq 3 ] || { echo "usage: $0 <repository> <amd64 digest> <arm64 digest>" >&2; exit 2; }
repo=$1
amd64=$2
arm64=$3
for d in "$amd64" "$arm64"; do
  printf '%s\n' "$d" | grep -Eqx 'sha256:[0-9a-f]{64}' || { echo "::error::Not an image digest: $d" >&2; exit 1; }
done
[ "$amd64" != "$arm64" ] || { echo "::error::$repo: the amd64 and arm64 digests are the same ($amd64)" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# The exact bytes imagetools pushes (it prints them followed by one newline).
docker buildx imagetools create --dry-run "$repo@$amd64" "$repo@$arm64" > "$tmp/index.out"
head -c -1 "$tmp/index.out" > "$tmp/index.json"
digest="sha256:$(sha256sum "$tmp/index.json" | cut -d' ' -f1)"

docker buildx imagetools create --tag "$repo@$digest" "$repo@$amd64" "$repo@$arm64" >&2

# Read it back: the registry must serve that digest, and it must list both platforms (plus attestations, if any).
docker buildx imagetools inspect --raw "$repo@$digest" > "$tmp/served.json"
served="sha256:$(sha256sum "$tmp/served.json" | cut -d' ' -f1)"
[ "$served" = "$digest" ] || { echo "::error::$repo: the registry serves $served for the index $digest" >&2; exit 1; }
platforms=$(jq -r '[.manifests[] | select(.platform.os == "linux" and .platform.architecture != "unknown")
  | .platform.os + "/" + .platform.architecture] | sort | join(",")' "$tmp/served.json")
[ "$platforms" = "linux/amd64,linux/arm64" ] ||
  { echo "::error::$repo@$digest lists the platforms '$platforms', not linux/amd64,linux/arm64" >&2; exit 1; }

echo "$repo: $amd64 (linux/amd64) + $arm64 (linux/arm64) = $digest" >&2
printf '%s\n' "$digest"
