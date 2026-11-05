import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'

const scripts = fileURLToPath(new URL('../../scripts/', import.meta.url))
const publisher = join(scripts, 'publish-source.sh')
const available = existsSync(publisher)
const write = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
const privateWord = () => 'qza' + [...randomBytes(10)].map(b => String.fromCharCode(97 + b % 26)).join('')
const identities = available ? JSON.parse(readFileSync(publisher, 'utf8').match(/^IDENTITY_ALLOWLIST='(.+)'$/m)[1]) : {}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kier-export-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const home = join(dir, 'home'), repo = join(dir, 'repo'), scan = join(dir, 'scan'), bin = join(dir, 'bin')
  const word = privateWord(), names = join(home, '.config/kier-public/names.txt')
  write(names, word + '\n'); mkdirSync(scan); mkdirSync(bin)
  for (const name of ['publish-source.sh', 'privacy-gate.py', 'release-validation.py', 'release-app.sh']) {
    write(join(repo, 'scripts', name), readFileSync(join(scripts, name)))
  }
  const calls = join(dir, 'unexpected-calls')
  for (const name of ['gh', 'rsync', 'curl', 'hdiutil', 'xcrun']) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$CALL_LOG"\nexit 97\n`, { mode: 0o755 })
  }
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir, CALL_LOG: calls, KIER_PUBLIC_REPO: 'off', KIER_RELEASES_REPO: 'example/releases' }
  const run = (command, args) => spawnSync(command, args, { env, encoding: 'utf8', cwd: repo })
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, stdio: 'pipe' })
  const check = () => run('python3', [join(scripts, 'privacy-gate.py'), '--identities', JSON.stringify(identities), '--scan', scan])
  return { dir, home, repo, scan, bin, env, word, names, calls, run, git, check }
}

test('export allowlist, identity scope, missing list and symlinks fail closed offline', { skip: !available }, t => {
  const f = fixture(t)
  for (const name of ['README.md', 'LICENSE', 'SECURITY.md']) write(join(f.repo, name), 'Public document\n')
  for (const name of ['app/main.swift', 'daemon/lib/config.mjs', 'daemon/package.json', 'daemon/package-lock.json']) write(join(f.repo, name), '{}\n')
  for (const name of ['research/private.txt', 'site/private.txt', 'video/private.txt', 'logs/private.txt', 'roadmap.json', 'app/icon/explorations/private.txt', 'scripts/local.env', 'daemon/node_modules/private.txt']) write(join(f.repo, name), f.word)
  f.git('init', '-q'); f.git('add', '--all')
  const run = () => f.run('bash', [join(f.repo, 'scripts/publish-source.sh'), '1.2.3', '--dry-run'])
  const clean = run()
  assert.equal(clean.status, 0, clean.stderr)
  const tree = clean.stdout.match(/Public tree: (.+)/)[1]
  assert.ok(existsSync(join(tree, 'app/main.swift')))
  for (const path of ['research', 'site', 'video', 'logs', 'roadmap.json', 'scripts/local.env', 'app/icon/explorations', 'daemon/node_modules']) assert.ok(!existsSync(join(tree, path)), path)
  write(join(f.repo, 'SECURITY.md'), `https://github.com/${identities.repository}\n`)
  write(join(f.repo, 'LICENSE'), identities.license)
  assert.equal(run().status, 0)
  write(join(f.repo, 'SECURITY.md'), `https://github.com/${identities.repository}-private\n`)
  assert.notEqual(run().status, 0)
  write(join(f.repo, 'SECURITY.md'), 'Public document')
  write(join(f.repo, 'README.md'), identities.license)
  assert.notEqual(run().status, 0, 'attribution must only be exempt in LICENSE')
  write(join(f.repo, 'README.md'), 'Public document')
  symlinkSync(f.home, join(f.repo, 'app/linked')); f.git('add', 'app/linked')
  assert.match(run().stderr, /app\/linked:1: symlink/)
  f.git('rm', '--cached', 'app/linked'); unlinkSync(join(f.repo, 'app/linked'))
  write(f.names, ''); assert.notEqual(run().status, 0)
  rmSync(f.names); assert.notEqual(run().status, 0)
  assert.ok(!existsSync(f.calls), 'dry run contacted a publishing or network tool')
})

