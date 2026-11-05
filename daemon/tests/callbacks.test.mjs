import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-callbacks-'))
after(() => rmSync(process.env.KIER_DATA_DIR, { recursive: true, force: true }))
const { open, addItems, setCursor, cursor } = await import('../lib/db.mjs')
const { config } = await import('../lib/config.mjs')
const { syncCallbacks, callIntent, callCompletion, initializeCallbacks, CALLBACKS_SINCE } = await import('../lib/callbacks.mjs')
const AT = 1_800_000_000, DAY = 86400
const people = {
  nika: { contactKnown: true, contactId: 'nika', contactName: 'Nika Example', contactAliases: ['Nika Example', ['+99', '9 9', '1 1', '11 ', '111', '1'].join('')] },
  lucija: { contactKnown: true, contactId: 'lucija', contactName: 'Lucija Example', contactAliases: ['Lucija Example', ['+99', '9 9', '1 2', '22 ', '222', '2'].join('')] },
}
function vault(t, { fresh = false } = {}) { const db = open(':memory:'); t.after(() => db.close()); if (!fresh) setCursor(db, CALLBACKS_SINCE, AT - 60 * DAY); return db }
const options = { at: AT, resolveContact: () => ({ known: false }) }
function call(db, id, ts, person = 'nika', meta = {}, out = false) {
  const contact = people[person] || { contactKnown: false, contactName: ['+99', '911', '111', '11'].join(''), contactAliases: [] }
  addItems(db, [{ id, source: 'calls', thread: contact.contactName, sender: out ? 'Me' : contact.contactName,
    fromMe: out, ts, text: 'Phone event', meta: { ...contact, seconds: 0, talked: false, direction: out ? 'outgoing' : 'incoming', ...meta } }])
}
function promise(db, id, ts, person = 'nika', { fromMe = true, group = false, summary, due = '', when = '', confirmed = null } = {}) {
  const contact = people[person]
  addItems(db, [{ id, source: 'whatsapp', thread: contact.contactName, sender: fromMe ? 'Me' : contact.contactName,
    fromMe, ts, text: "I'll call tomorrow", meta: { ...contact, group } }])
  db.prepare("insert into tags(item_id,is_task,due,when_words,amount,urgency,summary,model,tagged_at,card,confirmed) values (?,1,?,?,'',1,?,'test',?,'promise',?)")
    .run(id,due,when,summary || `Call ${contact.contactName} tomorrow`,ts,confirmed)
}
const cards = db => db.prepare(`select i.*, t.is_task, t.quiet, t.summary, t.due, t.when_words, t.said, s.status, s.changed_at, s.reason
  from items i join tags t on t.item_id=i.id left join task_state s on s.item_id=i.id where t.card='callback' order by i.ts,i.id`).all()
const state = (db,id,status,at) => db.prepare("insert into task_state(item_id,status,changed_at,reason) values (?,?,?,'owner choice') on conflict(item_id) do update set status=excluded.status,changed_at=excluded.changed_at,reason=excluded.reason").run(id,status,at)

