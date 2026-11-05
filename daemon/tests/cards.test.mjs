import { test } from 'node:test'
import assert from 'node:assert/strict'
import { speech } from '../lib/speak.mjs'
import { icsFor } from '../lib/tasks.mjs'

const task = { id: 'whatsapp:1', summary: 'Puzzle with Tea', text: 'Dodji slagati puzzle u 13:20?', sender: 'Tea', when_words: 'u 13:20', due: '2028-02-03' }

test('an appointment with a time becomes a one hour event in the owner\'s timezone', () => {
  const ics = icsFor(task)
  assert.match(ics, /DTSTART;TZID=[^:]+:20280203T132000/)
  assert.match(ics, /DTEND;TZID=[^:]+:20280203T142000/)
  assert.match(ics, /SUMMARY:Puzzle with Tea/)
})

test('an appointment without a time becomes an all day event, and commas are escaped', () => {
  const ics = icsFor({ ...task, when_words: 'sutra', summary: 'Meet Nika, Jonas' })
  assert.match(ics, /DTSTART;VALUE=DATE:20280203\r\nDTEND;VALUE=DATE:20280204/)
  assert.match(ics, /SUMMARY:Meet Nika\\, Jonas/)
})

test('calendar text normalizes CR and CRLF before escaping property separators', () => {
  for (const newline of ['\r', '\r\n', '\n']) {
    const payload = `Workshop${newline}ATTENDEE:mailto:sam@example.test${newline}END:VEVENT`
    const ics = icsFor({ ...task, summary: payload, text: payload, sender: `Nika${newline}BEGIN:VEVENT` })
    const rows = ics.split('\r\n')
    assert.equal(rows.filter(row => row === 'BEGIN:VEVENT').length, 1)
    assert.equal(rows.filter(row => row === 'END:VEVENT').length, 1)
    assert.ok(!rows.some(row => row.startsWith('ATTENDEE:')))
    assert.ok(!rows.some(row => /[\r\n]/.test(row)))
    assert.ok(ics.includes('SUMMARY:Workshop\\nATTENDEE:mailto:sam@example.test\\nEND:VEVENT'))
    assert.ok(ics.includes('DESCRIPTION:Nika\\nBEGIN:VEVENT: Workshop\\nATTENDEE:'))
  }
})

test('the spoken brief names what is due, what may be forgotten and how much more there is', () => {
  const b = {
    today: { events: [{ allDay: true, text: 'Free day' }], tasks: [{ summary: 'Pay 17 EUR for puzzle pieces' }] },
    forgotten: [{ summary: 'Call Jonas back' }], open: [{ summary: 'Send Lucija the diagram' }], more: { open: 2 },
  }
  const s = speech(b)
  assert.match(s, /On your calendar today: Free day\./)
  assert.match(s, /Due today: Pay 17 EUR for puzzle pieces\./)
  assert.match(s, /You may have forgotten: Call Jonas back\./)
  assert.match(s, /Plus 2 more in Kier\./)
})

test('an empty day is said plainly', () => {
  assert.match(speech({ today: { events: [], tasks: [] }, forgotten: [], open: [], more: {} }), /Nothing is waiting on you/)
})

test('small numbers are written out for the voice model, times and dates are left alone', async () => {
  const { spoken } = await import('../lib/speak.mjs')
  assert.equal(spoken('Plus 5 more in Kier.'), 'Plus five more in Kier.')
  assert.equal(spoken('Pay 40 EUR at 14:30 on 2026-10-29'), 'Pay forty EUR at 14:30 on 2026-10-29')
  assert.equal(spoken('Send 21 photos'), 'Send twenty-one photos')
})

test('Discord text read off the screen turns back into who said what', async () => {
  const { screenChat } = await import('../lib/resolve.mjs')
  const day = Math.floor(new Date(2028, 1, 3, 15).getTime() / 1000)
  const text = 'Priya 2:06 PM\n2:06 PM\nThursday, February 3, 2028 at 2:06 PM\nGdje stoji kutija za puzzle?\nSam 2:09 PM\nPitaj Jonasa, ja imam samo poklopac.\nJonas Server Tag: DEMO 2:09 PM\nKutija je na polici.\nSend GIF'
  const m = screenChat(text, day)
  assert.deepEqual(m.map((x) => [x.name, x.text]), [['Priya', 'Gdje stoji kutija za puzzle?'], ['Sam', 'Pitaj Jonasa, ja imam samo poklopac.'], ['Jonas', 'Kutija je na polici.']])
  assert.equal(new Date(m[1].ts * 1000).getHours(), 14)
})

