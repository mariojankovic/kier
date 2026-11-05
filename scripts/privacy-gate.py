#!/usr/bin/env python3
"""Offline publication checks. Diagnostics contain locations and categories, never content."""
import argparse
import base64
import binascii
import collections
import ipaddress
import json
import math
import os
from pathlib import Path
import plistlib
import re
import struct
import subprocess
import sys
import unicodedata
import urllib.parse
import zlib

MAX_RUN = 16384
MAX_DECODED = 4 * 1024 * 1024
PNG_CHUNKS = {b'IHDR', b'PLTE', b'IDAT', b'IEND', b'tRNS', b'gAMA', b'sRGB'}
# No opaque source formats. Release containers are inspected separately, never skipped.
BINARY_ALLOWLIST = {'png', 'plist', 'icns', 'mach-o', 'metallib'}
SOURCE_BINARIES = {'png'}
SCRIPTS = {'build-app.sh', 'package-app.sh', 'release-app.sh', 'sparkle.sh', 'strip-comments.mjs',
           'publish-source.sh', 'privacy-gate.py', 'release-validation.py'}
DOCUMENTS = {'README.md', 'LICENSE', 'SECURITY.md'}
REPOSITORY_IDENTITY_FILES = {'LICENSE', 'SECURITY.md', 'scripts/publish-source.sh',
                             'scripts/build-app.sh', 'scripts/package-app.sh'}


def fold(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', value).casefold()
                   if not unicodedata.combining(c) and unicodedata.category(c) != 'Cf').replace('đ', 'd').replace('ł', 'l')


