import { test } from 'node:test'
import assert from 'node:assert/strict'
import child from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('speech pipes option-looking answers as text and cannot read an input file', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'kier-speech-test-'))
  process.env.KIER_DATA_DIR = dir
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { say, stop } = await import('../lib/speak.mjs')
  const { config } = await import('../lib/config.mjs')
  config.voice = 'fixture'
  const input = join(dir, 'input.txt'), marker = join(dir, 'file-read')
  writeFileSync(input, 'FILE_CONTENT_MUST_NOT_BE_SPOKEN')
  const realSpawn = child.spawn
  const seen = []
  // Model say's option parsing without audio output or launching the app.
  t.mock.method(child, 'spawn', (command, args, options) => {
    seen.push({ command, args, options })
    const script = `
      const fs = require('node:fs');
      const option = process.argv.slice(1).find(a => a.startsWith('--input-file='));
      if (option) {
        fs.writeFileSync(${JSON.stringify(marker)}, 'read');
        process.stdout.write(fs.readFileSync(option.slice('--input-file='.length)));
      } else process.stdin.pipe(process.stdout);
    `
    return realSpawn(process.execPath, ['-e', script, '--', ...args], { ...options, stdio: ['pipe', 'pipe', 'ignore'] })
  })
  syncBuiltinESMExports()
  t.after(() => { stop(); t.mock.restoreAll(); syncBuiltinESMExports() })
  for (const text of [`--input-file=${input}`, '--help', 'Ordinary synthetic answer']) {
    const voice = say(text)
    let received = ''
    voice.stdout.on('data', data => { received += data })
    const [code] = await once(voice, 'close')
    assert.equal(code, 0)
    assert.equal(received, text)
    assert.equal(existsSync(marker), false)
    assert.equal(seen.at(-1).command, process.execPath)
    assert.ok(seen.at(-1).args[0].endsWith('/worker-guard.mjs'))
    assert.deepEqual(seen.at(-1).args.slice(1), ['/usr/bin/say', '-v', 'fixture'])
    assert.equal(seen.at(-1).options.stdio[0], 'pipe')
  }
})