test('a burst spans a line typed over it, and reactions stop at the next topic', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { burstOf } = await import('../lib/tagger.mjs')
  const db = new DatabaseSync(':memory:')
  db.exec('create table items (id text, source text, thread text, sender text, from_me int, ts int, text text)')
  const add = db.prepare('insert into items values (?, ?, ?, ?, ?, ?, ?)')
  const rows = [
    ['a', 'Me', 1, 0, 'the paper boats can wait until tomorrow'],
    ['b', 'Me', 1, 4, 'we still need the folding diagram'],
    ['c', 'Nika', 0, 13, 'well I am not happy with the paper either'],
    ['d', 'Me', 1, 13, 'let us finish that first'],
    ['e', 'Me', 1, 17, 'I will draw the folding diagram right now'],
    ['f', 'Nika', 0, 22, 'ok'],
    ['g', 'Nika', 0, 49, 'a different question about the sketchbook: can we crop the drawing?'],
    ['h', 'Nika', 0, 51, 'no border?'],
  ]
  for (const [id, sender, me, ts, text] of rows) add.run(id, 'whatsapp', 'Team', sender, me, 1000 + ts, text)
  const item = (id) => db.prepare('select * from items where id = ?').get(id)
  assert.equal(burstOf(db, item('b')).last, false)
  const burst = burstOf(db, item('e'))
  assert.equal(burst.last, true)
  assert.equal(burst.text.split('\n').length, 4)
  assert.ok(!burst.text.includes('happy'))
  assert.equal(burst.after.length, 1)
  assert.ok(!burst.after.join(' ').includes('crop'))
  // A quick answer to a reply is a conversation, not one burst.
  for (const [id, sender, me, ts, text] of [['x', 'Nika', 0, 200, 'tell me the size of the paper'], ['y', 'Me', 1, 220, 'A4 ok'], ['z', 'Nika', 0, 225, 'ok']]) {
    add.run(id, 'whatsapp', 'Team', sender, me, 1000 + ts, text)
  }
  assert.equal(burstOf(db, item('x')).last, true)
})

test('the island glance is short, most pressing first, and empty when nothing is', async () => {
  const { glance } = await import('../lib/tasks.mjs')
  const at = 1_800_000_000
  const b = (o) => ({ today: { events: [], tasks: [] }, forgotten: [], open: [], more: {}, ...o })
  const ev = (mins, text) => ({ today: { events: [{ ts: at + mins * 60, text }], tasks: [{}] } })
  assert.equal(glance(b(ev(10, 'Standup')), at), 'in 10 min')
  assert.match(glance(b(ev(40, 'Call with Filip')), at), /^\d\d:\d\d Call$/)
  assert.match(glance(b(ev(40, 'Standup with the team')), at), /^at \d\d:\d\d$/)
  assert.equal(glance(b({ forgotten: [{}], more: { forgotten: 2 }, today: { events: [], tasks: [{}] } }), at), '3 overdue')
  assert.equal(glance(b({ today: { events: [], tasks: [{}, {}] } }), at), '2 due today')
  assert.equal(glance(b({ open: [{ source: 'ai', sender: 'Codex', ts: at - 600 }] }), at), 'Codex asks')
  assert.equal(glance(b({ open: [{ source: 'whatsapp', card: 'reply', sender: '\u200eFilip Example', ts: at - 600 }] }), at), 'Reply Filip')
  assert.equal(glance(b({ open: [{ source: 'ai', sender: 'Codex', ts: at - 5 * 3600 }] }), at), null)
  for (const s of ['in 10 min', '3 overdue', '2 due today', 'Codex asks', 'Reply Filip']) assert.ok(s.length <= 11)
})

test('the glance names an event without its punctuation, and says what it is about for the hover card', async () => {
  const { glance, glanceOf } = await import('../lib/tasks.mjs')
  const at = 1_800_000_000
  const b = (o) => ({ today: { events: [], tasks: [] }, forgotten: [], open: [], more: {}, ...o })
  const sketchbox = b({ today: { events: [{ ts: at + 40 * 60, text: 'Paper: Monthly folding session' }], tasks: [] } })
  assert.match(glance(sketchbox, at), /^\d\d:\d\d Paper$/)
  const g = glanceOf(sketchbox, at)
  assert.equal(g.about, 'Paper: Monthly folding session')
  assert.match(g.line, /^Today at \d\d:\d\d, in 40 min$/)
  assert.equal(glanceOf(b({ forgotten: [{ summary: 'Pay for the sample puzzle' }] }), at).about, 'Pay for the sample puzzle')
  assert.equal(glanceOf(b({}), at), null)
})

test("a notification's conversation is its sender, or its Discord channel, not the whole app", async () => {
  const { sameConversation } = await import('../lib/tagger.mjs')
  const mail = sameConversation({ source: 'notifications', sender: 'Lucija Example' })
  assert.ok(mail({ sender: '‎Lucija Example' }))
  assert.ok(!mail({ sender: 'Tea' }))
  const discord = sameConversation({ source: 'notifications', sender: '⁨Priya⁩ (⁨#sample⁩, ⁨Text⁩)' })
  assert.ok(discord({ sender: 'Filip (#sample, Text)' }))
  assert.ok(!discord({ sender: 'Filip (#other-sample, Text)' }))
  assert.ok(sameConversation({ source: 'whatsapp', sender: 'Nika' })({ sender: 'Jonas' }))
})

