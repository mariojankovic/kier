import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-call-tasks-'))
after(() => rmSync(process.env.KIER_DATA_DIR, { recursive: true, force: true }))
const { open, addItems, now, setCursor } = await import('../lib/db.mjs')
const { tasks, brief, today, plusDays } = await import('../lib/tasks.mjs')
const { config } = await import('../lib/config.mjs')
const AT = now() - 60
const nika = { contactKnown: true, contactId: 'nika', contactName: 'Nika Example', contactAliases: ['Nika Example', ['+99', '9 9', '1 1', '11 ', '111', '1'].join('')] }
const lucija = { contactKnown: true, contactId: 'lucija', contactName: 'Lucija Example', contactAliases: ['Lucija Example', ['+99', '9 9', '1 2', '22 ', '222', '2'].join('')] }
// These routing fixtures represent a user who already enabled callbacks before the calls below.
function vault(t) { const db = open(':memory:'); setCursor(db,'callbacks-since',AT-30*86400); t.after(() => db.close()); return db }
function task(db, { id = 'task', source = 'whatsapp', own = false, card = own ? 'promise' : 'reply', ts = AT - 900, contact = nika } = {}) {
  addItems(db, [{ id, source, thread: contact.contactName, sender: own ? 'Me' : contact.contactName,
    fromMe: own, ts, text: own ? "I'll call you" : 'Please call me', meta: { ...contact, group: false } }])
  db.prepare("insert into tags(item_id,is_task,summary,model,tagged_at,card) values (?,1,?,'test',?,?)")
    .run(id,`Call ${contact.contactName}`,ts,card)
  return id
}
function call(db, id, ts, { contact = nika, thread = contact.contactName, own = true, meta = {} } = {}) {
  addItems(db, [{ id, source: 'calls', thread, sender: own ? 'Me' : contact.contactName, fromMe: own,
    ts, text: 'Call event', meta: { ...contact, app: 'phone', seconds: 0, answered: false, ...meta } }])
}
function status(db,id,value,at,reason='owner choice') {
  db.prepare('insert into task_state(item_id,status,changed_at,reason) values (?,?,?,?) on conflict(item_id) do update set status=excluded.status,changed_at=excluded.changed_at,reason=excluded.reason')
    .run(id,value,at,reason)
}
const rendered = (db,id='task') => tasks(db).find(t => t.id === id)

test('an incoming call request stays open after a text reply, even a reply saying done', t => {
  for (const source of ['whatsapp','imessage']) {
    const db = vault(t);task(db,{source})
    addItems(db,[{id:'reply',source,thread:nika.contactName,sender:'Me',fromMe:true,ts:AT-700,text:'Done, thanks',meta:{...nika,group:false}}])
    const row=rendered(db)
    assert.equal(row.state,'open',source)
    assert.equal(row.done_at,null,source)
  }
})

test('an owner call promise only closes after the same known canonical contact actually connects', t => {
  const db=vault(t);task(db,{own:true})
  call(db,'missed',AT-800)
  call(db,'empty-answer',AT-700,{meta:{answered:true}})
  call(db,'unknown',AT-600,{contact:{contactKnown:false,contactName:nika.contactName,contactAliases:[nika.contactName]},meta:{seconds:90}})
  call(db,'different-person',AT-500,{contact:{...lucija,contactName:nika.contactName,contactAliases:[nika.contactName]},meta:{seconds:90}})
  assert.equal(rendered(db).state,'open')
  call(db,'real-conversation',AT-300,{thread:['+88', '888', '888', '888', '8'].join(''),meta:{app:'WhatsApp',seconds:80,talked:true}})
  const row=rendered(db)
  assert.equal(row.state,'handled')
  assert.equal(row.done_at,AT-300)
  assert.match(row.reason,/you spoke/)
})

test('an explicitly unknown call sharing a saved display name is never completion proof', t => {
  const db=vault(t);task(db,{own:true})
  call(db,'known-miss',AT-800)
  call(db,'unknown-same-name',AT-500,{contact:{contactKnown:false,contactName:nika.contactName,contactAliases:[nika.contactName]},meta:{seconds:90}})
  assert.equal(rendered(db).state,'open')
})

test('a task explicitly marked as an unknown contact does not borrow another contact identity by name', t => {
  const db=vault(t)
  task(db,{own:true,contact:{contactKnown:false,contactName:nika.contactName,contactAliases:[nika.contactName]}})
  call(db,'known-conversation',AT-300,{meta:{seconds:90}})
  assert.equal(rendered(db).state,'open')
})

test('an incoming request closes on an answered-elsewhere WhatsApp call with no duration', t => {
  const db=vault(t);task(db)
  call(db,'other-device',AT-300,{own:false,meta:{app:'WhatsApp',seconds:0,outcome:'elsewhere',answered:true}})
  const row=rendered(db)
  assert.equal(row.state,'handled')
  assert.equal(row.done_at,AT-300)
})

