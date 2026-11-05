import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
process.env.KIER_DATA_DIR=mkdtempSync(join(tmpdir(),'kier-phone-confidence-'))
after(()=>rmSync(process.env.KIER_DATA_DIR,{recursive:true,force:true}))
const {open,addItems,now}=await import('../lib/db.mjs')
const {config}=await import('../lib/config.mjs')
const {phoneItems}=await import('../lib/phone.mjs')
const {today}=await import('../lib/tasks.mjs')
config.phoneReminders=true
config.phoneCalendar=false
function card(t,{second=null,own=false,confirmed=null,status=null}={}){
 const db=open(':memory:');t.after(()=>db.close())
 addItems(db,[{id:'message',source:'whatsapp',thread:'Nika',sender:own?config.me:'Nika',fromMe:own,ts:now()-120,text:'At noon',meta:{group:false}}])
 db.prepare("insert into tags(item_id,is_task,due,summary,card,model,tagged_at,second,confirmed) values ('message',1,?,'Meet at noon','appointment','test',?,?,?)").run(today(),now(),second,confirmed)
 if(status)db.prepare("insert into task_state(item_id,status,changed_at,reason) values ('message',?,?,'owner choice')").run(status,now())
 return db
}
test('a decision-model veto keeps an incoming guess out of Reminders',t=>{
 const db=card(t,{second:0})
 assert.equal(phoneItems(db,{decisionAvailable:true}).items.length,0)
})
test('when a decision model is installed, incoming reminders wait for its check',t=>{
 const db=card(t)
 assert.equal(phoneItems(db,{decisionAvailable:true}).items.length,0)
 assert.equal(phoneItems(db,{decisionAvailable:false}).items.length,1)
})
test('a clear incoming request and owner promises continue to sync',t=>{
 assert.equal(phoneItems(card(t,{second:0.85}),{decisionAvailable:true}).items.length,1)
 assert.equal(phoneItems(card(t,{second:0.34}),{decisionAvailable:true}).items.length,1)
 assert.equal(phoneItems(card(t,{own:true}),{decisionAvailable:true}).items.length,1)
})
test('explicit Mine and reopen decisions override model doubt',t=>{
 assert.equal(phoneItems(card(t,{second:0.2,confirmed:1}),{decisionAvailable:true}).items.length,1)
 assert.equal(phoneItems(card(t,{second:0.3,status:'open'}),{decisionAvailable:true}).items.length,1)
})
test('a manually completed reminder still syncs completion while dismissed guesses stay absent',t=>{
 const done=phoneItems(card(t,{second:0.3,status:'done'}),{decisionAvailable:true}).items
 assert.equal(done.length,1);assert.equal(done[0].done,true)
 assert.equal(phoneItems(card(t,{second:0.3,status:'dismissed'}),{decisionAvailable:true}).items.length,0)
})