test('repeat incoming misses from a known contact make one quiet suggestion and sync is idempotent', t => {
  const db=vault(t); call(db,'miss-1',AT-600);call(db,'miss-2',AT-400)
  assert.equal(syncCallbacks(db,options).created,1)
  const [card]=cards(db), meta=JSON.parse(card.meta)
  assert.equal(cards(db).length,1);assert.equal(card.quiet,1);assert.equal(meta.count,2)
  assert.equal(meta.firstCall,'miss-1');assert.equal(meta.lastMissed,AT-400)
  assert.deepEqual(syncCallbacks(db,options),{created:0,promoted:0,closed:0,folded:0})
  assert.equal(JSON.parse(cards(db)[0].meta).count,2)
})
test('unknown callers and unsuccessful outgoing attempts make no callback task', t => {
  const db=vault(t);call(db,'unknown',AT-600,'unknown');call(db,'outgoing',AT-400,'nika',{},true)
  syncCallbacks(db,options);assert.equal(cards(db).length,0)
})
test('a real connected call clears the episode and a later miss starts a new one', t => {
  const db=vault(t);call(db,'miss',AT-600);call(db,'talk',AT-400,'nika',{seconds:45,talked:true},true);call(db,'new-miss',AT-100)
  syncCallbacks(db,options)
  const list=cards(db);assert.equal(list.length,2);assert.equal(list[0].status,'handled');assert.match(list[0].reason,/45 seconds/)
  assert.equal(JSON.parse(list[0].meta).connectedCall,'talk');assert.equal(list[1].status,null)
})
test('answered on another device clears, but answered flag with zero duration does not', t => {
  const db=vault(t);call(db,'miss',AT-600);call(db,'empty',AT-500,'nika',{answered:true},true)
  syncCallbacks(db,options);assert.equal(cards(db)[0].status,null)
  call(db,'elsewhere',AT-300,'nika',{outcome:'answered_elsewhere'})
  syncCallbacks(db,options);assert.equal(cards(db)[0].status,'handled');assert.match(cards(db)[0].reason,/another device/)
})
test('a connected call before the missed call cannot close a new callback', t => {
  const db=vault(t);call(db,'earlier',AT-700,'nika',{seconds:90});call(db,'miss',AT-600)
  syncCallbacks(db,options);assert.equal(cards(db)[0].status,null)
})
test('same-contact owner promises carry timing and fold the standalone task without losing its message', t => {
  const db=vault(t);call(db,'miss',AT-600);promise(db,'promise',AT-300,'nika',{due:'2027-01-17',when:'tomorrow'})
  const result=syncCallbacks(db,options),[card]=cards(db)
  assert.equal(result.promoted,1);assert.equal(result.folded,1);assert.equal(card.quiet,null)
  assert.equal(card.due,'2027-01-17');assert.equal(card.when_words,'tomorrow');assert.equal(card.said,"I'll call tomorrow")
  assert.equal(JSON.parse(card.meta).promiseId,'promise')
  assert.equal(db.prepare("select is_task from tags where item_id='promise'").get().is_task,0)
  assert.ok(db.prepare("select text from items where id='promise'").get())
  assert.deepEqual(syncCallbacks(db,options),{created:0,promoted:0,closed:0,folded:0})
})
test('an incoming promise, group promise, or promise to someone else cannot promote the callback', t => {
  const db=vault(t);call(db,'miss',AT-600)
  promise(db,'incoming',AT-400,'nika',{fromMe:false});promise(db,'group',AT-300,'nika',{group:true});promise(db,'other',AT-200,'lucija')
  syncCallbacks(db,options);assert.equal(cards(db)[0].quiet,1)
  for(const id of ['incoming','group','other'])assert.equal(db.prepare('select is_task from tags where item_id=?').get(id).is_task,1)
})
test('all repeated owner promises fold while the latest wording supplies the schedule', t => {
  const db=vault(t);call(db,'miss',AT-600);promise(db,'p1',AT-400,'nika',{when:'today'});promise(db,'p2',AT-200,'nika',{when:'tomorrow'})
  syncCallbacks(db,options);assert.equal(cards(db)[0].when_words,'tomorrow')
  assert.equal(db.prepare("select count(*) n from tags where model='callback-promise' and is_task=0").get().n,2)
})
test('different canonical contacts never merge even when their display names overlap', t => {
  const db=vault(t);call(db,'nika-miss',AT-600);call(db,'lucija-miss',AT-500,'lucija',{contactName:'Nika Example',contactAliases:['Nika Example']})
  call(db,'lucija-talk',AT-300,'lucija',{seconds:60,contactName:'Nika Example',contactAliases:['Nika Example']})
  syncCallbacks(db,options);assert.equal(cards(db).length,2)
  assert.equal(cards(db).find(c=>JSON.parse(c.meta).contactId==='nika').status,null)
  assert.equal(cards(db).find(c=>JSON.parse(c.meta).contactId==='lucija').status,'handled')
})
test('turning Calls off prevents both new suggestions and changes to existing callbacks', t => {
  const db=vault(t);call(db,'miss',AT-600);const before=config.off;config.off=[...before,'calls'];t.after(()=>{config.off=before})
  syncCallbacks(db,options);assert.equal(cards(db).length,0)
  config.off=before;syncCallbacks(db,options);const snapshot=cards(db)
  call(db,'talk',AT-300,'nika',{seconds:60});config.off=[...before,'calls'];syncCallbacks(db,options)
  assert.deepEqual(cards(db),snapshot)
})
test('manual dismissal stays dismissed across sync and a later fresh miss gets a new episode', t => {
  const db=vault(t);call(db,'miss',AT-600);syncCallbacks(db,options);const id=cards(db)[0].id
  state(db,id,'dismissed',AT-400);syncCallbacks(db,options);assert.equal(cards(db).length,1);assert.equal(cards(db)[0].status,'dismissed')
  call(db,'later-miss',AT-100);syncCallbacks(db,options);assert.equal(cards(db).length,2)
  assert.equal(cards(db).find(c=>c.id===id).status,'dismissed');assert.equal(cards(db).filter(c=>!c.status).length,1)
})
test('snoozed callback clears only on a connected call later than the snooze', t => {
  const db=vault(t);call(db,'miss',AT-900);syncCallbacks(db,options);const id=cards(db)[0].id
  call(db,'past-talk',AT-700,'nika',{seconds:30});state(db,id,'snoozed',AT-500)
  syncCallbacks(db,options);assert.equal(cards(db)[0].status,'snoozed')
  call(db,'future-talk',AT-200,'nika',{seconds:45});syncCallbacks(db,options)
  assert.equal(cards(db)[0].status,'handled');assert.equal(cards(db)[0].changed_at,AT-200)
})
test('a connected call followed by a fresh promise leaves that new promise open', t => {
  const db=vault(t);call(db,'miss',AT-900);call(db,'talk',AT-700,'nika',{seconds:30});promise(db,'new-promise',AT-400)
  syncCallbacks(db,options);assert.equal(cards(db)[0].status,'handled')
  const row=db.prepare("select i.*, t.summary from items i join tags t on t.item_id=i.id where i.id='new-promise'").get()
  assert.equal(db.prepare("select is_task from tags where item_id='new-promise'").get().is_task,1)
  assert.equal(callCompletion(db,row,options),null)
})
test('an existing older episode stays one card across the initial 7-day boundary', t => {
  const db=vault(t);call(db,'old-miss',AT-8*DAY);syncCallbacks(db,{...options,at:AT-2*DAY})
  const id=cards(db)[0].id;call(db,'fresh-miss',AT-300);syncCallbacks(db,options)
  assert.equal(cards(db).length,1);assert.equal(cards(db)[0].id,id);assert.equal(JSON.parse(cards(db)[0].meta).count,2)
})
test('bounded raw replay does not create callback cards for misses older than fourteen days', t => {
  const db=vault(t);call(db,'old-miss',AT-15*DAY);syncCallbacks(db,options);assert.equal(cards(db).length,0)
})
test('call completion applies to incoming requests and outgoing promises, excludes API calls and groups with unknown recipient', t => {
  const db=vault(t);promise(db,'request',AT-600,'nika',{fromMe:false});promise(db,'promise',AT-500)
  call(db,'no-answer',AT-400,'nika',{},true);call(db,'talk',AT-300,'nika',{seconds:75},true)
  for(const id of ['request','promise']) {
    const row=db.prepare('select i.*,t.summary from items i join tags t on t.item_id=i.id where i.id=?').get(id)
    assert.equal(callIntent(row),true);const proof=callCompletion(db,row,options);assert.equal(proof.id,'talk');assert.equal(proof.seconds,75)
  }
  assert.equal(callIntent({source:'whatsapp',summary:'Call the API endpoint'}),false)
  const row=db.prepare("select i.*,t.summary from items i join tags t on t.item_id=i.id where i.id='promise'").get()
  row.meta=JSON.stringify({...JSON.parse(row.meta),group:true});assert.equal(callCompletion(db,row,options),null)
})

