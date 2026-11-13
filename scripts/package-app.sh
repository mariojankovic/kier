#!/bin/bash
# Makes the Kier people download: dist/Kier.dmg, holding a Kier.app that carries its own Node and daemon, so it needs
# no separate Node installation; setup offers the managed model runtime. scripts/build-app.sh is the development build instead: it runs
# the daemon from this checkout with Homebrew's Node.
#
#   scripts/package-app.sh             signed with your Developer ID, not notarized (to try it on this Mac)
#   scripts/package-app.sh --release   Developer ID, notarized and stapled: what getkier.com hands out
#
# The release path refuses to guess: no Developer ID certificate or no notary credentials and it stops.
#   KIER_SIGN_IDENTITY    defaults to the first "Developer ID Application" in the keychain
#   KIER_NOTARY_PROFILE   notarytool keychain profile, or a profile in KIER_NOTARY_PROFILES
#                         (default: kier). Create your own with notarytool store-credentials.
#   KIER_NODE_VERSION     Node release to bundle (default: the latest 24.x LTS from nodejs.org)
set -euo pipefail
cd "$(dirname "$0")/.."
# Optional settings on the release machine; never part of the public export.
[ ! -f scripts/local.env ] || . ./scripts/local.env
ROOT="$(pwd)"
RELEASE=false
[[ "${1:-}" == "--release" ]] && RELEASE=true

die() { echo "package-app: $*" >&2; exit 1; }
step() { echo "==> $*"; }

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' app/Info.plist)"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' app/Info.plist)"
MIN_OS="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' app/Info.plist)"
OUT="$ROOT/dist"
APP="$OUT/Kier.app"
RES="$APP/Contents/Resources"
CACHE="$HOME/Library/Caches/kier-build"

