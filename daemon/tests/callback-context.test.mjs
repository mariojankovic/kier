import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-callback-context-'))
after(() => rmSync(process.env.KIER_DATA_DIR, { recursive: true, force: true }))
const { open, addItems, now } = await import('../lib/db.mjs')
const { config } = await import('../lib/config.mjs')
const { callbackContext } = await import('../lib/callback-context.mjs')
const AT = now(), HOUR = 3600
const contact = { contactKnown: true, contactId: 'nika', contactName: 'Nika Example', contactAliases: ['Nika Example'] }
function vault(t) { const db = open(':memory:'); t.after(() => db.close()); return db }
function row(db,id,ts,{source='calls',fromMe=false,text=id,meta=contact,thread='Nika Example',sender=fromMe?'Me':'Nika Example'}={}) {
  addItems(db,[{id,source,thread,sender,fromMe,ts,text,meta}]);return db.prepare('select * from items where id=?').get(id)
}
function callback(db,meta={}) {
  return row(db,'callback',AT-3*HOUR,{meta:{kind:'callback',...contact,contactKey:'contact:nika',firstCall:'first',lastMissedId:'latest',...meta}})
}
const tag={summary:'Call Nika Example back',said:"I'll call after lunch",due:'2027-01-17',when_words:'after lunch'}

test('callback context joins actual call anchors and later owner promise with direct-chat neighbours',t=>{
  const db=vault(t)
  row(db,'first',AT-3*HOUR,{text:'Missed phone call from Nika Example'})
  row(db,'latest',AT-2*HOUR,{text:'Missed WhatsApp call from Nika Example'})
  row(db,'question',AT-HOUR-60,{source:'whatsapp',text:'Can we talk later?'})
  row(db,'promise',AT-HOUR,{source:'whatsapp',fromMe:true,text:"I'll call after lunch"})
  row(db,'ack',AT-HOUR+60,{source:'whatsapp',text:'Thanks'})
  row(db,'unrelated',AT-HOUR+30,{source:'whatsapp',thread:'Lucija Example',text:'Private unrelated message'})
  row(db,'commit',AT-HOUR+20,{source:'git',text:'Unrelated work'})
  const ctx=callbackContext(db,callback(db,{promiseId:'promise'}),tag)
  assert.deepEqual(ctx.messages.map(m=>m.id),['first','latest','question','promise','ack'])
  assert.equal(ctx.messages.find(m=>m.id==='promise').text,"I'll call after lunch")
  assert.equal(ctx.messages.find(m=>m.id==='promise').from_me,true)
  assert.equal(ctx.messages.find(m=>m.id==='promise').picked,true)
  assert.deepEqual(ctx.since,[])
})
test('failed attempts remain raw history and only a real connected call is proof',t=>{
  const db=vault(t)
  row(db,'first',AT-3*HOUR)
  row(db,'latest',AT-2*HOUR)
  row(db,'attempt',AT-HOUR,{fromMe:true,text:'Tried to call Nika Example, no answer',meta:{...contact,seconds:0,answered:true}})
  const card=callback(db,{connectedCall:'attempt'})
  let ctx=callbackContext(db,card,tag)
  assert.ok(ctx.messages.some(m=>m.id==='attempt'));assert.deepEqual(ctx.since,[])
  row(db,'connected',AT-600,{fromMe:true,text:'Called Nika Example on phone (2 minutes)',meta:{...contact,seconds:120}})
  card.meta=JSON.stringify({...JSON.parse(card.meta),connectedCall:'connected'})
  ctx=callbackContext(db,card,tag)
  assert.deepEqual(ctx.since,[{line:'Called Nika Example on phone (2 minutes)',url:null}])
  assert.equal(ctx.messages.some(m=>m.id==='connected'),false)
})
test('another canonical contact cannot become connected-call evidence',t=>{
  const db=vault(t)
  row(db,'first',AT-3*HOUR)
  row(db,'latest',AT-2*HOUR)
  row(db,'someone-else',AT-600,{text:'Spoke to somebody else',meta:{...contact,contactId:'lucija',seconds:120}})
  const ctx=callbackContext(db,callback(db,{connectedCall:'someone-else'}),tag)
  assert.deepEqual(ctx.since,[]);assert.equal(ctx.messages.some(m=>m.id==='someone-else'),false)
})
test('disabled promise sources expose neither original text nor derived timing',t=>{
  const db=vault(t),before=config.off;t.after(()=>{config.off=before})
  row(db,'first',AT-3*HOUR);row(db,'latest',AT-2*HOUR)
  row(db,'promise',AT-HOUR,{source:'whatsapp',fromMe:true,text:"I'll call after lunch"})
  config.off=[...before,'whatsapp']
  const ctx=callbackContext(db,callback(db,{promiseId:'promise'}),tag)
  assert.deepEqual(ctx.messages.map(m=>m.id),['first','latest'])
  assert.equal(ctx.tag.said,null);assert.equal(ctx.tag.due,'');assert.equal(ctx.tag.when_words,'')
})
test('Calls off returns no callback details, and ordinary cards use their normal context',t=>{
  const db=vault(t),before=config.off;t.after(()=>{config.off=before})
  const card=callback(db);config.off=[...before,'calls']
  assert.deepEqual(callbackContext(db,card,tag),{error:'source off'})
  assert.equal(callbackContext(db,{source:'whatsapp',meta:'{}'},tag),null)
})
test('answered on another device is valid connected proof without speech duration',t=>{
  const db=vault(t);row(db,'first',AT-3*HOUR);row(db,'latest',AT-2*HOUR)
  row(db,'elsewhere',AT-600,{text:'Nika Example called on WhatsApp, answered on another device',meta:{...contact,seconds:0,outcome:'elsewhere'}})
  const ctx=callbackContext(db,callback(db,{connectedCall:'elsewhere'}),tag)
  assert.equal(ctx.since[0].line,'Nika Example called on WhatsApp, answered on another device')
})
test('legacy connected-call proof needs a unique saved-contact match and manual closure bounds its episode',t=>{
  const db=vault(t);row(db,'first',AT-3*HOUR);row(db,'latest',AT-2*HOUR)
  row(db,'legacy-talk',AT-1200,{text:'Called Nika Example (1 minute)',meta:{seconds:60}})
  const card=callback(db,{connectedCall:'legacy-talk'})
  assert.deepEqual(callbackContext(db,card,tag,{resolveContact:()=>({known:false})}).since,[])
  const ctx=callbackContext(db,card,tag,{resolveContact:()=>({known:true,id:'nika',name:'Nika Example',aliases:['Nika Example']})})
  assert.equal(ctx.since[0].line,'Called Nika Example (1 minute)')
  row(db,'newer-episode',AT-600,{text:'Newer missed call'})
  card.meta=JSON.stringify({...JSON.parse(card.meta),connectedCall:undefined})
  db.prepare("insert into task_state(item_id,status,changed_at) values (?,'done',?)").run(card.id,AT-900)
  assert.equal(callbackContext(db,card,tag).messages.some(m=>m.id==='newer-episode'),false)
})
