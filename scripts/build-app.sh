#!/bin/sh
# Builds ~/Applications/Kier.app for development: it runs the daemon from this repo with Homebrew's Node (scripts/package-app.sh makes the
# self-contained one people download). Signing with the same identity and identifier keeps the Full Disk Access
# grant valid across rebuilds; an ad hoc signature would need granting again every time.
set -e
cd "$(dirname "$0")/.."
# Optional settings on the release machine; never part of the public export.
[ ! -f scripts/local.env ] || . ./scripts/local.env
ROOT="$(pwd)"
APP="${KIER_APP:-$HOME/Applications/Kier.app}"
# Whoever builds it signs with their own certificate: the first Developer ID (or Apple Development) one in the
# keychain, unless KIER_SIGN_IDENTITY names another; with none, an ad hoc signature.
IDS="$(security find-identity -v -p codesigning 2>/dev/null)"
IDENTITY="${KIER_SIGN_IDENTITY:-$(printf '%s\n' "$IDS" | grep -m1 -oE '"Developer ID Application[^"]*"' | tr -d '"')}"
IDENTITY="${IDENTITY:-$(printf '%s\n' "$IDS" | grep -m1 -oE '"Apple Development[^"]*"' | tr -d '"')}"
IDENTITY="${IDENTITY:--}"
NODE="$(command -v node)"
SPARKLE="$(scripts/sparkle.sh)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
swiftc -O -F "$SPARKLE" -framework Sparkle -Xlinker -rpath -Xlinker @executable_path/../Frameworks app/*.swift -o "$APP/Contents/MacOS/Kier"
# Sparkle, for updates (app/Updater.swift); Kier isn't sandboxed, so without its XPC services.
FW="$APP/Contents/Frameworks/Sparkle.framework"
ditto "$SPARKLE/Sparkle.framework" "$FW"
rm -rf "$FW/XPCServices" "$FW/Versions/B/XPCServices"
# The companion orb is a Metal shader; SwiftUI loads it from the app's default.metallib. METAL and METALLIB can name
# another compiler when Xcode's own Metal toolchain isn't installed.
SHADERS="$(mktemp -d)"
xcrun -sdk macosx "${METAL:-metal}" -c app/orb.metal -o "$SHADERS/orb.air"
xcrun -sdk macosx "${METALLIB:-metallib}" "$SHADERS/orb.air" -o "$APP/Contents/Resources/default.metallib"
# High-resolution orb artwork, loaded once with mipmaps.
cp app/icon/orb-hd.png "$APP/Contents/Resources/orb.png"
# Brand marks for where things came from (Design.swift, Brand).
cp -R app/brands "$APP/Contents/Resources/brands"
# What changed in each version, for the app's What's new page.
cp app/changelog.json "$APP/Contents/Resources/changelog.json"
# Every size macOS asks for, from the one 1024 px master: the Sealed Sun artwork fitted to Apple's 824/1024 grid.
ICONSET="$(mktemp -d)/Kier.iconset"
mkdir -p "$ICONSET"
for s in "16" "32" "128" "256" "512"; do
  sips -z $s $s app/icon/kier-icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) app/icon/kier-icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Kier.icns"
sed -e "s#__ROOT__#$ROOT/daemon#" -e "s#__NODE__#$NODE#" app/Info.plist > "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :SUFeedURL ${KIER_UPDATE_FEED:-https://github.com/${KIER_PUBLIC_REPO:-mariojankovic/kier}/releases/latest/download/appcast.xml}" "$APP/Contents/Info.plist"
for part in "$FW/Versions/B/Autoupdate" "$FW/Versions/B/Updater.app" "$FW"; do codesign --force --options runtime --sign "$IDENTITY" "$part"; done
codesign --force --options runtime --identifier com.getkier.kier --sign "$IDENTITY" "$APP"
codesign --verify --strict "$APP"
echo "$APP"
