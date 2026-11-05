import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-sender-promise-'))
writeFileSync(join(process.env.KIER_DATA_DIR, 'config.json'), JSON.stringify({ me: 'Jonas', languages: ['Croatian', 'English'] }))
const { open, addItems, now } = await import('../lib/db.mjs')
const { senderPromise, quietSenderPromises, excludeSenderPromises, unaddressedGroup, excludeUnaddressedGroups, ownVerdict, tagPending } = await import('../lib/tagger.mjs')
const { brief, tasks } = await import('../lib/tasks.mjs')

const me = ['Jonas', 'jonas_notes']
const incoming = (text, extra = {}) => ({ source: 'discord', sender: 'Tea', from_me: 0, text, ...extra })

// Invented promises and requests, including the two word orders used in chats.
const { modelFixture } = await import('./model-fixture.mjs')
await modelFixture({ decision: true })

test('a sender can commit in English, Croatian, or kajkavian', () => {
  for (const text of [
    "I'll fix the parser tonight.",
    'I’ll write the migration tomorrow.',
    'I will prepare the guide.',
    'I have to rewrite the parser.',
    'I need to finish the guide.',
    'Let me fix the import first.',
    'Onda moram napisati upute.',
    'Moram to razviti do petka.',
    'ja ću popraviti izvoz sutra',
    'ja cu popravit izvoz sutra',
    'Sredit ću prikaz.',
    'sredit cu prikaz',
    'bum sredil izvoz',
    'budem napravil pregled',
  ]) assert.equal(senderPromise(incoming(text), me), true, text)
})

test('the owner, reminders, and other untagged sources never lose a promise', () => {
  const text = "I'll fix the parser tonight."
  assert.equal(senderPromise(incoming(text, { from_me: 1 }), me), false)
  for (const source of ['reminders', 'calendar', 'ai', 'git']) {
    assert.equal(senderPromise(incoming(text, { source }), me), false, source)
  }
})

test('requests and questions anywhere in the message preserve the owner task', () => {
  for (const text of [
    "I'll fix the form. Send me the sample.",
    "I'll fix the form. Send the logs.",
    "Please send the fixture. I'll fix the parser tonight.",
    "I'll fix the form, can you check the result?",
    'I need you to fix the importer.',
    'Let me know when the package is ready.',
    "I'll fix the parser, ping me when the sample arrives.",
    'Ja cu srediti server, ti provjeri boje.',
    'Moram napisati upute, molim potvrdu opsega.',
    'Sredit cu prikaz, posalji mi sliku.',
    'Moram popraviti prikaz, javi mi kad stigne slika.',
    'Moram znati koji termin odgovara.',
    'to moram',
    'Moram poslije rucka.',
    'Moram sredinom tjedna.',
    'Can I fix this?',
    'Moram napisati upute?',
  ]) assert.equal(senderPromise(incoming(text), me), false, text)
})

test('owner names, handles, shared plans, and reported words remain for the model', () => {
  for (const text of [
    "Jonas, I'll fix the parser.",
    '@jonas_notes moram napisati upute.',
    "I'll call you at 2.",
    'Moram pomaknuti nas sastanak.',
    "I'll prepare our meeting.",
    'Rekao je: moram napisati upute.',
    "Tea wrote: I'll fix the layout.",
    '"Moram napisati upute"',
    '> I have to rewrite the parser.',
    "I'll fix your parser.",
    'Moram popraviti tvoj prikaz.',
  ]) assert.equal(senderPromise(incoming(text), me), false, text)
})

test('a notification sender header is not quoted speech, but quotes in its body are', () => {
  const sender = 'Tea ("UI notes", dev)'
  assert.equal(senderPromise(incoming(`${sender}: I'll fix the parser.`, { source: 'notifications', sender }), me), true)
  assert.equal(senderPromise(incoming(`\u2068${sender}\u2069: I'll fix the parser.`, { source: 'notifications', sender }), me), true)
  assert.equal(senderPromise(incoming(`${sender}: "I have to rewrite the parser"`, { source: 'notifications', sender }), me), false)
})

