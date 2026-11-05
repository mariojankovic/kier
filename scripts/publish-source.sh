#!/bin/bash
# The only two identity exceptions. Delete/change these here when attribution changes.
IDENTITY_ALLOWLIST='{"license":"Copyright 2026 Mario Jankovic","repository":"mariojankovic/kier"}'
# Publish an independently checked snapshot, never the development repository history.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
DRY=false
CHECK_SOURCE=false
PREPARE=false
PREPARED=""
VERSION=""
while (($#)); do
  case "$1" in
    --dry-run) DRY=true ;;
    --check-source) CHECK_SOURCE=true ;;
    --prepare-release) PREPARE=true ;;
    --validated) shift; PREPARED="${1:?missing validated directory}" ;;
    -*) echo "publish-source: unknown option" >&2; exit 2 ;;
    *) [[ -z "$VERSION" ]] || exit 2; VERSION="$1" ;;
  esac
  shift
done
if $CHECK_SOURCE; then
  [[ -z "$PREPARED" ]] || exit 2
  VERSION="${VERSION:-0.0.0}"
fi
if [[ -z "$VERSION" ]] && $DRY; then
  VERSION="$(python3 -c 'import plistlib; print(plistlib.load(open("app/Info.plist","rb"))["CFBundleShortVersionString"])')"
fi
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || { echo "publish-source: supply a version" >&2; exit 2; }
if [[ -n "$PREPARED" ]]; then
  $DRY && { echo "publish-source: incompatible options" >&2; exit 2; }
  python3 scripts/release-validation.py verify "$PREPARED" "$VERSION"
  TREE="$PREPARED/source"
else
  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/kier-public.XXXXXX")"
  chmod 700 "$STAGE"
  trap '[[ -z "${STAGE:-}" ]] || rm -rf "$STAGE"' EXIT
  TREE="$STAGE/source"
  mkdir "$TREE"
  python3 scripts/privacy-gate.py --identities "$IDENTITY_ALLOWLIST" --export "$ROOT" "$TREE"
  if $CHECK_SOURCE; then exit 0; fi
  if $DRY; then
    printf 'Public tree: %s\n' "$TREE"
    trap - EXIT
    exit 0
  fi
  python3 scripts/release-validation.py prepare "$ROOT" "$STAGE" "$VERSION" "$IDENTITY_ALLOWLIST"
  PREPARED="$STAGE"
  trap - EXIT
fi
if $PREPARE; then
  printf 'Validated release: %s\n' "$PREPARED"
  exit 0
fi
python3 scripts/release-validation.py verify "$PREPARED" "$VERSION"
[ ! -f scripts/local.env ] || . ./scripts/local.env
REPO="${KIER_PUBLIC_REPO:-mariojankovic/kier}"
[[ "$REPO" != off ]] || { echo "Source publication disabled."; exit 0; }
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "publish-source: expected owner/repo" >&2; exit 2; }
# Never publish an uncommitted tracked change or reuse a version already released.
git diff --quiet HEAD -- app daemon scripts README.md LICENSE SECURITY.md || { echo "publish-source: commit the source changes first" >&2; exit 1; }
CACHE="$HOME/Library/Caches/kier-public"
if [[ ! -d "$CACHE/.git" ]]; then
  [[ ! -e "$CACHE" ]] || { echo "publish-source: cache exists without a checkout" >&2; exit 1; }
  mkdir -p "$(dirname "$CACHE")"
  gh repo clone "$REPO" "$CACHE"
fi
ORIGIN="$(git -C "$CACHE" remote get-url origin)"
[[ "$ORIGIN" == "https://github.com/$REPO.git" || "$ORIGIN" == "https://github.com/$REPO" || "$ORIGIN" == "git@github.com:$REPO.git" ]] || { echo "publish-source: cache origin does not match public repository" >&2; exit 1; }
[[ -z "$(git -C "$CACHE" status --porcelain)" ]] || { echo "publish-source: public checkout is dirty" >&2; exit 1; }
git -C "$CACHE" fetch origin --tags
if git -C "$CACHE" rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then echo "publish-source: version tag already exists" >&2; exit 1; fi
if git -C "$CACHE" rev-parse -q --verify HEAD >/dev/null; then
  git -C "$CACHE" pull --ff-only
  [[ "$(git -C "$CACHE" rev-parse HEAD)" == "$(git -C "$CACHE" rev-parse '@{u}')" ]] || { echo "publish-source: public checkout has unpublished commits" >&2; exit 1; }
fi
# The destination is a verified dedicated checkout. Its history is independent of the private repository.
rsync -a --delete --exclude=.git/ "$TREE/" "$CACHE/"
git -C "$CACHE" add --all
# Public snapshots must not inherit the release Mac's private email or signing identity.
GIT_AUTHOR_NAME="Kier release" GIT_AUTHOR_EMAIL="source@example.invalid" \
GIT_COMMITTER_NAME="Kier release" GIT_COMMITTER_EMAIL="source@example.invalid" \
  git -C "$CACHE" -c commit.gpgsign=false commit --allow-empty -m "Kier $VERSION"
git -C "$CACHE" -c tag.gpgsign=false tag "v$VERSION"
git -C "$CACHE" push --atomic origin HEAD "refs/tags/v$VERSION"
python3 scripts/release-validation.py verify "$PREPARED"
ASSETS=("$PREPARED/artifacts/Kier.dmg" "$PREPARED/artifacts/Kier-$VERSION.dmg" "$PREPARED/artifacts/appcast.xml")
gh release create "v$VERSION" -R "$REPO" --verify-tag --title "Kier $VERSION" --notes-file "$PREPARED/artifacts/release-notes.md" "${ASSETS[@]}"
printf 'Published Kier %s\n' "$VERSION"