test('calls disabled in source settings cannot prove a call request completed', t => {
  const db=vault(t);task(db)
  call(db,'real-conversation',AT-300,{meta:{seconds:90}})
  const before=config.off
  config.off=[...(before||[]),'calls'];t.after(()=>{config.off=before})
  assert.equal(rendered(db).state,'open')
  config.off=before
  assert.equal(rendered(db).state,'handled')
})

test('a snoozed call task ignores earlier conversations and closes only on a later call', t => {
  const db=vault(t);task(db,{own:true})
  call(db,'before-snooze',AT-700,{meta:{seconds:90}})
  status(db,'task','snoozed',AT-500,`until ${plusDays(today(),1)}`)
  assert.equal(rendered(db).state,'snoozed')
  call(db,'after-snooze',AT-300,{meta:{seconds:60}})
  assert.equal(rendered(db).state,'handled')
  assert.equal(rendered(db).done_at,AT-300)
})

test('an explicitly reopened call task stays open despite connected-call evidence', t => {
  const db=vault(t);task(db,{own:true})
  call(db,'earlier-proof',AT-700,{meta:{seconds:60}})
  status(db,'task','open',AT-500)
  call(db,'later-proof',AT-300,{meta:{seconds:90}})
  const row=rendered(db)
  assert.equal(row.state,'open')
  assert.equal(row.status,'open')
  assert.equal(row.reason,'owner choice')
})

function callback(db, { id = 'callback', ts = AT - 900, promiseId, due = '', when = '', said = null, quiet = 1 } = {}) {
  const text = `Missed call from ${nika.contactName}`
  addItems(db,[{id,source:'calls',thread:nika.contactName,sender:nika.contactName,fromMe:false,ts,text,
    meta:{...nika,kind:'callback',contactKey:'contact:nika',firstCall:'original-miss',lastMissed:ts,count:1,
      ...(promiseId && {promiseId,promiseTs:ts+60})}}])
  db.prepare("insert into tags(item_id,is_task,summary,model,tagged_at,card,due,when_words,said,quiet,second) values (?,1,?,'callback',?,'callback',?,?,?,?,1)")
    .run(id,`Call ${nika.contactName} back`,ts,due,when,said,quiet)
  return id
}

test('turning the linked promise source off removes its wording, timing and ownership from a persisted callback', t => {
  const db=vault(t)
  task(db,{id:'private-promise',own:true,ts:AT-800})
  const promiseText='I will call you after the private appointment tomorrow'
  db.prepare('update items set text=? where id=?').run(promiseText,'private-promise')
  callback(db,{promiseId:'private-promise',due:plusDays(today(),1),when:'tomorrow after the appointment',said:promiseText,quiet:null})
  assert.equal(rendered(db,'callback').from_me,true)
  const before=config.off
  config.off=[...(before||[]),'whatsapp'];t.after(()=>{config.off=before})
  const row=rendered(db,'callback'),meta=JSON.parse(row.meta)
  assert.ok(row)
  assert.equal(row.text,`Missed call from ${nika.contactName}`)
  assert.equal(row.due,'')
  assert.equal(row.when_words,'')
  assert.equal(row.from_me,false)
  assert.equal(row.maybe,true)
  assert.equal(row.state,'open')
  assert.equal(Object.hasOwn(meta,'promiseId'),false)
  assert.equal(Object.hasOwn(meta,'promiseTs'),false)
  assert.equal(JSON.stringify(row).includes(promiseText),false)
  assert.equal(JSON.stringify(row).includes('private-promise'),false)
  assert.ok(brief(db).maybe.some(c=>c.id==='callback'))
})

test('an unanswered persisted callback remains in tasks and the brief beyond the ordinary 14-day task window', t => {
  const db=vault(t)
  callback(db,{ts:AT-20*86400})
  assert.equal(rendered(db,'callback').state,'open')
  assert.ok(brief(db).maybe.some(c=>c.id==='callback'))
})

test('a persisted callback with an overdue promised date still appears in the brief', t => {
  const db=vault(t)
  task(db,{id:'old-promise',own:true,ts:AT-20*86400+60})
  callback(db,{ts:AT-20*86400,promiseId:'old-promise',due:plusDays(today(),-18),when:'tomorrow',said:"I'll call tomorrow",quiet:null})
  const row=rendered(db,'callback')
  assert.ok(row)
  assert.ok(['open','overdue'].includes(row.state))
  const b=brief(db)
  assert.ok([...b.today.tasks,...b.forgotten,...b.open,...b.maybe,...b.soon.tasks].some(c=>c.id==='callback'))
})