test('the once-only pass reads saved bursts and preserves user choices and tag details', (t) => {
  const db = open(join(process.env.KIER_DATA_DIR, 'backfill.db'))
  t.after(() => db.close())
  const at = now()
  const rows = [
    { id: 'promise', ts: at - 300 },
    { id: 'burst', text: 'The export drops empty columns.', said: "The export drops empty columns.\nI'll fix the export." },
    { id: 'mixed', said: "Please send the fixture.\nI'll fix the parser." },
    { id: 'mine', fromMe: true },
    { id: 'confirmed', confirmed: 1 },
    { id: 'done', status: 'done' },
    { id: 'dismissed', status: 'dismissed' },
    { id: 'reopened', status: 'open' },
    { id: 'snoozed', status: 'snoozed' },
    { id: 'quiet', quiet: 1 },
    { id: 'old', ts: at - 31 * 86400 },
    { id: 'reminder', source: 'reminders' },
    { id: 'not-task', is_task: 0 },
  ]
  addItems(db, rows.map((r) => ({ source: 'discord', sender: 'Tea', thread: r.id, text: "I'll fix the parser.", ts: at - 600, ...r })))
  const save = db.prepare(`insert into tags (item_id, is_task, summary, card, model, tagged_at, second, said, quiet, confirmed)
    values (?, ?, ?, 'todo', 'test', ?, 0.93, ?, ?, ?)`)
  for (const r of rows) {
    save.run(r.id, r.is_task ?? 1, `Fix ${r.id} in the parser`, at, r.said ?? null, r.quiet ?? null, r.confirmed ?? null)
    if (r.status) db.prepare("insert into task_state (item_id, status, changed_at, reason) values (?, ?, ?, 'marked in the timeline')").run(r.id, r.status, at)
  }
  const before = db.prepare('select * from tags order by item_id').all().map((r) => ({ ...r }))
  const states = db.prepare('select * from task_state order by item_id').all()
  assert.equal(quietSenderPromises(db), 2)
  const after = db.prepare('select * from tags order by item_id').all().map((r) => ({ ...r }))
  assert.deepEqual(after, before.map((r) => ['promise', 'burst'].includes(r.item_id) ? { ...r, quiet: 1 } : r))
  assert.deepEqual(db.prepare('select * from task_state order by item_id').all(), states)
  assert.equal(quietSenderPromises(db), 0)
  assert.equal(tasks(db).find((c) => c.id === 'promise').maybe, true)
  assert.ok(brief(db).maybe.some((c) => c.id === 'promise'))
  db.prepare("update tags set confirmed = 1 where item_id = 'promise'").run()
  assert.equal(tasks(db).find((c) => c.id === 'promise').maybe, false)
  assert.ok(brief(db).open.some((c) => c.id === 'promise'))
  assert.equal(quietSenderPromises(db), 0)
})

test('fresh tagging checks the whole burst after a confident model verdict', async (t) => {
  const db = open(join(process.env.KIER_DATA_DIR, 'fresh.db'))
  t.after(() => db.close())
  const at = now()
  addItems(db, [
    { id: 'own-start', source: 'discord', sender: 'Tea', thread: 'Importer', ts: at - 900, text: 'The parser drops empty keys.' },
    { id: 'own-end', source: 'discord', sender: 'Tea', thread: 'Importer', ts: at - 880, text: "I'll fix the parser tonight." },
    { id: 'ask-start', source: 'discord', sender: 'Tea', thread: 'Fixture', ts: at - 700, text: 'Please send the fixture.' },
    { id: 'ask-end', source: 'discord', sender: 'Tea', thread: 'Fixture', ts: at - 680, text: "I'll fix the parser tonight." },
  ])
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname
    if (path === '/api/version' || path === '/health') return { ok: true }
    if (path === '/api/chat') return { ok: true, json: async () => ({ message: { content: JSON.stringify({ is_task: true, summary: 'Fix the parser', when: '', due: '', amount: '', urgency: 1 }) } }) }
    const body = JSON.parse(options.body)
    if (path === '/decide') return { ok: true, json: async () => ({ p_task: body.messages.map(() => 0.93) }) }
    if (path === '/ask') return { ok: true, json: async () => ({ answers: body.states.map(() => ({ card: { choice: 'todo' } })) }) }
    assert.fail(`unexpected fetch: ${url}`)
  })
  const result = await tagPending(db)
  assert.equal(result.tagged, 4)
  assert.equal(result.failed, 0)
  const tags = Object.fromEntries(db.prepare('select * from tags').all().map((r) => [r.item_id, r]))
  assert.equal(tags['own-start'].is_task, 0)
  assert.equal(tags['ask-start'].is_task, 0)
  assert.equal(tags['own-end'].is_task, 0)
  assert.equal(tags['ask-end'].quiet, null)
  assert.equal(tags['own-end'].model, 'sender-promise')
  assert.equal(tags['ask-end'].second, 0.93)
  assert.equal(tags['own-end'].said, "The parser drops empty keys.\nI'll fix the parser tonight.")
  assert.equal(tags['ask-end'].said, "Please send the fixture.\nI'll fix the parser tonight.")
  assert.equal(tasks(db).find((c) => c.id === 'own-end'), undefined)
  assert.equal(tasks(db).find((c) => c.id === 'ask-end').maybe, false)
})


