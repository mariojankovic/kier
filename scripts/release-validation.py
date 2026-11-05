#!/usr/bin/env python3
"""Freeze and verify the exact offline inputs shared by both release destinations."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('privacy_gate', Path(__file__).with_name('privacy-gate.py'))
privacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(privacy)


def inventory(root):
    if root.is_symlink() or not root.is_dir():
        raise ValueError('inventory root must be a real directory')
    rows = {'.': {'type': 'directory', 'mode': root.stat().st_mode & 0o777}}
    for path in sorted(root.rglob('*')):
        rel = path.relative_to(root).as_posix()
        if rel == 'validation.json': continue
        if path.is_symlink():
            rows[rel] = {'link': os.readlink(path)}
        elif path.is_dir():
            rows[rel] = {'type': 'directory', 'mode': path.stat().st_mode & 0o777}
        elif path.is_file():
            rows[rel] = {'sha256': hashlib.file_digest(path.open('rb'), 'sha256').hexdigest(),
                         'mode': path.stat().st_mode & 0o777}
    return rows


def bundle(gate, app):
    info = app / 'Contents/Info.plist'
    if not info.is_file(): raise ValueError('missing bundle metadata')
    gate.file(info, 'bundle/Contents/Info.plist', release=True)
    resources = app / 'Contents/Resources'
    if not resources.is_dir() or not (resources / 'daemon/lib').is_dir():
        raise ValueError('release requires a packaged daemon')
    # Every resource, including dependencies and binary strings, must pass.
    for path in sorted(resources.rglob('*')):
        if path.is_symlink():
            if not path.resolve().is_relative_to(app.resolve()):
                raise ValueError('resource symlink escapes its bundle')
            gate.text(os.readlink(path), 'bundle/' + path.relative_to(app).as_posix(), exemptions=False)
        elif path.is_file():
            gate.file(path, 'bundle/' + path.relative_to(app).as_posix(), release=True)
    for path in sorted(app.rglob('*')):
        if path.is_symlink():
            target = path.resolve()
            if not target.is_relative_to(app.resolve()): raise ValueError('bundle symlink escapes its root')
        elif path.is_file() and resources not in path.parents and path != info:
            gate.file(path, 'bundle/' + path.relative_to(app).as_posix(), release=True)


def disk_image(gate, image, app):
    # A DMG is not an opaque allowlist exception: mount read-only and compare all payloads.
    with tempfile.TemporaryDirectory(prefix='kier-dmg-check-') as temp:
        mount = Path(temp) / 'volume'
        mount.mkdir()
        attached = False
        try:
            subprocess.run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', str(mount), str(image)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            attached = True
            entries = {p.name for p in mount.iterdir()}
            if entries != {'Kier.app', 'Applications'}:
                raise ValueError('unexpected disk image payload')
            link = mount / 'Applications'
            if not link.is_symlink() or os.readlink(link) != '/Applications':
                raise ValueError('unexpected application shortcut')
            payload = mount / 'Kier.app'
            if payload.is_symlink() or not payload.is_dir() or not payload.resolve().is_relative_to(mount.resolve()):
                raise ValueError('disk image app root must be a real contained directory')
            if inventory(payload) != inventory(app):
                raise ValueError('disk image does not contain the validated app')
        finally:
            if attached:
                subprocess.run(['hdiutil', 'detach', str(mount)], check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # Also inspect container strings. Payload text was checked in its expanded form above.
    for value in privacy.strings(image.read_bytes()):
        gate.text(value, 'artifacts/' + image.name, exemptions=False)


def prepare(root, stage, version, identities):
    if (stage / 'validation.json').exists(): raise ValueError('snapshot already sealed')
    out = stage / 'artifacts'
    out.mkdir()
    names = ['Kier.dmg', f'Kier-{version}.dmg', 'appcast.xml', 'release-notes.md']
    for name in names:
        src = root / 'dist' / name
        if src.is_symlink() or not src.is_file(): raise ValueError('release artifact missing or linked')
        shutil.copyfile(src, out / name)
    app = stage / 'Kier.app'
    shutil.copytree(root / 'dist/Kier.app', app, symlinks=True)
    validate_inputs(stage, version, identities)
    manifest = {'version': version, 'artifacts': names, 'files': inventory(stage)}
    (stage / 'validation.json').write_text(json.dumps(manifest, sort_keys=True))


def validate_inputs(stage, version, identities):
    gate = privacy.Gate(identities)
    source = stage / 'source'
    for path in source.rglob('*'):
        if (path.is_file() or path.is_symlink()) and not privacy.allowed(path.relative_to(source).as_posix()):
            raise ValueError('snapshot has an unapproved source path')
    if not all((source / name).is_file() for name in privacy.DOCUMENTS):
        raise ValueError('snapshot is missing required documents')
    gate.tree(source)
    out, app = stage / 'artifacts', stage / 'Kier.app'
    bundle(gate, app)
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    if info['CFBundleShortVersionString'] != version: raise ValueError('bundle version mismatch')
    gate.file(out / 'release-notes.md', 'artifacts/release-notes.md')
    gate.file(out / 'appcast.xml', 'artifacts/appcast.xml')
    # The full changelog is in source and Resources, not just the title used as notes.
    changes = json.loads((stage / 'source/app/changelog.json').read_text())
    if not any(row.get('version') == version for row in changes): raise ValueError('missing changelog entry')
    cast = ET.parse(out / 'appcast.xml')
    enclosure = cast.find('./channel/item/enclosure')
    if enclosure is None or not enclosure.get('url', '').endswith(f'/v{version}/Kier-{version}.dmg'):
        raise ValueError('appcast artifact mismatch')
    if int(enclosure.get('length', '0')) != (out / f'Kier-{version}.dmg').stat().st_size:
        raise ValueError('appcast size mismatch')
    if (out / 'Kier.dmg').read_bytes() != (out / f'Kier-{version}.dmg').read_bytes():
        raise ValueError('download aliases differ')
    gate.finish()
    disk_image(gate, out / 'Kier.dmg', app)
    gate.finish()


def verify(stage, version=None):
    if stage.is_symlink(): raise ValueError('linked snapshot')
    manifest = json.loads((stage / 'validation.json').read_text())
    actual_version = manifest['version']
    if version and actual_version != version: raise ValueError('snapshot version mismatch')
    if manifest['artifacts'] != ['Kier.dmg', f'Kier-{actual_version}.dmg', 'appcast.xml', 'release-notes.md']:
        raise ValueError('unapproved artifact list')
    if inventory(stage) != manifest['files']: raise ValueError('validated inputs changed')
    policy = Path(__file__).with_name('publish-source.sh').read_text()
    identities = json.loads(re.search(r"^IDENTITY_ALLOWLIST='(.+)'$", policy, re.M)[1])
    # Hashes detect changes; a fresh scan also prevents a rewritten manifest bypass.
    validate_inputs(stage, actual_version, identities)
    print('Validated snapshot unchanged')


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'prepare': prepare(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4], json.loads(sys.argv[5]))
        elif sys.argv[1] == 'verify': verify(Path(sys.argv[2]), sys.argv[3] if len(sys.argv) > 3 else None)
        else: raise ValueError('unknown validation command')
    except (ValueError, OSError, KeyError, subprocess.SubprocessError, ET.ParseError):
        sys.exit('release validation FAILED (no artifact content printed)')