test('repository identity is exempt only in the five exact approved paths', { skip: !available }, t => {
  const f = fixture(t)
  for (const [allowed, paths] of [
    [true, ['LICENSE', 'SECURITY.md', 'scripts/publish-source.sh', 'scripts/build-app.sh', 'scripts/package-app.sh']],
    [false, ['README.md', 'daemon/tests/fixture.mjs', 'app/sample.swift', 'nested/LICENSE', 'nested/SECURITY.md', 'nested/scripts/build-app.sh', 'scripts/release-app.sh', 'bundle/Contents/Info.plist', 'artifacts/appcast.xml']],
  ]) for (const path of paths) {
    const target = join(f.scan, path)
    write(target, `https://github.com/${identities.repository}\n`)
    assert.equal(f.check().status === 0, allowed, path)
    rmSync(target)
  }
})

// All rejected payloads are assembled only in temporary files, using synthetic values.
test('name normalization and bounded decoding reject every representation', { skip: !available }, async t => {
  const f = fixture(t), w = f.word, target = join(f.scan, 'fixture.txt')
  const accented = w.replace(/[aeiou]/g, c => ({ a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú' })[c])
  const cases = [
    ['case', w.toUpperCase()], ['accent', accented],
    ...['a', 'e', 'i', 'u', 'om', 'em', 'ov', 'in', 'ina', 'ić', 'ica', 'xyz'].map(s => ['suffix ' + s, w + s]),
    ['camel', 'read' + w[0].toUpperCase() + w.slice(1) + 'Settings'], ['snake', 'read_' + w + '_value'],
    ['kebab', 'read-' + w + '-value'], ['digits', 'read7' + w + '2value'], ['substring', 'before' + w + 'after'],
    ['base64', Buffer.from(w).toString('base64')], ['base64url', Buffer.from(w).toString('base64url')],
    ['base64url binary alphabet', Buffer.concat([Buffer.from([255, 255]), Buffer.from(w), Buffer.from([255])]).toString('base64url')],
    ['unpadded', Buffer.from(w).toString('base64').replace(/=+$/, '')], ['hex', Buffer.from(w).toString('hex')],
    ['percent', [...Buffer.from(w)].map(c => '%' + c.toString(16)).join('')],
    ['mixed percent', w.slice(0, 2) + [...Buffer.from(w.slice(2))].map(c => '%' + c.toString(16)).join('')],
    ['unicode', [...w].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('')],
    ['unicode braces', [...w].map(c => '\\u{' + c.charCodeAt(0).toString(16) + '}').join('')],
    ['mixed unicode', w.slice(0, 2) + [...w.slice(2)].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('')],
    ['nested', Buffer.from(Buffer.from(w).toString('hex')).toString('base64')],
    ['decoded binary strings', Buffer.concat([Buffer.from([0, 255]), Buffer.from(w), Buffer.from([0, 255])]).toString('base64')],
    ['long bounded run', Buffer.from(' '.repeat(17000) + w + ' '.repeat(17000)).toString('base64')],
  ]
  for (const [label, value] of cases) await t.test(label, () => {
    write(target, value)
    const result = f.check()
    assert.notEqual(result.status, 0, label)
    assert.match(result.stderr, /names list line 1/)
    assert.ok(!result.stderr.toLowerCase().includes(w), 'diagnostic printed the private word')
  })
  await t.test('short names require whole words after identifier splitting', () => {
    const short = 'q' + 'xzvjk'[randomBytes(1)[0] % 5] + 'z'; write(f.names, short)
    const title = short[0].toUpperCase() + short.slice(1)
    for (const value of ['get' + title + 'Value', short + '_1', Buffer.from(short).toString('base64'), Buffer.from(short).toString('hex')]) {
      write(target, value); assert.notEqual(f.check().status, 0)
    }
    for (const suffix of ['u', 'om', 'em', 'i', 'e', 'a', 'ov', 'in', 'ova', 'ina', 'ovi', 'ine', 'ić', 'ima', 'ama']) {
      for (const value of [short + suffix, (short + suffix).toUpperCase(), short + suffix.replace('i', 'í')]) {
        write(target, value); assert.notEqual(f.check().status, 0)
      }
    }
    for (const value of ['ac' + short + 'longer', short + 'xyz', short + 'omxx', 'xx' + short + 'om']) {
      write(target, value); assert.equal(f.check().status, 0)
    }
  })
  await t.test('oversized escaped runs fail closed', () => {
    for (const escaped of ['%61', '\\u0061']) {
      write(target, escaped.repeat(17000))
      assert.notEqual(f.check().status, 0)
    }
  })
})

test('synthetic Croatian stem changes are case and accent insensitive whole words', { skip: !available }, async t => {
  const f = fixture(t), root = privateWord(), target = join(f.scan, 'fixture.txt')
  const cases = [
    ...['a', 'e', 'i', 'o', 'u'].map(v => [root + v, root + 'om']),
    ...['c', 'k', 'r', 'l', 'n'].map(c => [root + 'a' + c, root + c + 'om']),
    [root + 'ao', root + 'lom'],
    ...Object.entries({ k: 'c', g: 'z', h: 's' }).flatMap(([from, to]) =>
      ['i', 'e', 'ima'].flatMap(ending => [[root + from, root + to + ending], [root + 'a' + from, root + to + ending]].filter((_, i) => i === 0 || from === 'k'))),
  ]
  for (const [index, [name, inflected]] of cases.entries()) await t.test(`generated form ${index}`, () => {
    write(f.names, name)
    for (const value of [inflected, inflected.toUpperCase(), inflected.replace(/a/g, 'á')]) {
      write(target, value); assert.notEqual(f.check().status, 0)
    }
    if (!inflected.includes(name)) { write(target, 'xx' + inflected + 'xxxx'); assert.equal(f.check().status, 0) }
  })
})

test('stem rules avoid non-case vowel changes and palatalising i-final names', { skip: !available }, t => {
  const f = fixture(t), root = privateWord(), target = join(f.scan, 'fixture.txt')
  for (const [name, ordinary] of [[root + 'a', root + 'o'], [root + 'ki', root + 'ci']]) {
    write(f.names, name); write(target, ordinary); assert.equal(f.check().status, 0)
  }
})

test('base64 split at arbitrary line and string boundaries cannot hide a synthetic name', { skip: !available }, t => {
  const f = fixture(t), target = join(f.scan, 'fixture.txt'), encoded = Buffer.from(f.word).toString('base64')
  for (const width of [1, 3, 5, 8]) {
    const parts = encoded.match(new RegExp(`.{1,${width}}`, 'g'))
    for (const value of [parts.join('\n'), parts.join('\r\n'), parts.map(p => `"${p}"`).join(' +\n'), parts.map(p => `'${p}'`).join('\n'), parts.map(p => `"${p}"`).join('+')]) {
      write(target, value); assert.notEqual(f.check().status, 0, `segment width ${width}`)
    }
  }
})

test('credentials and personal identifiers fail before publication', { skip: !available }, async t => {
  const f = fixture(t), secret = randomBytes(36).toString('hex')
  const cases = [
    ['private key', ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')],
    ...['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'].map(p => ['GitHub ' + p, p + secret]),
    ...['sk-', 'sk-proj-', 'sk-ant-api03-'].map(p => ['AI ' + p, p + secret]),
    ['AWS', 'AKIA' + 'A'.repeat(16)], ['AWS session', 'ASIA' + 'B'.repeat(16)],
    ...['sk_live_', 'sk_test_', 'rk_live_', 'pk_live_'].map(p => ['Stripe ' + p, p + secret]),
    ...['xoxb-', 'xoxp-', 'xoxa-', 'xoxr-', 'xoxs-'].map(p => ['Slack ' + p, p + secret]),
    ['generic JSON', JSON.stringify({ apiKey: secret })], ['generic env', 'SERVICE_TOKEN=' + secret],
    ['multiline JSON', '{"apiKey":\n"' + secret + '"}'],
    ['password', 'password="' + secret + '"'], ['Sparkle EdDSA', 'SPARKLE_PRIVATE_KEY=' + randomBytes(64).toString('base64')],
    ['email', 'nika@' + 'example.net'], ['email outside docs', 'nika@' + 'mail.example'],
    ['phone international', '+' + ['999', '91', '111', '2222'].join(' ')], ['phone spaced', ['202', '555', '0142'].join(' ')],
    ['phone dotted international', '+' + ['999', '9'.repeat(9)].join('.')],
    ['phone parentheses', '(' + ['202', ') 555-', '0142'].join('')],
    ['Mac home', ['', 'Users', 'fixture', 'file'].join('/')], ['Linux home', ['', 'home', 'fixture', 'file'].join('/')],
    ['home root', ['', 'Users', ''].join('/')],
    ['Windows home', ['C:', 'Users', 'fixture', 'file'].join('\\')],
    ['IBAN', 'HR' + '0'.repeat(19)], ['IBAN spaced', 'DE' + ['00', '1234', '1234', '1234', '1234', '12'].join(' ')],
    ['Apple team', 'DEVELOPMENT_TEAM = ' + 'A1'.repeat(5)],
    ['Apple plist', '<key>TeamIdentifier</key>\n<string>' + 'A1'.repeat(5) + '</string>'],
    ['secret plist', '<key>apiKey</key>\n<string>' + secret + '</string>'],
  ]
  for (const [label, value] of cases) await t.test(label, () => {
    write(join(f.scan, 'fixture.txt'), value)
    const result = f.check()
    assert.notEqual(result.status, 0, label)
    assert.ok(!result.stderr.includes(value), 'diagnostic echoed a secret')
  })
  await t.test('documentation domains and code numbers are accepted', () => {
    write(join(f.scan, 'fixture.txt'), ['nika@example.com', 'tea@example.org', 'sam@fixture.test', 'priya@fixture.invalid', 'noreply@github.com', '127.0.0.1', '2028-02-03', '0.123456789'].join('\n'))
    assert.equal(f.check().status, 0)
  })
})

function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data = Buffer.alloc(0)) {
  const kind = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4)
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([kind, data])))
  return Buffer.concat([length, kind, data, crc])
}
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const header = chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]))
const pixels = chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255])))
const png = (...extra) => Buffer.concat([signature, header, ...extra, pixels, chunk('IEND')])

