import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {decisionMessage} from '../lib/second.mjs'
const item={source:'whatsapp',thread:'Nika',sender:'Nika',from_me:0,ts:1_800_000_000,text:'Posljednje poglavlje je vrlo zanimljivo',meta:'{"group":false}',context:[{time:'12:06',from:'Owner',text:'Jesi li završila knjigu iz knjižnice?'}]}
const script=`import ast,json,pathlib,sys
path=sys.argv[1]
module=ast.parse(pathlib.Path(path).read_text())
function=next(n for n in module.body if isinstance(n,ast.FunctionDef) and n.name=='state')
ns={'ABOUT':'Local owner vault','N':'Owner','P':{'he':'they'}}
exec(compile(ast.Module(body=[function],type_ignores=[]),path,'exec'),ns)
print(json.dumps(ns['state'](json.loads(sys.argv[2]))))`
const state=m=>JSON.parse(execFileSync('python3',['-c',script,fileURLToPath(new URL('../sidecar/d1_server.py',import.meta.url)),JSON.stringify(m)],{encoding:'utf8'}))
test('the decision sidecar receives the owner question separately from the short reply',()=>{
 const wire=decisionMessage(item),actual=state(wire)
 assert.equal(actual.message_to_judge.text,item.text)
 assert.equal(actual.message_to_judge.from,'Nika')
 assert.deepEqual(actual.earlier_messages,wire.context)
 assert.ok(actual.earlier_messages.every(c=>c.trust.untrusted))
 assert.equal(actual.message_to_judge.trust.authorship,'other')
 assert.ok(!actual.message_to_judge.text.includes('sorting the paper'))
})
test('long chat history is bounded while the current message remains unchanged',()=>{
 const wire=decisionMessage({...item,context:Array.from({length:12},(_,i)=>({from:'Owner',text:String(i)+'x'.repeat(400)}))})
 const actual=state(wire)
 assert.equal(actual.earlier_messages.length,8)
 assert.ok(actual.earlier_messages.every(c=>c.text.length<=300))
 assert.equal(actual.message_to_judge.text,item.text)
})
test('no-context callers keep working and outgoing sender identity stays explicit',()=>{
 const wire=decisionMessage({...item,from_me:1,context:undefined,meta:'invalid'})
 const actual=state(wire)
 assert.equal(actual.message_to_judge.from,'Owner (they wrote it)')
 assert.equal(actual.earlier_messages,undefined)
})