IDENTITY="${KIER_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | grep -m1 -oE '"Developer ID Application[^"]*"' | tr -d '"' || true)}"
[[ -n "$IDENTITY" ]] || die "no 'Developer ID Application' certificate in the keychain (developer.apple.com > Certificates)."
if $RELEASE; then
  PROFILE="${KIER_NOTARY_PROFILE:-kier}"
fi
echo "Kier $VERSION ($BUILD), macOS $MIN_OS+, signed by: $IDENTITY"

# --- Node ----------------------------------------------------------------------------------------------------------
# The official nodejs.org build: one self-contained binary (Homebrew's links against other Homebrew libraries).
step "Fetching Node"
mkdir -p "$CACHE"
LINE="$(curl -fsSL "https://nodejs.org/dist/${KIER_NODE_VERSION:-latest-v24.x}/SHASUMS256.txt" | grep -E 'node-v[0-9.]+-darwin-arm64\.tar\.xz$')"
SUM="${LINE%% *}"; FILE="${LINE##* }"; NODE_VERSION="$(echo "$FILE" | grep -oE 'v[0-9.]+[0-9]')"
TARBALL="$CACHE/$FILE"
[[ -f "$TARBALL" ]] || curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$FILE" -o "$TARBALL"
echo "$SUM  $TARBALL" | shasum -a 256 -c - >/dev/null || { rm -f "$TARBALL"; die "Node download failed its checksum"; }
NODE_DIR="$CACHE/${FILE%.tar.xz}"
[[ -x "$NODE_DIR/bin/node" ]] || tar -xJf "$TARBALL" -C "$CACHE"
echo "Node $NODE_VERSION"
# The daemon's tests on exactly the Node that ships.
# On failure, only the names of failing tests are shown, never their output.
failed() { grep -E '^✖' "$1" | sort -u | head -20 >&2; }
TESTLOG="$(mktemp)"
(cd daemon && "$NODE_DIR/bin/node" --disable-warning=ExperimentalWarning --test 'tests/*.test.mjs' >"$TESTLOG" 2>&1) || { failed "$TESTLOG"; die "daemon tests fail on Node $NODE_VERSION"; }

# --- App -----------------------------------------------------------------------------------------------------------
step "Building Kier.app"
SPARKLE="$(scripts/sparkle.sh)"
rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Frameworks" "$RES/runtime"
swiftc -O -target "arm64-apple-macos$MIN_OS" -F "$SPARKLE" -framework Sparkle -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
  app/*.swift -o "$APP/Contents/MacOS/Kier"
# Sparkle, for updates (app/Updater.swift); Kier isn't sandboxed, so without its XPC services.
FW="$APP/Contents/Frameworks/Sparkle.framework"
ditto "$SPARKLE/Sparkle.framework" "$FW"
rm -rf "$FW/XPCServices" "$FW/Versions/B/XPCServices"
SHADERS="$(mktemp -d)"
xcrun -sdk macosx "${METAL:-metal}" -c app/orb.metal -o "$SHADERS/orb.air"
xcrun -sdk macosx "${METALLIB:-metallib}" "$SHADERS/orb.air" -o "$RES/default.metallib"
# High-resolution orb artwork, loaded once with mipmaps.
cp app/icon/orb-hd.png "$RES/orb.png"
# Brand marks for where things came from (Design.swift, Brand).
cp -R app/brands "$RES/brands"
# What changed in each version, for the app's What's new page.
cp app/changelog.json "$RES/changelog.json"
# The name Finder and the Dock show (Kier AI), while the file stays Kier.app. macOS uses it only while Info.plist's
# CFBundleDisplayName matches the file name (Kier), which is how it tells a rename by the owner.
mkdir -p "$RES/en.lproj" && cp app/en.lproj/InfoPlist.strings "$RES/en.lproj/InfoPlist.strings"
ICONSET="$(mktemp -d)/Kier.iconset"
mkdir -p "$ICONSET"
for s in "16" "32" "128" "256" "512"; do
  sips -z $s $s app/icon/kier-icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) app/icon/kier-icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RES/Kier.icns"
# Empty KierRoot and KierNode: the launcher finds the daemon and Node inside the app.
sed -e "s#__ROOT__##" -e "s#__NODE__##" app/Info.plist > "$APP/Contents/Info.plist"
# The installed-app client ID is public configuration, never a client secret.
KIER_GOOGLE_CLIENT_ID="${KIER_GOOGLE_CLIENT_ID:-}" python3 - "$APP/Contents/Info.plist" <<'PYTHON'
import os, plistlib, sys
path = sys.argv[1]
with open(path, 'rb') as f: info = plistlib.load(f)
info['KierGoogleClientID'] = os.environ['KIER_GOOGLE_CLIENT_ID']
with open(path, 'wb') as f: plistlib.dump(info, f)
PYTHON
/usr/libexec/PlistBuddy -c "Set :SUFeedURL ${KIER_UPDATE_FEED:-https://github.com/${KIER_PUBLIC_REPO:-mariojankovic/kier}/releases/latest/download/appcast.xml}" "$APP/Contents/Info.plist"

# The daemon with only what it runs on: no tests, no development packages.
mkdir -p "$RES/daemon"
cp -R daemon/bin daemon/lib daemon/collectors daemon/ui daemon/sidecar daemon/package.json daemon/package-lock.json "$RES/daemon/"
(cd "$RES/daemon" && "$NODE_DIR/bin/node" "$NODE_DIR/lib/node_modules/npm/bin/npm-cli.js" ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
# Strip comments from the packaged runtime to reduce its size; the public source retains them.
# Run tests on the packaged copy as well.
command -v bun >/dev/null || die "bun is needed to take the comments out of the daemon (brew install oven-sh/bun/bun)"
bun scripts/strip-comments.mjs "$RES/daemon"
# Some tests read the app and release scripts beside the daemon, as in the repository.
CHECK="$(mktemp -d)"
mkdir "$CHECK/daemon" && cp -R "$RES/daemon/." "$CHECK/daemon/" && cp -R daemon/tests "$CHECK/daemon/tests" && cp -R app scripts "$CHECK/"
(cd "$CHECK/daemon" && "$NODE_DIR/bin/node" --disable-warning=ExperimentalWarning --test 'tests/*.test.mjs' >"$TESTLOG" 2>&1) || { failed "$TESTLOG"; die "daemon tests fail on the copy without comments"; }
rm -f "$TESTLOG"
rm -rf "$CHECK"
find "$RES/daemon" \( -name '__pycache__' -o -name '.DS_Store' \) -prune -exec rm -rf {} +
cp "$NODE_DIR/bin/node" "$RES/runtime/node"
cp "$NODE_DIR/LICENSE" "$RES/runtime/LICENSE"

# --- Signing -------------------------------------------------------------------------------------------------------
# Inside out: Node and Sparkle's helpers first, Node with what V8 needs under the hardened runtime (JIT only: unsigned
# executable memory is not needed), then the app around it.
step "Signing"
ENT="$(mktemp -d)/node.entitlements"
cat > "$ENT" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
</dict>
</plist>
PLIST
codesign --force --timestamp --options runtime --entitlements "$ENT" --identifier com.getkier.node --sign "$IDENTITY" "$RES/runtime/node"
for part in "$FW/Versions/B/Autoupdate" "$FW/Versions/B/Updater.app" "$FW"; do codesign --force --timestamp --options runtime --sign "$IDENTITY" "$part"; done
# The app writes plans and dated tasks into Calendar and Reminders (PhoneSync.swift); under the hardened runtime that
# takes the calendars entitlement, without which macOS refuses the access without asking.
APPENT="$(mktemp -d)/kier.entitlements"
cat > "$APPENT" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.personal-information.calendars</key><true/>
</dict>
</plist>
PLIST
codesign --force --timestamp --options runtime --entitlements "$APPENT" --identifier com.getkier.kier --sign "$IDENTITY" "$APP"
codesign --verify --strict --deep --verbose=1 "$APP" 2>&1 | tail -1

notarize() {
  step "Notarizing $(basename "$1") (usually a few minutes)"
  xcrun notarytool submit "$1" --keychain-profile "$PROFILE" --wait | tee "$OUT/notary.log" | tail -3
  grep -q "status: Accepted" "$OUT/notary.log" || {
    ID="$(grep -m1 -oE 'id: [0-9a-f-]{36}' "$OUT/notary.log" | cut -d' ' -f2)"
    [[ -n "$ID" ]] && xcrun notarytool log "$ID" --keychain-profile "$PROFILE" >&2
    die "Apple did not accept $(basename "$1")"
  }
}

# --- Disk image ----------------------------------------------------------------------------------------------------
step "Making Kier.dmg"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "Kier" -srcfolder "$STAGE" -fs HFS+ -format UDZO -imagekey zlib-level=9 "$OUT/Kier.dmg"
codesign --force --timestamp --sign "$IDENTITY" "$OUT/Kier.dmg"
cp "$OUT/Kier.dmg" "$OUT/Kier-$VERSION.dmg"
if $RELEASE; then
  # Notarization uploads bytes too. Validate before the first submission to Apple.
  scripts/release-app.sh --validate-only
  ditto -c -k --keepParent "$APP" "$OUT/Kier-notarize.zip"
  notarize "$OUT/Kier-notarize.zip"
  rm "$OUT/Kier-notarize.zip"
  xcrun stapler staple "$APP" >/dev/null
  # Stapling changes the app. Build a fresh image and validate it before that upload.
  rm -rf "$STAGE/Kier.app"
  cp -R "$APP" "$STAGE/"
  rm "$OUT/Kier.dmg"
  hdiutil create -quiet -volname "Kier" -srcfolder "$STAGE" -fs HFS+ -format UDZO -imagekey zlib-level=9 "$OUT/Kier.dmg"
  codesign --force --timestamp --sign "$IDENTITY" "$OUT/Kier.dmg"
  cp "$OUT/Kier.dmg" "$OUT/Kier-$VERSION.dmg"
  scripts/release-app.sh --validate-only
  notarize "$OUT/Kier.dmg"
  xcrun stapler staple "$OUT/Kier.dmg" >/dev/null
  spctl --assess --type open --context context:primary-signature -v "$OUT/Kier.dmg" 2>&1 | tail -1
  cp "$OUT/Kier.dmg" "$OUT/Kier-$VERSION.dmg"
  # Stapling the DMG changes its length and signature: regenerate and check final metadata.
  scripts/release-app.sh --validate-only
fi
echo "$OUT/Kier.dmg ($(du -h "$OUT/Kier.dmg" | cut -f1), Node $NODE_VERSION)"