test('binary strings, PNG structure, metadata and unknown types fail closed', { skip: !available }, async t => {
  const f = fixture(t), target = join(f.scan, 'fixture.png')
  const cases = [
    ...['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tRNS', 'aaaa'].map(k => [k, png(chunk(k, Buffer.from(f.word)))]),
    ['trailing data', Buffer.concat([png(), Buffer.from(f.word)])],
    ['truncated', png().subarray(0, -2)], ['missing IEND', png().subarray(0, -12)],
    ['missing IHDR', Buffer.concat([signature, pixels, chunk('IEND')])],
    ['duplicate IHDR', png(header)], ['invalid IDAT stream', Buffer.concat([signature, header, chunk('IDAT', Buffer.from('not compressed')), chunk('IEND')])],
    ['missing IDAT', Buffer.concat([signature, header, chunk('IEND')])],
    ['bad CRC', Buffer.concat([png().subarray(0, -1), Buffer.from([1])])],
    ['oversize chunk', Buffer.concat([signature, Buffer.from([255, 255, 255, 255]), Buffer.from('IHDR')])],
    ['ASCII in allowed chunk', png(chunk('iCCP', Buffer.concat([Buffer.from(f.word + '\0\0'), deflateSync(Buffer.from('sample profile'))])))],
    ['compressed profile text', png(chunk('iCCP', Buffer.concat([Buffer.from('profile\0\0'), deflateSync(Buffer.from(f.word))])))],
    ['accented UTF16 profile', png(chunk('iCCP', Buffer.concat([Buffer.from('profile\0\0'), deflateSync(Buffer.from(f.word.replace('a', 'á'), 'utf16le'))])))],
    ['UTF16 binary', Buffer.concat([Buffer.from([0, 255]), Buffer.from(f.word, 'utf16le')])],
    ['unknown type', Buffer.from([0, 255, 1, 255])], ['renamed executable', Buffer.concat([Buffer.from([207, 250, 237, 254]), Buffer.from(f.word)])],
  ]
  for (const [label, data] of cases) await t.test(label, () => { write(target, data); assert.notEqual(f.check().status, 0, label) })
  await t.test('minimal valid PNG accepted', () => { write(target, png()); assert.equal(f.check().status, 0) })
})

