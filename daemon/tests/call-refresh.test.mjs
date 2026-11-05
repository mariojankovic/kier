import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-call-refresh-'))
after(() => rmSync(process.env.KIER_DATA_DIR, { recursive: true, force: true }))
const { open, now, cursor, setCursor } = await import('../lib/db.mjs')
const { refreshCallItems } = await import('../collectors/calls.mjs')
const { syncCallbacks } = await import('../lib/callbacks.mjs')
const { tasks, brief } = await import('../lib/tasks.mjs')
const { forgetKey } = await import('../lib/privacy.mjs')
const AT=now()-60
const person={contactKnown:true,contactId:'person-1',contactName:'Nika Example',contactAliases:['Nika Example',['+88', '888', '888', '888'].join('')]}
const raw=(seconds=0)=>({id:'calls:42',source:'calls',thread:'Nika Example',sender:'Nika Example',fromMe:false,ts:AT-120,
  text:seconds?'Nika Example called on phone (1 min)':'Missed phone call from Nika Example',meta:{...person,app:'phone',seconds,answered:seconds>0,out:false}})
// Refresh fixtures are existing installations whose callback baseline predates their raw call rows.
function vault(t){const db=open(':memory:');setCursor(db,'callbacks-since',AT-86400);t.after(()=>db.close());return db}
const options={at:AT,resolveContact:()=>({known:false})}

test('a raw call updated under the same ID can settle its callback without duplicating either row',t=>{
  const db=vault(t)
  assert.deepEqual(refreshCallItems(db,[raw()]),{added:1,updated:0})
  syncCallbacks(db,options)
  const callback=db.prepare("select i.id from items i join tags t on t.item_id=i.id where t.card='callback'").get()
  assert.ok(callback)
  assert.deepEqual(refreshCallItems(db,[raw(60)]),{added:0,updated:1})
  syncCallbacks(db,options)
  assert.equal(db.prepare('select status from task_state where item_id=?').get(callback.id).status,'handled')
  assert.equal(db.prepare("select count(*) n from items where id='calls:42'").get().n,1)
  assert.equal(db.prepare("select count(*) n from tags where card='callback'").get().n,1)
  assert.deepEqual(refreshCallItems(db,[raw(60)]),{added:0,updated:0})
})

test('raw contact metadata can be refreshed while an explicit task choice stays untouched',t=>{
  const db=vault(t);refreshCallItems(db,[raw()])
  db.prepare("insert into task_state(item_id,status,changed_at,reason) values ('calls:42','dismissed',?,'owner choice')").run(AT-100)
  const before=db.prepare("select * from task_state where item_id='calls:42'").get()
  const fresh=raw();fresh.meta.contactAliases.push('nika@example.test')
  assert.deepEqual(refreshCallItems(db,[fresh]),{added:0,updated:1})
  assert.deepEqual(db.prepare("select * from task_state where item_id='calls:42'").get(),before)
  assert.ok(JSON.parse(db.prepare("select meta from items where id='calls:42'").get().meta).contactAliases.includes('nika@example.test'))
})

test('a forgotten call is never reinserted or changed by recent-history refresh',t=>{
  const db=vault(t)
  db.prepare("insert into forgotten(key,kind,at) values (?,'item',?)").run(forgetKey('item','calls:42'),AT)
  assert.deepEqual(refreshCallItems(db,[raw(60)]),{added:0,updated:0})
  assert.equal(db.prepare("select count(*) n from items where id='calls:42'").get().n,0)
})

test('a fresh callback baseline leaves old call history out of Maybe yours and Done, and survives restart',t=>{
  const path=join(process.env.KIER_DATA_DIR,'fresh-callback-install.db')
  let db=open(path)
  t.after(()=>db?.close())
  const oldMiss=raw()
  const oldTalk={...raw(45),id:'calls:41',ts:AT-60}
  refreshCallItems(db,[oldMiss,oldTalk])
  assert.equal(cursor(db,'callbacks-since',null),null)
  syncCallbacks(db,{...options,at:AT})
  assert.equal(Number(cursor(db,'callbacks-since',null)),AT)
  assert.equal(tasks(db).filter(c=>c.card==='callback').length,0)
  assert.equal(brief(db).maybe.filter(c=>c.card==='callback').length,0)
  assert.equal((brief(db).done||[]).filter(c=>c.card==='callback').length,0)

  refreshCallItems(db,[{...raw(),id:'calls:43',ts:AT+1}])
  syncCallbacks(db,{...options,at:AT+2})
  const [callback]=brief(db).maybe.filter(c=>c.card==='callback')
  assert.ok(callback)
  assert.equal(JSON.parse(callback.meta).count,1)
  assert.equal(JSON.parse(callback.meta).firstCall,'calls:43')
  db.close();db=open(path)
  assert.equal(Number(cursor(db,'callbacks-since',null)),AT)
  // Late-arriving backfill is still historical, even when inserted after restart.
  refreshCallItems(db,[{...raw(),id:'calls:44',ts:AT-30}])
  syncCallbacks(db,{...options,at:AT+3})
  const visible=brief(db).maybe.filter(c=>c.card==='callback')
  assert.equal(visible.length,1)
  assert.equal(visible[0].id,callback.id)
  assert.equal(JSON.parse(visible[0].meta).count,1)
  assert.equal((brief(db).done||[]).filter(c=>c.card==='callback').length,0)
})