test('a direct chat about calling a third person is not a callback to the chat contact', t => {
  const db=vault(t);call(db,'miss',AT-600)
  promise(db,'third-party',AT-500,'nika',{summary:'Call Lucija Example to ask about Nika Example'})
  call(db,'talk-nika',AT-200,'nika',{seconds:40})
  const row=db.prepare("select i.*,t.summary from items i join tags t on t.item_id=i.id where i.id='third-party'").get()
  assert.equal(callCompletion(db,row,options),null)
  syncCallbacks(db,options)
  assert.equal(db.prepare("select is_task from tags where item_id='third-party'").get().is_task,1)
  assert.equal(JSON.parse(cards(db)[0].meta).promiseId,undefined)
})
test('a Mine promise and explicit callback open choice remain intact', t => {
  const db=vault(t);call(db,'miss',AT-600);promise(db,'claimed',AT-500,'nika',{confirmed:1})
  syncCallbacks(db,options);const id=cards(db)[0].id
  assert.equal(db.prepare("select is_task from tags where item_id='claimed'").get().is_task,1)
  state(db,id,'open',AT-400);call(db,'talk',AT-300,'nika',{seconds:30});syncCallbacks(db,options)
  assert.equal(cards(db)[0].status,'open');assert.equal(cards(db)[0].reason,'owner choice')
})
test('legacy calls become suggestions only after an exact unique saved-contact match', t => {
  const db=vault(t)
  addItems(db,[{id:'legacy',source:'calls',thread:'Nika Example',sender:'Nika Example',ts:AT-500,text:'Missed phone call',meta:{seconds:0}}])
  syncCallbacks(db,options);assert.equal(cards(db).length,0)
  syncCallbacks(db,{...options,resolveContact:(_handle,name)=>name==='Nika Example'?{known:true,id:'nika',name,aliases:[name,['+88', '888', '888', '888', '8'].join('')]}:{known:false}})
  assert.equal(cards(db).length,1)
})
test('the same saved person across chat names and formatted phone aliases shares one callback', t => {
  const db=vault(t);call(db,'phone',AT-600);call(db,'whatsapp',AT-500,'nika',{contactName:'Nika Work',contactAliases:['Nika Work',['888', '888', '888', '888'].join('')]})
  promise(db,'promise',AT-300,'nika');syncCallbacks(db,options)
  assert.equal(cards(db).length,1);assert.equal(JSON.parse(cards(db)[0].meta).count,2);assert.equal(cards(db)[0].quiet,null)
})