test('valid PNG image bytes receive the full-file strings scan', { skip: !available }, t => {
  const f = fixture(t), target = join(f.scan, 'fixture.png')
  const dimensions = Buffer.alloc(13)
  dimensions.writeUInt32BE(f.word.length + 2, 0)
  dimensions.writeUInt32BE(1, 4)
  dimensions[8] = 8 // One grayscale row, with no metadata.
  const row = Buffer.concat([Buffer.from([0, 0]), Buffer.from(f.word), Buffer.from([0])])
  const data = Buffer.concat([signature, chunk('IHDR', dimensions), chunk('IDAT', deflateSync(row, { level: 0 })), chunk('IEND')])
  assert.ok(data.includes(Buffer.from(f.word)))
  write(target, data)
  const result = f.check()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /names list line 1/)
  assert.doesNotMatch(result.stderr, /invalid binary structure/)
  assert.ok(!result.stderr.includes(f.word))
})

test('PNG export strips metadata losslessly and the gate rejects metadata that remains', { skip: !available }, t => {
  const f = fixture(t), short = 'q' + 'xzvjk'[randomBytes(1)[0] % 5] + 'z'
  write(f.names, short)
  for (const name of ['README.md', 'LICENSE', 'SECURITY.md']) write(join(f.repo, name), 'Public document')
  const metadata = [
    chunk('iCCP', Buffer.concat([Buffer.from('profile\0\0'), deflateSync(Buffer.from(short))])),
    chunk('zTXt', Buffer.concat([Buffer.from('note\0\0'), deflateSync(Buffer.from(short))])),
    chunk('iTXt', Buffer.concat([Buffer.from('note\0\x01\0\0\0'), deflateSync(Buffer.from(short))])),
    chunk('tEXt', Buffer.from('note\0' + short)), chunk('eXIf', Buffer.from(short)),
  ]
  for (const [index, part] of metadata.entries()) {
    write(join(f.scan, 'fixture.png'), png(part))
    assert.notEqual(f.check().status, 0, 'remaining metadata must be rejected')
    write(join(f.repo, `app/fixture-${index}.png`), png(part))
  }
  f.git('init', '-q'); f.git('add', '--all')
  const result = f.run('bash', [join(f.repo, 'scripts/publish-source.sh'), '1.2.3', '--dry-run'])
  assert.equal(result.status, 0, result.stderr)
  const tree = result.stdout.match(/Public tree: (.+)/)[1]
  for (const index of metadata.keys()) assert.deepEqual(readFileSync(join(tree, `app/fixture-${index}.png`)), png())
})

