#!/bin/bash
# Validate a frozen source and artifact snapshot before any release upload.
# Set KIER_RELEASES_REPO on the release machine. Bump both bundle versions first.
set -euo pipefail
cd "$(dirname "$0")/.."
# Optional settings on the release machine; never part of the public export.
[ ! -f scripts/local.env ] || . ./scripts/local.env
REPO="${KIER_RELEASES_REPO:?Set KIER_RELEASES_REPO in the environment or scripts/local.env}"
# Updates download from the public repository, which carries every release; the releases repository only serves older copies of Kier.
DOWNLOADS="${KIER_PUBLIC_REPO:-off}"
[[ "$DOWNLOADS" != off ]] || DOWNLOADS="$REPO"
# Check source before parsers or packaging tools can quote a rejected input in an error.
scripts/publish-source.sh --check-source
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' app/Info.plist)"
VALIDATE_ONLY=false
case "${1:-}" in
  --validate-only) VALIDATE_ONLY=true ;;
  --skip-build) ;;
  "") scripts/package-app.sh --release ;;
  *) echo "release-app: unknown option" >&2; exit 2 ;;
esac
[[ -f dist/Kier.dmg ]] || { echo "release-app: missing package" >&2; exit 1; }
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' app/Info.plist)"
MIN_OS="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' app/Info.plist)"
# What's new, from app/changelog.json (the same notes the app and getkier.com/changelog show).
CHANGES="$(node -e "const r = require('./app/changelog.json').find((x) => x.version === process.argv[1]); if (r) console.log([r.title, '', ...r.notes.map(n => '- ' + n)].join('\n'))" "$VERSION")"
NOTES="${KIER_RELEASE_NOTES:-${CHANGES:-Kier $VERSION for Mac (Apple Silicon, macOS $MIN_OS or later).}}"

# Keep the update offer brief; the full notes live in the app and on the release page.
SUMMARY="$(node -e "const r = require('./app/changelog.json').find((x) => x.version === process.argv[1]); if (r) console.log(r.summary || r.title)" "$VERSION")"

# The appcast Kier's updater reads (app/Updater.swift), from releases/latest/download/appcast.xml, so each release
# carries its own: this version, its DMG and the DMG's EdDSA signature. The signing key is in this Mac's login keychain,
# under KIER_SPARKLE_ACCOUNT (Sparkle generate_keys); without it no update can be published.
SIGNATURE="$("$(scripts/sparkle.sh)/bin/sign_update" --account "${KIER_SPARKLE_ACCOUNT:-kier-sparkle}" "dist/Kier-$VERSION.dmg" 2>/dev/null)" || { echo "release-app: no Sparkle signing key for the configured account" >&2; exit 1; }
xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
cat > dist/appcast.xml <<XML
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Kier</title>
    <item>
      <title>Kier $VERSION</title>
      <pubDate>$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')</pubDate>
      <sparkle:version>$BUILD</sparkle:version>
      <sparkle:shortVersionString>$VERSION</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>$MIN_OS</sparkle:minimumSystemVersion>
      <description>&lt;p&gt;$(printf '%s' "$SUMMARY" | xml | xml)&lt;/p&gt;</description>
      <enclosure url="https://github.com/$DOWNLOADS/releases/download/v$VERSION/Kier-$VERSION.dmg" $SIGNATURE type="application/octet-stream"/>
    </item>
  </channel>
</rss>
XML
xmllint --nonet --noout dist/appcast.xml 2>/dev/null || { echo "release-app: invalid appcast" >&2; exit 1; }

printf '%s\n' "$NOTES" > dist/release-notes.md
# This runs even with source publication disabled. No gh call precedes it.
VALIDATION_LOG="$(mktemp)"
trap 'rm -f "$VALIDATION_LOG"' EXIT
scripts/publish-source.sh "$VERSION" --prepare-release > "$VALIDATION_LOG"
cat "$VALIDATION_LOG"
PREPARED="$(sed -n 's/^Validated release: //p' "$VALIDATION_LOG")"
[[ -n "$PREPARED" ]] || { echo "release-app: missing validated snapshot" >&2; exit 1; }
if $VALIDATE_ONLY; then exit 0; fi
python3 scripts/release-validation.py verify "$PREPARED" "$VERSION"
# Read-only existence check also waits for validation.
if gh release view "v$VERSION" -R "$REPO" >/dev/null 2>&1; then
  echo "release-app: version already released" >&2; exit 1
fi
ASSETS=("$PREPARED/artifacts/Kier.dmg" "$PREPARED/artifacts/Kier-$VERSION.dmg" "$PREPARED/artifacts/appcast.xml")
gh release create "v$VERSION" -R "$REPO" --title "Kier $VERSION" --notes-file "$PREPARED/artifacts/release-notes.md" "${ASSETS[@]}"
# Both destinations use the exact same snapshot and the same explicit artifact list.
if [[ "${KIER_PUBLIC_REPO:-}" != off ]]; then
  scripts/publish-source.sh "$VERSION" --validated "$PREPARED"
fi