test('only things you publish get a place to check, and only by a two word phrase', async () => {
  const { open } = await import('../lib/db.mjs')
  const { homes } = await import('../lib/places.mjs')
  const db = open(':memory:')
  const add = db.prepare('insert into items (id, source, ts, url, text) values (?, ?, ?, ?, ?)')
  add.run('a', 'browser', 900, 'https://example.com/feeds/release-notes/posts.json', 'feed')
  add.run('b', 'browser', 900, 'https://www.reddit.com/r/css/comments/1/right_side_layout_width/', 'Reddit')
  assert.equal(homes(db, 'Sam will write release notes for the gallery update', 1000)?.pages[0].url, 'https://example.com/feeds/release-notes/posts.json')
  assert.equal(homes(db, 'Investigate the right-side layout width issue', 1000), null)
  db.close()
})

test('a reply closes work only when it plainly says done; "evo" alone is left to the done-check', async () => {
  const { wordRegex } = await import('../lib/lang.mjs')
  const clear = wordRegex('done', ['evo'])
  for (const yes of ['platio sam', 'evo, uplatio', 'done!', 'paid it', 'poslano']) assert.ok(clear.test(yes), yes)
  for (const no of ['evo jesam', 'evo sad', 'ok može', 'pay it later']) assert.ok(!clear.test(no), no)
})

test('a message from outside a chat is read as it is (no burst), so tagging it never fails', async () => {
  const { burstOf, corrected } = await import('../lib/tagger.mjs')
  const b = burstOf(null, { source: 'notifications', text: 'Borna (#sample): @Sam' })
  assert.equal(b.last, true)
  assert.equal(b.read, 'Borna (#sample): @Sam')
  assert.deepEqual(corrected(['Papir je savijenx', 'savijen', 'za brodic']), ['Papir je savijen', 'za brodic'])
})

test('messages any chat app marks for screen readers become who said what, and when', async () => {
  const { marked, sentAt } = await import('../collectors/screenchats.mjs')
  const capture = Math.floor(new Date(2026, 9, 30, 10, 40).getTime() / 1000)
  const borna = { name: 'Borna , @Sam , 10:25 AM', heading: 'Borna 10:25 AM', when: ['10:25 AM', 'Friday, October 30, 2026 at 10:25 AM'], text: ['@Sam'] }
  assert.equal(new Date(sentAt(capture, borna) * 1000).getHours(), 10)
  assert.equal(new Date(sentAt(capture, borna) * 1000).getMinutes(), 25)
  // Grouped under the last heading, and the hover toolbar's words aren't the message.
  const next = { name: ', and see this , 10:26 AM', heading: '', when: ['10:26 AM'], text: ['and see this', 'Reply', ':heart:'] }
  const { out } = marked(capture, [borna, next], null)
  assert.deepEqual(out.map((m) => [m.sender, m.text]), [['Borna', '@Sam'], ['Borna', 'and see this']])
  // A plain 24-hour time from a native app, yesterday.
  const y = sentAt(capture, { name: '', heading: 'Nika', when: ['Yesterday at 18:43'], text: ['ok'] })
  assert.equal(new Date(y * 1000).getDate(), 29)
  assert.equal(new Date(y * 1000).getHours(), 18)
})

test('passing on what someone said is spotted with or without accents, and telling someone is not mistaken for it', async () => {
  const { wordRegex } = await import('../lib/lang.mjs')
  const says = wordRegex('says')
  for (const yes of ['Kaze AI da je taj stalak stabilan', 'kaže Nika da mu pošalješ crtež', 'Nika says the box moved', 'navodno je gotovo']) assert.ok(says.test(yes), yes)
  for (const no of ['kazi mu da dode sutra', 'kaži joj', 'can you edit the doc', 'saysomething']) assert.ok(!says.test(no), no)
})

test('a quiet day looks ahead: tomorrow\'s heads-up becomes the line under the orb', async () => {
  const { glanceOf } = await import('../lib/tasks.mjs')
  const quiet = { date: '2026-11-05', today: { events: [], tasks: [] }, forgotten: [], open: [], more: {} }
  assert.equal(glanceOf({ ...quiet, ahead: [] }), null)
  // Only tomorrow's reaches the line; the week's later ones wait for the hover card.
  assert.equal(glanceOf({ ...quiet, ahead: [{ day: '2026-11-07', label: 'Library booking' }] }), null)
  const g = glanceOf({ ...quiet, ahead: [{ day: '2026-11-06', label: 'Puzzle club', ts: null, text: 'Klub slagalica' }] })
  assert.equal(g.text, 'Puzzle Fri')
  assert.equal(g.about, 'Puzzle club')
  // Something due today still comes first.
  assert.equal(glanceOf({ ...quiet, today: { events: [], tasks: [{ summary: 'Pay for materials' }] }, ahead: [{ day: '2026-11-06', label: 'Puzzle club' }] }).text, '1 due today')
})