function releaseFixture(t) {
  const f = fixture(t)
  for (const name of ['README.md', 'LICENSE', 'SECURITY.md']) write(join(f.repo, name), 'Public document')
  const plist = '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>1.2.3</string><key>CFBundleVersion</key><string>7</string><key>LSMinimumSystemVersion</key><string>14.0</string></dict></plist>'
  write(join(f.repo, 'app/Info.plist'), plist)
  write(join(f.repo, 'app/main.swift'), '// Sample app\n')
  write(join(f.repo, 'app/changelog.json'), JSON.stringify([{ version: '1.2.3', title: 'Sample update', notes: ['Sample change'] }]))
  write(join(f.repo, 'daemon/lib/sample.mjs'), 'export const sample = true')
  write(join(f.repo, 'dist/Kier.app/Contents/Info.plist'), plist)
  write(join(f.repo, 'dist/Kier.app/Contents/Resources/daemon/lib/sample.mjs'), 'export const sample = true')
  write(join(f.repo, 'dist/Kier.app/Contents/Resources/changelog.json'), readFileSync(join(f.repo, 'app/changelog.json')))
  for (const name of ['Kier.dmg', 'Kier-1.2.3.dmg']) write(join(f.repo, 'dist', name), 'fixture image')
  // The external macOS tools are replaced by deterministic local doubles. No upload or mount occurs.
  write(join(f.repo, 'scripts/sparkle.sh'), '#!/bin/sh\nprintf "%s\\n" "$FAKE_SPARKLE"\n')
  execFileSync('chmod', ['+x', join(f.repo, 'scripts/sparkle.sh'), join(f.repo, 'scripts/publish-source.sh')])
  const sparkle = join(f.dir, 'sparkle')
  write(join(sparkle, 'bin/sign_update'), '#!/bin/sh\nprintf \'sparkle:edSignature="%s" length="13"\\n\' "${CAST_VALUE:-sample}"\n')
  execFileSync('chmod', ['+x', join(sparkle, 'bin/sign_update')])
  writeFileSync(join(f.bin, 'hdiutil'), `#!/bin/bash
if [[ "$1" == attach ]]; then
  while (($#)); do
    if [[ "$1" == -mountpoint ]]; then shift; mountpoint="$1"; fi
    shift
  done
  if [[ "$FIXTURE_ROOT" == external-link ]]; then
    ln -s "$FIXTURE_APP" "$mountpoint/Kier.app"
  elif [[ "$FIXTURE_ROOT" == internal-link ]]; then
    ln -s Applications "$mountpoint/Kier.app"
  elif [[ "$FIXTURE_ROOT" == file ]]; then
    printf 'fixture' > "$mountpoint/Kier.app"
  else
    cp -R "$FIXTURE_APP" "$mountpoint/Kier.app"
    if [[ "$FIXTURE_ROOT" == mode ]]; then chmod 755 "$mountpoint/Kier.app"; fi
    if [[ "$FIXTURE_ROOT" == directory-mode ]]; then chmod 755 "$mountpoint/Kier.app/Contents"; fi
  fi
  ln -s /Applications "$mountpoint/Applications"
fi
`, { mode: 0o755 })
  writeFileSync(join(f.bin, 'gh'), `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
if [ "$2" = view ]; then exit 1; fi
`, { mode: 0o755 })
  f.env.FAKE_SPARKLE = sparkle
  f.env.FIXTURE_APP = join(f.repo, 'dist/Kier.app')
  f.git('init', '-q'); f.git('add', 'app', 'daemon', 'scripts', 'README.md', 'LICENSE', 'SECURITY.md')
  f.release = () => f.run('bash', [join(f.repo, 'scripts/release-app.sh'), '--skip-build'])
  return f
}