class Gate:
    def __init__(self, identities, names_file=None):
        if not isinstance(identities, dict) or set(identities) - {'license', 'repository'}:
            raise ValueError('invalid identity allowlist')
        if any(not isinstance(value, str) for value in identities.values()):
            raise ValueError('invalid identity exception')
        self.identities = identities
        self.errors = set()
        self.count = 0
        names_file = names_file or Path.home() / '.config/kier-public/names.txt'
        try:
            lines = names_file.read_text().splitlines()
        except (OSError, UnicodeError):
            raise ValueError('private name list is missing or unreadable') from None
        self.names = [(n, fold(s.strip())) for n, s in enumerate(lines, 1)
                      if s.strip() and not s.lstrip().startswith('#')]
        if not self.names:
            raise ValueError('private name list is empty')
        # Also protect the attribution's identity if the private list omitted it.
        self.names += [(0, fold(s)) for s in identities.get('license', '').split()[2:]]
        self.patterns = []
        ending = r'(?:a|e|i|o|u|om|em|im|og|eg|ih|ov|ev|in|ic|oga|ega|ome|eme|ima|ama|ova|ove|ovi|ovu|ina|ine|ini|inu)'
        for n, word in self.names:
            forms = {re.escape(word) + (r'[a-z]{0,3}' if len(word) >= 4 else ending + '?')}
            if len(word) >= 4:
                stems = {word}
                if word[-1:] in 'aeiou':
                    stems.add(word[:-1])
                # Fleeting a and the l restored in oblique forms of -ao names.
                if re.search(r'a[cklnr]$', word):
                    stems.add(word[:-2] + word[-1])
                if word.endswith('ao'):
                    stems.add(word[:-2] + 'l')
                # Changed stems need case endings, not arbitrary continuations.
                # Names ending in a retain that vowel in the vocative; replacing
                # it with o also collides with ordinary Croatian adverbs.
                changed_ending = ending.replace('|o|', '|') if word.endswith('a') else ending
                forms.update(re.escape(stem) + changed_ending for stem in stems if stem != word)
                for stem in stems:
                    if stem[-1:] in {'k', 'g', 'h'} and (stem == word or word[-1:] not in 'eiou'):
                        palatal = stem[:-1] + {'k': 'c', 'g': 'z', 'h': 's'}[stem[-1]]
                        forms.add(re.escape(palatal) + r'[ie](?:ma|m|h)?')
            self.patterns.append((n, re.compile(r'(?<![a-z])(?:' + '|'.join(sorted(forms)) + r')(?![a-z])'), word))

    def hits(self, text):
        split = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1 \2', text)
        split = re.sub(r'([a-z])([A-Z])', r'\1 \2', split)
        split = re.sub(r'[_\-\d]+', ' ', split)
        raw, words = fold(text), fold(split)
        return {n for n, pat, word in self.patterns
                if pat.search(words) or pat.search(raw) or (len(word) >= 5 and word in raw)}

    def error(self, path, line, kind):
        # A filename can itself contain private data. Do not echo it back.
        safe = '<withheld path>' if self.hits(str(path)) else str(path)
        self.errors.add(f'{safe}:{line}: {kind}')

    def exempt(self, text, path):
        if path == 'LICENSE' and text == self.identities.get('license'):
            return ''
        declaration = "IDENTITY_ALLOWLIST='" + json.dumps(self.identities, separators=(',', ':')) + "'"
        if path == 'scripts/publish-source.sh' and text == declaration:
            return ''
        if path not in REPOSITORY_IDENTITY_FILES or not self.identities.get('repository'):
            return text
        repo = re.escape(self.identities['repository'])
        return re.sub(r'(?<![\w.])' + repo + r'(?![\w.-])', 'public-repository', text)

    def text(self, text, path, line_offset=0, exemptions=True):
        # Decoding is recursive but bounded. Exceeding the budget fails closed.
        if exemptions:
            text = '\n'.join(self.exempt(line, str(path)) for line in text.splitlines())
        queue = collections.deque([(text, 0, line_offset)])
        seen = set()
        budget = 0
        while queue:
            current, depth, offset = queue.popleft()
            if current in seen:
                continue
            seen.add(current)
            budget += len(current)
            if budget > max(MAX_DECODED, len(text) * 8):
                self.error(path, offset + 1, 'encoded text exceeds scan budget')
                return
            for n, original in enumerate(current.splitlines(), offset + 1):
                line = original
                line = re.sub(r'\\[nrt]', ' ', line)
                hits = self.hits(line)
                for hit in hits:
                    self.error(path, n, f'private identity (names list line {hit})' if hit else 'private attribution identity')
                self.sensitive(line, path, n)
                if re.search(r'''(?i)(?:key|token|secret|password)[\w.-]*["']?\s*[:=]\s*$''', line):
                    following = current.splitlines()[n - offset:n - offset + 2]
                    self.sensitive(' '.join([line, *following]), path, n)
            if depth >= 4:
                if self.decoded(current):
                    self.error(path, offset + 1, 'encoding nesting exceeds scan limit')
                continue
            for decoded, start in self.decoded(current):
                queue.append((decoded, depth + 1, offset + current[:start].count('\n')))

    @staticmethod
    def decoded(text):
        values = []
        def add(data, start):
            try:
                whole = data.decode('utf-8')
                if whole and all(c.isprintable() or c in '\n\r\t' for c in whole):
                    values.append((whole, start))
                    return
            except UnicodeError:
                pass
            # Extract every textual run even when decoded bytes also contain nontext bytes.
            for value in strings(data):
                if value:
                    values.append((value, start))
        runs = []
        # Rejoin wrapped payloads and adjacent quoted segments before decoding.
        # Keep each reconstructed run in the existing recursive scan budget.
        segment = r'[A-Za-z0-9_+/-]+={0,2}'
        quoted = r"[\"']" + segment + r"[\"']"
        for match in re.finditer(quoted + r'(?:\s*(?:\+\s*)?' + quoted + r')+', text):
            parts = re.findall(r"[\"'](" + segment + r")[\"']", match[0])
            joined = ''.join(parts)
            if len(joined) >= 4:
                runs.append((joined, match.start()))
        wrapped = r'(?m)^[ \t]*(' + segment + r')[ \t]*(?:\r?\n[ \t]*' + segment + r'[ \t]*)+'
        for match in re.finditer(wrapped, text):
            joined = re.sub(r'\s+', '', match[0])
            if len(joined) >= 4:
                runs.append((joined, match.start()))
        # A run longer than the bound is scanned in overlapping bounded windows.
        for match in re.finditer(r'(?<![A-Za-z0-9_+/-])[A-Za-z0-9_+/-]{4,}={0,2}(?![A-Za-z0-9_+/-])', text):
            runs.append((match[0], match.start()))
        for run, start in runs:
            for at in range(0, len(run), MAX_RUN // 2):
                part = run[at:at + MAX_RUN]
                if len(part) % 4 == 1:
                    continue
                if any(c in part for c in '+/') and any(c in part for c in '-_'):
                    continue
                try:
                    add(base64.b64decode(part + '=' * (-len(part) % 4), altchars=b'-_' if '-' in part or '_' in part else None, validate=True), start + at)
                except (ValueError, binascii.Error):
                    pass
        for match in re.finditer(r'(?<![0-9a-fA-F])(?:0x)?(?:[0-9a-fA-F]{2}){2,}(?![0-9a-fA-F])', text):
            run = match[0].removeprefix('0x')
            for at in range(0, len(run), MAX_RUN // 2):
                add(bytes.fromhex(run[at:at + MAX_RUN]), match.start() + at)
        for pattern, decode in [
            (r'(?:%[0-9a-fA-F]{2})+', lambda s: urllib.parse.unquote_to_bytes(s)),
            (r'(?:\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}))+',
             lambda s: re.sub(r'\\(?:u\{([0-9a-fA-F]+)\}|[uUx]([0-9a-fA-F]+))',
                              lambda m: chr(int(m[1] or m[2], 16)), s).encode('utf-8')),
        ]:
            # Decode in the surrounding text too: mixed literal/escaped names must join.
            # Reject oversized escaped runs rather than silently scanning only a prefix.
            if any(len(match[0]) > MAX_RUN for match in re.finditer(pattern, text)):
                raise ValueError('escaped run exceeds decoding limit')
            try:
                decoded = re.sub(pattern, lambda m: decode(m[0]).decode('utf-8', errors='replace'), text)
                if decoded != text:
                    values.append((decoded, 0))
            except (ValueError, UnicodeError):
                pass
        return values

    def sensitive(self, line, path, n):
        checks = [
            (r'-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----', 'private key block'),
            (r'\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}', 'GitHub credential'),
            (r'\bsk-(?:proj-|svcacct-|ant-(?:api\d+-|admin\d+-)?)?[A-Za-z0-9_-]{20,}', 'AI provider credential'),
            (r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b', 'AWS credential'),
            (r'\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}', 'Stripe credential'),
            (r'\bxox[baprs]-[A-Za-z0-9-]{16,}|https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+', 'Slack credential'),
            (r'(?i)(?:/Users[/]|/home[/])[^\s/"\'<>]*|[A-Z]:[\\/]Users[\\/][^\s\\/"\'<>]+', 'absolute user home path'),
            
        ]
        for pattern, kind in checks:
            if re.search(pattern, line):
                self.error(path, n, kind)
        # Quoted/unquoted assignments, JSON, env, and XML/plist values.
        assignment = re.compile(r"""(?ix)\b([\w.-]*(?:key|token|secret|password|passwd)[\w.-]*)["']?\s*[:=]\s*(?:(["'])([^\s"'<>]{16,})\2|([A-Za-z0-9+/=_!@#$%^&*-]{20,})(?=\s*$))""")
        for m in assignment.finditer(line):
            # Swift lookup argument labels read an existing preference; they do not assign a secret.
            if m[1] in {'forKey', 'forInfoDictionaryKey'} and '=' not in line[m.start():m.start(3) if m[3] else m.start(4)]:
                continue
            value = m[3] or m[4]
            counts = collections.Counter(value)
            entropy = -sum(c / len(value) * math.log2(c / len(value)) for c in counts.values())
            if entropy >= 3.5:
                self.error(path, n, 'high-entropy credential assignment')
        iban_lengths = {'HR': 21, 'DE': 22, 'GB': 22, 'FR': 27, 'IT': 27, 'ES': 24, 'NL': 18,
                        'AT': 20, 'BE': 16, 'CH': 21, 'SI': 19, 'PL': 28, 'IE': 22, 'PT': 25,
                        'DK': 18, 'FI': 18, 'SE': 24, 'NO': 15, 'HU': 28, 'CZ': 24, 'SK': 24,
                        'RO': 24, 'BG': 22, 'GR': 27, 'CY': 28, 'MT': 31, 'LT': 20, 'LV': 21,
                        'EE': 20, 'LU': 20, 'IS': 26, 'TR': 26, 'RS': 22, 'BA': 20, 'ME': 22}
        for match in re.finditer(r'\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b', line, re.I):
            value = match[0].replace(' ', '').upper()
            if len(value) == iban_lengths.get(value[:2]):
                self.error(path, n, 'IBAN-shaped value')
        if re.search(r'(?i)sparkle.*(?:private|secret)|(?:private|secret).*sparkle', line) and re.search(r'[A-Za-z0-9+/]{40,}={0,2}', line):
            self.error(path, n, 'Sparkle private signing key')
        if re.search(r'(?i)team[ _-]?(?:id|identifier)|development_team|codesign|sign(?:ing)?[ _-]?identity|developer id|apple development|com\.apple\.developer\.team-identifier', line):
            if re.search(r'(?<![A-Za-z0-9])[A-Z0-9]{10}(?![A-Za-z0-9])', line):
                self.error(path, n, 'Apple signing team identifier')
        mail = re.sub(r'git@github\.com:', 'github-ssh:', line)
        for m in re.finditer(r'[A-Z0-9_][A-Z0-9_.+%-]*@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+', mail, re.I):
            domain = m[0].rsplit('@', 1)[1].lower()
            if not (domain in {'example.com', 'example.org'} or domain.endswith(('.example.com', '.example.org', '.test', '.invalid'))
                    or m[0].lower() == 'noreply@github.com'):
                self.error(path, n, 'non-documentation email')
        numeric = re.sub(r'\b\d{4}-\d{2}-\d{2}\b', '', line)
        def ipv4(m):
            try:
                ipaddress.IPv4Address(m[0]); return ''
            except ValueError:
                return m[0]
        numeric = re.sub(r'(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])', ipv4, numeric)
        numeric = re.sub(r'(?<![\w.+])\d+\.\d+(?![\w.])', '', numeric)
        if str(path).endswith('.svg'):
            numeric = re.sub(r'\b(?:d|points|viewBox|transform|cx|cy|r|x|y|width|height)="[0-9eE., +()MLHVCSQTAZmlhvcsqtaz-]*"', '', numeric)
        if re.search(r'(?<![\w])(?:\+\d(?:[ ().-]*\d){6,14}|\d(?:[ ().-]*\d){8,14})(?![\w])', numeric):
            self.error(path, n, 'possible telephone number')

    def png(self, data, path):
        at = 8
        kinds = []
        image_data = bytearray()
        width = height = depth = color = interlace = 0
        idat_done = False
        while at < len(data):
            if at + 12 > len(data):
                raise ValueError('truncated PNG chunk')
            size, kind = struct.unpack('>I4s', data[at:at + 8])
            end = at + size + 12
            if end > len(data) or size > 0x7fffffff:
                raise ValueError('invalid PNG chunk length')
            payload = data[at + 8:end - 4]
            crc = struct.unpack('>I', data[end - 4:end])[0]
            if zlib.crc32(kind + payload) & 0xffffffff != crc:
                raise ValueError('invalid PNG checksum')
            if kind not in PNG_CHUNKS:
                raise ValueError('PNG metadata or unapproved chunk')
            if kind != b'IDAT':
                for value in strings(payload):
                    self.text(value, path, exemptions=False)
            if not kinds and (kind != b'IHDR' or size != 13):
                raise ValueError('PNG must start with IHDR')
            if kind == b'IHDR':
                if kinds or size != 13:
                    raise ValueError('invalid PNG header')
                width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', payload)
                valid_depths = {0: {1, 2, 4, 8, 16}, 2: {8, 16}, 3: {1, 2, 4, 8}, 4: {8, 16}, 6: {8, 16}}
                if not width or not height or depth not in valid_depths.get(color, set()) or compression or filtering or interlace not in {0, 1}:
                    raise ValueError('invalid PNG header fields')
            if kind == b'IDAT':
                image_data.extend(payload)
            if kind in {b'sRGB', b'gAMA'} and b'IDAT' in kinds:
                raise ValueError('late PNG ancillary chunk')
            sizes = {b'sRGB': 1, b'gAMA': 4}
            if kind in sizes and size != sizes[kind]:
                raise ValueError('invalid PNG ancillary length')
            if kind == b'IDAT' and idat_done:
                raise ValueError('noncontiguous PNG image data')
            if kinds and kinds[-1] == b'IDAT' and kind != b'IDAT':
                idat_done = True
            if kind in {b'IHDR', b'PLTE', b'sRGB', b'gAMA'} and kind in kinds:
                raise ValueError('duplicate PNG chunk')
            if kind == b'PLTE' and (b'IDAT' in kinds or size % 3 or not 0 < size <= 768):
                raise ValueError('invalid PNG palette')
            if kind == b'tRNS':
                if b'IDAT' in kinds or kind in kinds or color in {4, 6}:
                    raise ValueError('invalid PNG transparency')
                if (color == 0 and size != 2) or (color == 2 and size != 6) or (color == 3 and (b'PLTE' not in kinds or not 0 < size <= palette_size)):
                    raise ValueError('invalid PNG transparency length')
            if kind == b'PLTE':
                palette_size = size // 3
            kinds.append(kind)
            at = end
            if kind == b'IEND':
                if size or at != len(data) or b'IDAT' not in kinds:
                    raise ValueError('invalid PNG end or trailing data')
                channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
                stride = (width * channels * depth + 7) // 8 + 1
                maximum = 128 * 1024 * 1024
                if stride * height > maximum or (color == 3 and b'PLTE' not in kinds):
                    raise ValueError('unbounded PNG or missing palette')
                stream = zlib.decompressobj()
                raw = stream.decompress(image_data, maximum + 1)
                if len(raw) > maximum or not stream.eof or stream.unused_data:
                    raise ValueError('invalid PNG compressed data')
                if not interlace and (len(raw) != stride * height or any(raw[i] > 4 for i in range(0, len(raw), stride))):
                    raise ValueError('invalid PNG rows')
                return
        raise ValueError('missing PNG end')

    def file(self, path, rel, release=False):
        self.count += 1
        self.text(str(rel), rel, exemptions=False)
        if path.is_symlink() or not path.is_file():
            self.error(rel, 1, 'symlink or missing file'); return
        data = path.read_bytes()
        kind = binary_type(data)
        if kind:
            if kind not in (BINARY_ALLOWLIST if release else SOURCE_BINARIES):
                self.error(rel, 1, 'unapproved binary type')
            try:
                if kind == 'png':
                    self.png(data, rel)
                elif kind == 'plist':
                    self.text(plistlib.dumps(plistlib.loads(data)).decode(), rel)
                elif kind == 'icns':
                    size = struct.unpack('>I', data[4:8])[0]
                    if size != len(data):
                        raise ValueError('invalid icon container')
                    at = 8
                    while at < size:
                        length = struct.unpack('>I', data[at + 4:at + 8])[0]
                        if length < 8 or at + length > size:
                            raise ValueError('invalid icon element')
                        payload = data[at + 8:at + length]
                        if payload.startswith(b'\x89PNG\r\n\x1a\n'):
                            self.png(payload, rel)
                        at += length
            except (ValueError, struct.error, zlib.error, plistlib.InvalidFileException):
                self.error(rel, 1, 'invalid binary structure or forbidden metadata')
            # Structural validation does not replace a full-file strings scan.
            for value in strings(data):
                self.text(value, rel, exemptions=False)
            return
        try:
            value = data.decode('utf-8')
            if '\0' in value or any(ord(c) < 32 and c not in '\n\r\t\f' for c in value):
                raise UnicodeError()
            self.text(value, rel)
            # Signing/key contexts can span XML lines.
            flattened = re.sub(r'>\s*<', '><', value)
            if re.search(r'(?i)<key>(?:DevelopmentTeam|TeamIdentifier|com\.apple\.developer\.team-identifier)</key><string>[A-Z0-9]{10}</string>', flattened):
                self.error(rel, 1, 'Apple signing team identifier')
            if re.search(r'(?i)<key>[^<]*(?:private|secret|password|token|api.?key)[^<]*</key><string>[A-Za-z0-9+/=_-]{24,}</string>', flattened):
                self.error(rel, 1, 'credential in plist')
        except UnicodeError:
            self.error(rel, 1, 'unknown binary type')
            for value in strings(data):
                self.text(value, rel, exemptions=False)

    def tree(self, root, release=False):
        for path in sorted(root.rglob('*')):
            if path.is_symlink() or path.is_file():
                self.file(path, path.relative_to(root).as_posix(), release)

    def finish(self):
        if self.errors:
            print('\n'.join(sorted(self.errors)), file=sys.stderr)
            raise ValueError('privacy gate FAILED')
        print(f'Privacy gate clean: {self.count} files')


def strings(data):
    # UTF-8 (including accented text), ASCII, and both UTF-16 byte orders.
    result = re.findall(r'[^\x00-\x1f\x7f-\x9f\ufffd]{4,}', data.decode('utf-8', errors='replace'))
    for encoding in ('utf-16-le', 'utf-16-be'):
        # Latin and extended Latin runs retain accented names without treating arbitrary
        # compressed pixels as UTF-16 prose.
        pattern = (rb'(?:[\x20-\x7e\xa0-\xff]\x00|[\x00-\xff][\x01-\x02]){4,}'
                   if encoding.endswith('le') else
                   rb'(?:\x00[\x20-\x7e\xa0-\xff]|[\x01-\x02][\x00-\xff]){4,}')
        result.extend(m[0].decode(encoding) for m in re.finditer(pattern, data))
    return result


def binary_type(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n'): return 'png'
    if data.startswith(b'bplist00'): return 'plist'
    if data.startswith(b'icns'): return 'icns'
    if data[:4] in {b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xca\xfe\xba\xbe'}: return 'mach-o'
    if data.startswith(b'MTLB'): return 'metallib'
    return None


def allowed(name):
    p = Path(name)
    if any(s.startswith('.') or s in {'node_modules', '__pycache__'} for s in p.parts): return False
    if len(p.parts) == 1: return name in DOCUMENTS
    if p.parts[0] == 'app': return p.parts[:3] != ('app', 'icon', 'explorations')
    if p.parts[0] == 'daemon':
        return p.parts[1] in {'lib', 'collectors', 'sidecar', 'ui', 'bin', 'tests'} or name in {'daemon/package.json', 'daemon/package-lock.json'}
    return p.parts[0] == 'scripts' and len(p.parts) == 2 and p.name in SCRIPTS


def strip_png_metadata(data):
    at = 8
    output = bytearray(data[:8])
    while at < len(data):
        if at + 12 > len(data):
            raise ValueError('truncated PNG chunk')
        size, kind = struct.unpack('>I4s', data[at:at + 8])
        end = at + size + 12
        if end > len(data) or size > 0x7fffffff:
            raise ValueError('invalid PNG chunk length')
        payload = data[at + 8:end - 4]
        if zlib.crc32(kind + payload) & 0xffffffff != struct.unpack('>I', data[end - 4:end])[0]:
            raise ValueError('invalid PNG checksum')
        if kind in PNG_CHUNKS or not kind[0] & 32:
            output.extend(data[at:end])
        at = end
        if kind == b'IEND' and at != len(data):
            raise ValueError('trailing PNG data')
    return bytes(output)


def export(root, tree, gate):
    paths = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z']).decode().split('\0')
    for name in filter(allowed, filter(None, paths)):
        src, dest = root / name, tree / name
        if any((root / Path(*Path(name).parts[:n])).is_symlink() for n in range(1, len(Path(name).parts) + 1)):
            gate.error(name, 1, 'symlink is not permitted'); continue
        if not src.is_file():
            gate.error(name, 1, 'tracked source file is missing'); continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        data = src.read_bytes()
        if binary_type(data) == 'png':
            data = strip_png_metadata(data)
        dest.write_bytes(data)
        dest.chmod(0o755 if os.access(src, os.X_OK) else 0o644)
    for name in DOCUMENTS:
        if not (tree / name).is_file(): gate.error(name, 1, 'required tracked document is missing')
    gate.tree(tree)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--identities', required=True)
    parser.add_argument('--export', nargs=2, metavar=('ROOT', 'TREE'))
    parser.add_argument('--scan', type=Path)
    args = parser.parse_args()
    try:
        gate = Gate(json.loads(args.identities))
        if args.export: export(*map(Path, args.export), gate)
        elif args.scan: gate.tree(args.scan)
        else: raise ValueError('no validation input')
        gate.finish()
    except (ValueError, OSError):
        sys.exit('publish-source: validation failed (no content printed)')


if __name__ == '__main__':
    main()
