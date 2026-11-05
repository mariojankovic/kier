import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-context-'))
after(() => rmSync(process.env.KIER_DATA_DIR, { recursive: true, force: true }))
const { contextFor } = await import('../lib/tagger.mjs')

// Invented subjects, so the old paste is plainly unrelated to the new request.
const paste = 'The warehouse migration needs a new backup server. '.repeat(6).trim()
const request = 'BTW, can you add the missing icons?'
const detail = 'We need the small sizes too.'
const reply = 'I am drawing them.'

function chat(t, texts, source = 'whatsapp') {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec('create table items (id text, source text, thread text, sender text, from_me int, ts int, text text)')
  const add = db.prepare('insert into items values (?, ?, ?, ?, ?, ?, ?)')
  texts.forEach((text, i) => add.run(String(i), source, 'Nika', 'Nika', 0, 1_800_000_000 + i * 60, text))
  const item = { id: 'reply', source, thread: 'Nika', sender: source === 'notifications' ? 'Nika' : 'Me', from_me: 1, ts: 1_800_000_000 + texts.length * 60, text: reply }
  return (limit) => contextFor(db, item, limit)
}

test('a new chat subject excludes an older paste both inside and beyond the normal window', (t) => {
  for (const source of ['whatsapp', 'imessage', 'discord', 'chat', 'social']) {
    const context = chat(t, [paste, 'I will handle the server.', request, detail], source)
    for (const limit of [2, 8]) {
      assert.deepEqual(context(limit).map((c) => c.text), [request, detail], `${source}, limit ${limit}`)
    }
  }
})

test('the latest subject change keeps its request and following details', (t) => {
  const last = '  By the way: can you draw a loading spinner?'
  const context = chat(t, [paste, request, detail, last, 'Use three dots.'])
  assert.deepEqual(context(8).map((c) => c.text), [last, 'Use three dots.'])
})

test('an older paste still explains a short reply when the subject has not changed', (t) => {
  const lines = ['The backup job failed again.', 'Can you check it?']
  const context = chat(t, [paste, ...lines])
  const rows = context(2)
  assert.deepEqual(rows.map((c) => c.text), [paste, ...lines])
  assert.equal(rows[0].long, true)
})

test('a marker must begin the message and be a whole phrase', (t) => {
  for (const line of ['btwhelper needs a new logo.', 'I said BTW in the notes.', 'By the wayside is the title.']) {
    const context = chat(t, [paste, line, 'Can you check it?'])
    assert.equal(context(2)[0].text, paste, line)
  }
})

test('mail and notifications keep their normal context', (t) => {
  for (const source of ['mail', 'notifications']) {
    const context = chat(t, [paste, request, detail], source)
    assert.deepEqual(context(8).map((c) => c.text), [paste, request, detail])
  }
})
