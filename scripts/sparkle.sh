#!/bin/bash
# Fetches Sparkle, the updater framework Kier ships with (app/Updater.swift), once into the build cache, checks it, and
# prints the folder holding Sparkle.framework and bin/ (sign_update, generate_keys).
set -euo pipefail
VERSION=2.10.1
SUM=1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27
CACHE="$HOME/Library/Caches/kier-build"
DIR="$CACHE/Sparkle-$VERSION"
if [[ ! -d "$DIR/Sparkle.framework" ]]; then
  mkdir -p "$CACHE"
  TARBALL="$CACHE/Sparkle-$VERSION.tar.xz"
  [[ -f "$TARBALL" ]] || curl -fsSL "https://github.com/sparkle-project/Sparkle/releases/download/$VERSION/Sparkle-$VERSION.tar.xz" -o "$TARBALL"
  echo "$SUM  $TARBALL" | shasum -a 256 -c - >/dev/null || { rm -f "$TARBALL"; echo "sparkle: download failed its checksum" >&2; exit 1; }
  mkdir -p "$DIR"
  tar -xJf "$TARBALL" -C "$DIR"
fi
echo "$DIR"
