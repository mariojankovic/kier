import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-stalled-'))
const { open, addItems, now } = await import('../lib/db.mjs')
const { checkStalled } = await import('../lib/stalled.mjs')

// A real repo, outside the temporary folders the check leaves alone on purpose.
const repo = join(homedir(), 'Library/Caches', `kier-stalled-test-${process.pid}`)
mkdirSync(repo, { recursive: true })
after(() => rmSync(repo, { recursive: true, force: true }))
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' })
// The first commit is from long before any of this, as a real repo's would be.
const old = `@${Math.floor(Date.now() / 1000) - 36_000} +0000`
const gitThen = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old } })
const file = join(repo, 'Workshop.md')
git('init', '-q')
git('config', 'user.email', 'test@example.com')
git('config', 'user.name', 'Test')
writeFileSync(file, 'one\n')
git('add', '.')
gitThen('commit', '-qm', 'first')

const db = open(join(process.env.KIER_DATA_DIR, 'kier.db'))
// A session you talked to, quiet for hours, that edited the file and left it uncommitted.
const session = (id, title, at) => addItems(db, [{ id: `ai:${id}`, source: 'ai', thread: title, sender: 'Claude', fromMe: false, ts: at,
  text: title, meta: { kind: 'session', session: id, cwd: repo, edits: [file], human: true, at } }])
const cards = () => db.prepare(`select i.id, s.status from items i join tags t on t.item_id = i.id left join task_state s on s.item_id = i.id
  where t.card = 'stalled' order by i.ts`).all()

test('a file left uncommitted gets one card, and closing it holds when another session touches the same file', async () => {
  writeFileSync(file, 'two\n')
  session('s1', 'Workshop inventory', now() - 5 * 3600)
  await checkStalled(db)
  assert.equal(cards().length, 1)
  db.prepare("insert into task_state (item_id, status, changed_at, reason) values (?, 'done', ?, 'marked in the timeline')").run(cards()[0].id, now() - 4 * 3600)
  session('s2', 'Gallery catalogue', now() - 4 * 3600 + 60)
  await checkStalled(db)
  assert.equal(cards().length, 1, 'the same uncommitted file came back as a new card')
})

test('once it was committed, the next edit left behind is a new card', async () => {
  git('commit', '-qam', 'second')
  writeFileSync(file, 'three\n')
  session('s3', 'Later work', now() - 3.5 * 3600)
  await checkStalled(db)
  assert.equal(cards().filter((c) => !c.status).length, 1)
})


test('background status checks never execute a repository filesystem-monitor hook', async () => {
  const hook = join(repo, '.git', 'fixture-fsmonitor')
  const marker = join(repo, '.git', 'fixture-hook-ran')
  writeFileSync(hook, '#!/bin/sh\nprintf ran > .git/fixture-hook-ran\nprintf "token\\000"\n', { mode: 0o700 })
  git('config', 'core.fsmonitor', hook)
  session('s4', 'Check workshop inventory', now() - 3.25 * 3600)
  await checkStalled(db)
  assert.equal(existsSync(marker), false, 'repository hook ran during background collection')
})
