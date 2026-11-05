import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')

test('public package metadata agrees on the Kier name and executable', () => {
  const manifest = JSON.parse(read('../package.json'))
  const lock = JSON.parse(read('../package-lock.json'))
  assert.equal(lock.name, manifest.name)
  assert.equal(lock.packages[''].name, manifest.name)
  assert.deepEqual(lock.packages[''].bin, manifest.bin)
})

test('startup uses current storage and preferences without legacy migration', () => {
  const config = read('../lib/config.mjs')
  assert.match(config, /resolve\(home,\s*["']Library\/Application Support\/Kier["']\)/)
  assert.doesNotMatch(config, /renameSync|const legacy/)
  assert.doesNotMatch(read('../../app/main.swift'), /persistentDomain\(forName:/)
  const notifications = read('../collectors/notifications.mjs')
  assert.ok(notifications.includes('/^Kier$/.test(title)'))
})