test('every release input fails before upload even when public publication is off', { skip: !available }, async t => {
  for (const kind of ['source', 'notes', 'changelog', 'appcast', 'bundle JS', 'bundle JSON', 'bundle HTML', 'bundle plist', 'Info.plist', 'missing artifact', 'mismatched image']) {
    await t.test(kind, t => {
      const f = releaseFixture(t)
      const resource = 'dist/Kier.app/Contents/Resources/'
      if (kind === 'source') write(join(f.repo, 'app/main.swift'), f.word)
      if (kind === 'notes') f.env.KIER_RELEASE_NOTES = f.word
      if (kind === 'changelog') write(join(f.repo, 'app/changelog.json'), JSON.stringify([{ version: '1.2.3', title: f.word, notes: [] }]))
      if (kind === 'appcast') f.env.CAST_VALUE = f.word
      if (kind === 'bundle JS') write(join(f.repo, resource, 'daemon/lib/sample.mjs'), f.word)
      if (kind === 'bundle JSON') write(join(f.repo, resource, 'sample.json'), JSON.stringify({ sample: f.word }))
      if (kind === 'bundle HTML') write(join(f.repo, resource, 'sample.html'), '<p>' + f.word + '</p>')
      if (kind === 'bundle plist') write(join(f.repo, resource, 'sample.plist'), '<plist><string>' + f.word + '</string></plist>')
      if (kind === 'Info.plist') {
        const path = join(f.repo, 'dist/Kier.app/Contents/Info.plist')
        write(path, readFileSync(path, 'utf8').replace('</dict>', '<key>Sample</key><string>' + f.word + '</string></dict>'))
      }
      if (kind === 'missing artifact') rmSync(join(f.repo, 'dist/Kier-1.2.3.dmg'))
      if (kind === 'mismatched image') write(join(f.repo, 'dist/Kier-1.2.3.dmg'), 'different')
      const result = f.release()
      assert.notEqual(result.status, 0, kind)
      assert.ok(!existsSync(f.calls), 'an upload tool ran before validation')
      assert.ok(!(result.stderr + result.stdout).includes(f.word), 'release printed private input')
    })
  }
})

