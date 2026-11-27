#!/bin/sh
# Prints one release's notes from CHANGELOG.md (the body under its "## <version>" heading, up to the next "## "),
# for the GitHub Release (.github/workflows/release.yml):
#
#   sh ops/install/release-notes.sh <version> [CHANGELOG.md]
#
# Exits 1 when the changelog has no such heading or the section is empty: a release is never published without
# its notes.
set -eu

[ $# -ge 1 ] && [ $# -le 2 ] || { echo 'usage: release-notes.sh <version> [changelog]' >&2; exit 2; }
version=$1
changelog=${2:-CHANGELOG.md}
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' ||
  { echo "release-notes: not a release version: $version" >&2; exit 2; }
[ -f "$changelog" ] || { echo "release-notes: $changelog is missing" >&2; exit 1; }

# The heading is "## <version>" alone or followed by a space (e.g. "## 1.0.0 — 2026-11-25").
notes=$(awk -v v="$version" '
  /^## / { if (found) exit; if ($2 == v) { found = 1; next } }
  found { print }
' "$changelog")
# Drop leading and trailing blank lines.
notes=$(printf '%s\n' "$notes" | awk 'NF { started = 1 } started { print }' | awk '
  { lines[NR] = $0 } NF { last = NR } END { for (i = 1; i <= last; i++) print lines[i] }')
if [ -z "$notes" ]; then
  echo "release-notes: $changelog has no notes for $version (add a \"## $version — <date>\" section first)" >&2
  exit 1
fi
printf '%s\n' "$notes"