test('an unresolved anchor and its promise survive beyond fourteen days without recounting recent misses', t => {
  const db=vault(t);const began=AT-30*DAY
  call(db,'first',began-600);promise(db,'old-promise',began-300,'nika',{due:'2027-01-17',when:'next month'})
  syncCallbacks(db,{...options,at:began});const id=cards(db)[0].id
  call(db,'fresh',AT-300);syncCallbacks(db,options)
  assert.equal(cards(db).length,1);const [card]=cards(db)
  assert.equal(card.id,id);assert.equal(card.due,'2027-01-17');assert.equal(card.when_words,'next month')
  assert.equal(JSON.parse(card.meta).count,2);assert.equal(JSON.parse(card.meta).promiseId,'old-promise')
  syncCallbacks(db,options);assert.equal(JSON.parse(cards(db)[0].meta).count,2)
})
test('a Mine owner promise remains the single visible task while the automatic callback keeps its anchor', t => {
  const db=vault(t);call(db,'miss',AT-600);promise(db,'chosen',AT-500,'nika',{confirmed:1})
  syncCallbacks(db,options)
  assert.equal(cards(db).length,1);assert.equal(cards(db)[0].is_task,0)
  assert.equal(db.prepare("select is_task from tags where item_id='chosen'").get().is_task,1)
  call(db,'another-miss',AT-300);syncCallbacks(db,options)
  assert.equal(cards(db).length,1);assert.equal(cards(db)[0].is_task,0)
  assert.equal(JSON.parse(cards(db)[0].meta).count,2)
})
test('unknown raw call cannot prove completion by borrowing a known caller name', t => {
  const db=vault(t);promise(db,'promise',AT-600);call(db,'miss',AT-500)
  call(db,'unknown-talk',AT-300,'nika',{contactKnown:false,contactId:undefined,seconds:40})
  const row=db.prepare("select i.*,t.summary from items i join tags t on t.item_id=i.id where i.id='promise'").get()
  assert.equal(callCompletion(db,row,options),null)
})
test('generic completion inference does not read call promises or close them from chat text', async t => {
  const db=vault(t);promise(db,'promise',AT-600)
  addItems(db,[{id:'chat-done',source:'whatsapp',thread:people.nika.contactName,sender:'Me',fromMe:true,ts:AT-300,text:'All done now',meta:people.nika}])
  const {resolvePending}=await import('../lib/resolve.mjs')
  const before=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('No model request expected')};t.after(()=>{globalThis.fetch=before})
  await resolvePending(db,4,{now:true})
  assert.equal(calls,0)
  assert.equal(db.prepare("select 1 from task_state where item_id='promise'").get(),undefined)
})