test('short Croatian work promises belong to the sender, with outgoing promises preserved', () => {
  for (const text of ['rijesim', 'riješim', 'font rijesim', 'ja cu to', 'ja ću to', 'cu to ja', 'ok, ja cu to sutra', 'ovo dodajem']) {
    assert.equal(senderPromise(incoming(text), me), true, text)
    assert.equal(senderPromise(incoming(text, { from_me: 1 }), me), false, `owner: ${text}`)
    const sender = 'Tea (#sample, Text)'
    assert.equal(senderPromise(incoming(`${sender}: ${text}`, { source: 'notifications', sender }), me), true, `notification: ${text}`)
  }
  for (const text of ['rijesim?', 'ako rijesim, mozes provjeriti?', 'ja cu to, ti provjeri boje', 'ne rijesim', 'Tea kaze: ja cu to', '"rijesim"', 'Jonas, rijesim pa pogledaj']) {
    assert.equal(senderPromise(incoming(text), me), false, text)
  }
})


test('first-person telling is not an instruction to the owner', () => {
  for (const text of ['reci cu mu da spremi slagalicu', 'reći ću mu da spremi slagalicu', 'cu reci Filipu', 'Na stolu je ostala jedna puzzla.\n\nreci cu mu da spremi slagalicu']) {
    assert.equal(senderPromise(incoming(text), me), true, text)
    assert.equal(senderPromise(incoming(text, {from_me: 1}), me), false, text)
  }
  for (const text of ['reci mu da spremi slagalicu', 'reci cu mu, ti potrazi kutiju', 'reci cu mu, mozes ti provjeriti?']) assert.equal(senderPromise(incoming(text), me), false, text)
})

test('existing sender promises leave all task lists, preserving confirmed and marked cards', t => {
  const db = open(join(process.env.KIER_DATA_DIR, 'exclude.db'))
  t.after(() => db.close())
  for (const id of ['other', 'mine', 'claimed', 'marked', 'quiet']) {
    addItems(db, [{id, source:'discord', sender:'Tea', fromMe:id === 'mine', text:'reci cu mu da spremi slagalicu', ts:now()}])
    db.prepare("insert into tags (item_id,is_task,tagged_at,confirmed,quiet) values (?,1,?,?,?)").run(id,now(),id === 'claimed' ? 1 : null,id === 'quiet' ? 1 : null)
  }
  db.prepare("insert into task_state (item_id,status,changed_at) values ('marked','open',?)").run(now())
  assert.equal(excludeSenderPromises(db), 2)
  assert.equal(excludeSenderPromises(db), 0)
  assert.deepEqual(tasks(db).map(r=>r.id).sort(), ['claimed','marked','mine'])
  assert.equal(db.prepare('select count(*) n from items').get().n, 5)
})


test('outgoing ownership requires a grounded owner commitment; failed checks retry', () => {
  const text = 'Put it behind the switch. I will test it tomorrow.'
  assert.equal(ownVerdict({commits:true, actor:'owner', evidence:'I will test it tomorrow.'},text),true)
  assert.equal(ownVerdict({commits:true, actor:'recipient', evidence:'Put it behind the switch.'},text),false)
  assert.equal(ownVerdict({commits:false, actor:'recipient',who:'Jonas'},text),false)
  assert.equal(ownVerdict({commits:true,actor:'owner',evidence:'I will release it'},text),null)
  assert.equal(ownVerdict(null,text),null)
  assert.equal(ownVerdict({commits:true},text),null)
})


test('group questions require an address or owner participation, including same-minute replies', t => {
  const db = open(join(process.env.KIER_DATA_DIR, 'groups.db'))
  t.after(() => db.close())
  const at = now()
  addItems(db, [{id:'question',source:'discord',thread:'support',sender:'Tea',text:'Should I sort the puzzle pieces?',meta:{group:true},ts:at}])
  const item = db.prepare("select * from items where id='question'").get()
  assert.equal(unaddressedGroup(db,item,item,me),true)
  assert.equal(unaddressedGroup(db,{...item,text:'Jonas, can you review this?'},item,me),false)
  assert.equal(unaddressedGroup(db,{...item,text:'@jonas_notes can you review this?'},item,me),false)
  assert.equal(unaddressedGroup(db,{...item,from_me:1},item,me),false)
  assert.equal(unaddressedGroup(db,{...item,meta:'{}'},item,me),false)
  db.prepare("insert into tags(item_id,is_task,tagged_at) values ('question',1,?)").run(at)
  assert.equal(excludeUnaddressedGroups(db),1)
  assert.equal(tasks(db).length,0)
  addItems(db,[{id:'owner',source:'discord',thread:'support',sender:'Jonas',fromMe:true,text:'I can look at it',ts:at}, {id:'reply',source:'discord',thread:'support',sender:'Tea',text:'Can you check it?',meta:{group:true},ts:at}])
  const reply = db.prepare("select * from items where id='reply'").get()
  assert.equal(unaddressedGroup(db,reply,reply,me),false)
  // Later participation does not retroactively address the earlier question.
  assert.equal(unaddressedGroup(db,item,item,me),true)
})
