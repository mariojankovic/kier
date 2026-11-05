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


ROOT = Path(__file__).resolve().parent.parent
BUILD_CACHE = Path.home() / 'Library/Caches/kier-build'


def names_only(gate, text, rel):
    # Compiled code and signing data are full of random letters; only the private names list applies to them.
    for n, line in enumerate(text.splitlines(), 1):
        for hit in gate.hits(line):
            gate.error(rel, n, f'private identity (names list line {hit})' if hit else 'private attribution identity')


def unsigned(path):
    with tempfile.TemporaryDirectory(prefix='kier-unsigned-') as temp:
        copy = Path(temp) / 'binary'
        shutil.copyfile(path, copy)
        subprocess.run(['codesign', '--remove-signature', str(copy)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return copy.read_bytes()


def header_ranges(data, offset=0):
    # Each Mach-O slice's header and load commands, where re-signing rewrites the signature's size.
    if offset == 0 and data[:4] == b'\xca\xfe\xba\xbe':
        ranges = []
        for i in range(int.from_bytes(data[4:8], 'big')):
            at = 8 + 20 * i
            ranges += header_ranges(data, int.from_bytes(data[at + 8:at + 12], 'big'))
        return ranges
    size = {b'\xcf\xfa\xed\xfe': 32, b'\xce\xfa\xed\xfe': 28}.get(data[offset:offset + 4])
    if size is None: raise ValueError('unexpected binary layout')
    return [(offset, offset + size + int.from_bytes(data[offset + 20:offset + 24], 'little'))]


def same_binary(shipped, original):
    # Third-party binaries must be the verified original, byte for byte, apart from the code signature.
    a, b = unsigned(shipped), unsigned(original)
    if len(a) != len(b): return False
    ranges, changed, step = header_ranges(b), 0, 1 << 20
    for start in range(0, len(a), step):
        if a[start:start + step] == b[start:start + step]: continue
        for i in range(start, min(start + step, len(a))):
            if a[i] != b[i]:
                changed += 1
                if changed > 64 or not any(lo <= i < hi for lo, hi in ranges): return False
    return True


def signature_manifest(gate, path, rel):
    # A code signature manifest is file names plus hashes: the names are checked, the hashes are not text.
    data = plistlib.loads(path.read_bytes())
    for section in ('files', 'files2'):
        names_only(gate, '\n'.join(data.get(section, {})), rel)


def official_node(shipped):
    for candidate in sorted(BUILD_CACHE.glob('node-v*-darwin-arm64')):
        binary = candidate / 'bin/node'
        if binary.is_file() and same_binary(shipped, binary): return candidate
    raise ValueError('bundled Node is not a verified official build')


def rebuilt_daemon(source, node_dir):
    # The packaged daemon is rebuilt from the validated source and the lockfile, exactly as packaging does.
    temp = Path(tempfile.mkdtemp(prefix='kier-daemon-check-'))
    daemon = temp / 'daemon'
    daemon.mkdir()
    for name in ('bin', 'lib', 'collectors', 'ui', 'sidecar'):
        shutil.copytree(source / 'daemon' / name, daemon / name, symlinks=True)
    for name in ('package.json', 'package-lock.json'):
        shutil.copy2(source / 'daemon' / name, daemon / name)
    subprocess.run([str(node_dir / 'bin/node'), str(node_dir / 'lib/node_modules/npm/bin/npm-cli.js'), 'ci', '--omit=dev',
                    '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], cwd=daemon, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['bun', str(ROOT / 'scripts/strip-comments.mjs'), str(daemon)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for junk in [*daemon.rglob('__pycache__'), *daemon.rglob('.DS_Store')]:
        shutil.rmtree(junk) if junk.is_dir() else junk.unlink()
    return temp, daemon


def rebuilt_icon(source):
    temp = Path(tempfile.mkdtemp(prefix='kier-icon-check-'))
    iconset = temp / 'Kier.iconset'
    iconset.mkdir()
    for s in (16, 32, 128, 256, 512):
        for size, name in ((s, f'icon_{s}x{s}.png'), (s * 2, f'icon_{s}x{s}@2x.png')):
            subprocess.run(['sips', '-z', str(size), str(size), str(source / 'app/icon/kier-icon.png'), '--out', str(iconset / name)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(temp / 'Kier.icns')], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return temp, (temp / 'Kier.icns').read_bytes()


def bundle(gate, app, source):
    info = app / 'Contents/Info.plist'
    if not info.is_file(): raise ValueError('missing bundle metadata')
    gate.file(info, 'bundle/Contents/Info.plist', release=True)
    resources = app / 'Contents/Resources'
    if not resources.is_dir() or not (resources / 'daemon/lib').is_dir():
        raise ValueError('release requires a packaged daemon')
    for path in sorted(app.rglob('*')):
        if path.is_symlink() and not path.resolve().is_relative_to(app.resolve()):
            raise ValueError('bundle symlink escapes its root')
    # Provenance applies to each part that is present; a part without it gets the full strict scan instead.
    node_dir = official_node(resources / 'runtime/node') if (resources / 'runtime/node').exists() else None
    packaged = (resources / 'daemon/node_modules').is_dir()
    if packaged and node_dir is None: raise ValueError('packaged daemon without its runtime')
    temp, icon_temp, icon = None, None, None
    try:
        if packaged:
            temp, daemon = rebuilt_daemon(source, node_dir)
            if inventory(daemon) != inventory(resources / 'daemon'):
                raise ValueError('packaged daemon differs from the validated source')
        if (resources / 'Kier.icns').exists():
            icon_temp, icon = rebuilt_icon(source)
        framework = None
        exact = {'Resources/orb.png': source / 'app/icon/orb-hd.png', 'Resources/changelog.json': source / 'app/changelog.json'}
        if node_dir: exact['Resources/runtime/LICENSE'] = node_dir / 'LICENSE'
        for path in sorted(app.rglob('*')):
            if path.is_symlink() or not path.is_file() or path == info: continue
            rel = path.relative_to(app / 'Contents').as_posix()
            label = 'bundle/Contents/' + rel
            if (packaged and rel.startswith('Resources/daemon/')) or (node_dir and rel == 'Resources/runtime/node'): continue
            if rel in exact:
                if path.read_bytes() != exact[rel].read_bytes(): raise ValueError('bundled file differs from its source')
            elif rel.startswith('Resources/brands/'):
                if path.read_bytes() != (source / 'app/brands' / path.name).read_bytes(): raise ValueError('bundled file differs from its source')
            elif rel == 'Resources/Kier.icns':
                if path.read_bytes() != icon: raise ValueError('bundled icon differs from its source')
            elif rel.startswith('Frameworks/Sparkle.framework/'):
                if framework is None:
                    sparkle = subprocess.run([str(ROOT / 'scripts/sparkle.sh')], check=True, capture_output=True, text=True).stdout.strip()
                    framework = Path(sparkle) / 'Sparkle.framework'
                original = framework / rel.removeprefix('Frameworks/Sparkle.framework/')
                if path.name == 'CodeResources':
                    signature_manifest(gate, path, label)
                elif privacy.binary_type(path.read_bytes()) == 'mach-o':
                    if not original.is_file() or not same_binary(path, original): raise ValueError('bundled Sparkle differs from its release')
                elif not original.is_file() or path.read_bytes() != original.read_bytes():
                    raise ValueError('bundled Sparkle differs from its release')
            elif rel == 'CodeResources':
                # Apple's stapled notarization ticket: a signed blob, checked by stapler and Gatekeeper before upload.
                names_only(gate, '\n'.join(privacy.strings(path.read_bytes())), label)
            elif rel == '_CodeSignature/CodeResources':
                signature_manifest(gate, path, label)
            elif rel in ('MacOS/Kier', 'Resources/default.metallib'):
                data = unsigned(path) if rel == 'MacOS/Kier' else path.read_bytes()
                names_only(gate, '\n'.join(privacy.strings(data)), label)
            else:
                gate.file(path, label, release=True)
    finally:
        for folder in (temp, icon_temp):
            if folder: shutil.rmtree(folder, ignore_errors=True)


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
    # The payload was compared file by file above; the compressed container itself is not text, but its metadata is.
    info = subprocess.run(['hdiutil', 'imageinfo', '-plist', str(image)], check=True, capture_output=True).stdout
    names_only(gate, info.decode('utf-8', 'replace'), 'artifacts/' + image.name)


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
    # The app's update address and the update feed name the public repository.
    gate.release_labels = {'bundle/Contents/Info.plist', 'artifacts/appcast.xml'}
    source = stage / 'source'
    for path in source.rglob('*'):
        if (path.is_file() or path.is_symlink()) and not privacy.allowed(path.relative_to(source).as_posix()):
            raise ValueError('snapshot has an unapproved source path')
    if not all((source / name).is_file() for name in privacy.DOCUMENTS):
        raise ValueError('snapshot is missing required documents')
    gate.tree(source)
    out, app = stage / 'artifacts', stage / 'Kier.app'
    bundle(gate, app, source)
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