test('mounted app roots must be real directories with matching filesystem identity', { skip: !available }, async t => {
  for (const kind of ['external-link', 'internal-link', 'file', 'mode', 'directory-mode']) {
    await t.test(kind, t => {
      const f = releaseFixture(t)
      f.env.FIXTURE_ROOT = kind
      // Explicit baseline mode makes the comparison independent of the test runner's umask.
      execFileSync('chmod', ['700', f.env.FIXTURE_APP, join(f.env.FIXTURE_APP, 'Contents')])
      const result = f.release()
      assert.notEqual(result.status, 0)
      assert.ok(!existsSync(f.calls), 'invalid mounted root reached an upload tool')
    })
  }
})

test('release attaches only the frozen explicit list and detects subsequent tampering', { skip: !available }, t => {
  const f = releaseFixture(t)
  write(join(f.repo, 'dist/unreviewed.txt'), f.word)
  const result = f.release()
  assert.equal(result.status, 0, result.stderr)
  const prepared = result.stdout.match(/Validated release: (.+)/)[1]
  const calls = readFileSync(f.calls, 'utf8')
  assert.match(calls, /release create/)
  for (const name of ['Kier.dmg', 'Kier-1.2.3.dmg', 'appcast.xml', 'release-notes.md']) assert.ok(calls.includes(join(prepared, 'artifacts', name)))
  assert.ok(!calls.includes('unreviewed.txt'))
  assert.ok(!calls.includes(join(f.repo, 'dist')))
  assert.ok(!calls.includes('repo clone'), 'off still published public source')
  rmSync(f.calls)
  write(join(prepared, 'artifacts/release-notes.md'), f.word)
  const altered = f.run('bash', [join(f.repo, 'scripts/publish-source.sh'), '1.2.3', '--validated', prepared])
  assert.notEqual(altered.status, 0)
  assert.ok(!existsSync(f.calls), 'tampered artifacts reached an upload tool')
  const manifestPath = join(prepared, 'validation.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.files['artifacts/release-notes.md'].sha256 = createHash('sha256').update(f.word).digest('hex')
  write(manifestPath, JSON.stringify(manifest))
  assert.notEqual(f.run('bash', [join(f.repo, 'scripts/publish-source.sh'), '1.2.3', '--validated', prepared]).status, 0)
  assert.ok(!existsSync(f.calls), 'a rewritten manifest bypassed the privacy scan')
})