test('a callback renamed by its owner keeps that title as more missed calls arrive', t => {
  const db=vault(t);call(db,'miss-1',AT-600);syncCallbacks(db,options)
  const id=cards(db)[0].id
  db.prepare('update tags set summary=? where item_id=?').run('Call Nika about the venue',id)
  call(db,'miss-2',AT-200);syncCallbacks(db,options)
  assert.equal(cards(db)[0].summary,'Call Nika about the venue')
  assert.equal(JSON.parse(cards(db)[0].meta).count,2)
})

test('refreshing the same first call to connected closes its old suggestion and leaves a later miss separate', t => {
  const db=vault(t);call(db,'first',AT-600);syncCallbacks(db,options);const first=cards(db)[0].id
  db.prepare('update items set meta=? where id=?').run(JSON.stringify({...people.nika,seconds:50,talked:true}),'first')
  const original=cards(db)[0];assert.equal(callCompletion(db,original,options).id,'first')
  call(db,'later',AT-200);syncCallbacks(db,options)
  assert.equal(cards(db).length,2);assert.equal(cards(db).find(c=>c.id===first).status,'handled')
  assert.equal(cards(db).filter(c=>c.status==null).length,1)
})
test('refreshing a call cannot settle a callback promise made after that same call', t => {
  const db=vault(t);call(db,'first',AT-600);promise(db,'later-promise',AT-300);syncCallbacks(db,options)
  db.prepare('update items set meta=? where id=?').run(JSON.stringify({...people.nika,seconds:50,talked:true}),'first')
  assert.equal(callCompletion(db,cards(db)[0],options),null)
  syncCallbacks(db,options);assert.equal(cards(db).length,1);assert.equal(cards(db)[0].status,null)
  assert.equal(JSON.parse(cards(db)[0].meta).promiseId,'later-promise')
})

test('first activation ignores backfill and persists one cutoff across later syncs and restarts', t => {
  const db=vault(t,{fresh:true});call(db,'backfill',AT-500)
  assert.equal(initializeCallbacks(db,{at:AT}),AT)
  syncCallbacks(db,options);assert.equal(cards(db).length,0)
  assert.equal(initializeCallbacks(db,{at:AT+DAY}),AT)
  call(db,'at-boundary',AT);call(db,'after-activation',AT+1)
  syncCallbacks(db,{...options,at:AT+2})
  assert.equal(cards(db).length,1);assert.equal(JSON.parse(cards(db)[0].meta).firstCall,'after-activation')
  assert.equal(JSON.parse(cards(db)[0].meta).count,1)
  assert.equal(Number(cursor(db,CALLBACKS_SINCE)),AT)
})
test('Calls off still records first activation so enabling it never turns backfill into suggestions', t => {
  const db=vault(t,{fresh:true});const before=config.off;config.off=[...before,'calls'];t.after(()=>{config.off=before})
  call(db,'before',AT-200);syncCallbacks(db,options)
  assert.equal(Number(cursor(db,CALLBACKS_SINCE)),AT)
  config.off=before;call(db,'after',AT+10);syncCallbacks(db,{...options,at:AT+20})
  assert.equal(cards(db).length,1);assert.equal(JSON.parse(cards(db)[0].meta).firstCall,'after')
})
test('upgrade hides only automatic pre-activation suggestions and automatic Done, retaining owner choices and promises', t => {
  for(const kind of ['automatic','handled','done','dismissed','open','snoozed','mine','renamed','promise']) {
    const db=vault(t);call(db,`${kind}-miss`,AT-600)
    if(kind==='handled')call(db,`${kind}-connected`,AT-500,'nika',{seconds:45})
    if(kind==='promise')promise(db,'owned-promise',AT-500)
    syncCallbacks(db,options);const id=cards(db)[0].id
    if(['done','dismissed','open','snoozed'].includes(kind))state(db,id,kind,AT-300)
    if(kind==='mine')db.prepare('update tags set confirmed=1 where item_id=?').run(id)
    if(kind==='renamed')db.prepare('update tags set summary=? where item_id=?').run('Ask Nika about the venue',id)
    const states=db.prepare('select * from task_state order by item_id').all()
    const raw=db.prepare("select * from items where source='calls' and id not like 'callback:%' order by id").all()
    db.prepare('delete from cursors where source=?').run(CALLBACKS_SINCE)
    syncCallbacks(db,options)
    const hidden=['automatic','handled'].includes(kind)
    assert.equal(cards(db).find(card=>card.id===id).is_task,hidden?0:1,kind)
    assert.deepEqual(db.prepare('select * from task_state order by item_id').all(),states,kind)
    assert.deepEqual(db.prepare("select * from items where source='calls' and id not like 'callback:%' order by id").all(),raw,kind)
    if(kind==='promise') {
      assert.equal(JSON.parse(cards(db)[0].meta).promiseId,'owned-promise')
      assert.equal(db.prepare("select model from tags where item_id='owned-promise'").get().model,'callback-promise')
    }
  }
})
test('a suppressed historical anchor cannot collect a fresh missed call or resurrect on another pass', t => {
  const db=vault(t);call(db,'old-one',AT-700);call(db,'old-two',AT-600);syncCallbacks(db,options)
  const old=cards(db)[0].id
  db.prepare('delete from cursors where source=?').run(CALLBACKS_SINCE)
  syncCallbacks(db,options);assert.equal(cards(db)[0].is_task,0)
  call(db,'fresh',AT+30);syncCallbacks(db,{...options,at:AT+60})
  const live=cards(db).filter(card=>card.is_task===1)
  assert.equal(live.length,1);assert.notEqual(live[0].id,old)
  assert.equal(JSON.parse(live[0].meta).firstCall,'fresh');assert.equal(JSON.parse(live[0].meta).count,1)
  syncCallbacks(db,{...options,at:AT+90})
  assert.equal(cards(db).length,2);assert.equal(cards(db).find(card=>card.id===old).is_task,0)
})

test('an already hidden unclaimed historical anchor cannot be reactivated during migration', t => {
  const db=vault(t);call(db,'old',AT-600);syncCallbacks(db,options);const id=cards(db)[0].id
  db.prepare('update tags set is_task=0 where item_id=?').run(id)
  db.prepare('delete from cursors where source=?').run(CALLBACKS_SINCE)
  syncCallbacks(db,options);syncCallbacks(db,{...options,at:AT+10})
  assert.equal(cards(db)[0].is_task,0)
  assert.equal(db.prepare('select model from tags where item_id=?').get(id).model,'callback-history')
})

test('a historical hidden callback does not resurrect after its explicitly owned promise was completed', t => {
  const db=vault(t);call(db,'old',AT-600);promise(db,'chosen',AT-500,'nika',{confirmed:1});syncCallbacks(db,options)
  const id=cards(db)[0].id;assert.equal(cards(db)[0].is_task,0)
  state(db,'chosen','done',AT-100);const before=db.prepare("select * from task_state where item_id='chosen'").get()
  db.prepare('delete from cursors where source=?').run(CALLBACKS_SINCE)
  syncCallbacks(db,options)
  assert.equal(cards(db)[0].is_task,0)
  assert.equal(db.prepare('select model from tags where item_id=?').get(id).model,'callback-history')
  assert.equal(db.prepare("select is_task from tags where item_id='chosen'").get().is_task,1)
  assert.deepEqual(db.prepare("select * from task_state where item_id='chosen'").get(),before)
})
