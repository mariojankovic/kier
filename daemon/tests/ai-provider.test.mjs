import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aiProvider, codexLink } from '../lib/ai-provider.mjs'
process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(),'kier-provider-'))
const { appLink } = await import('../lib/handoff.mjs')
const { open, addItems, now } = await import('../lib/db.mjs')
const { quick } = await import('../lib/find.mjs')
const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
test('Codex models retain their provider while Claude keeps its own identity',()=>{
  for(const agent of ['Codex','Sol','Astra','GPT-6','gpt-6.1-sol']) assert.equal(aiProvider({agent}),'codex')
  assert.equal(aiProvider({agent:'Claude'}),'claude')
  assert.equal(aiProvider({provider:'codex',agent:'New model'}),'codex')
  assert.equal(aiProvider({provider:'claude',agent:'Sol'}),'claude')
  assert.equal(aiProvider({agent:'Unknown'}),null)
})
test('Codex sessions get exact app links, independent of model name',()=>{
  for(const agent of ['Codex','Sol','Astra','GPT-6']) assert.equal(appLink({agent,session:id}),`codex://threads/${id}`)
  assert.equal(codexLink({session:'../../bad?prompt=send'}),null)
  assert.equal(appLink({provider:'codex',session:'invalid'}),null)
  assert.equal(appLink({agent:'Claude',session:id}),null)
})
test('search opens a Sol or GPT session in the OpenAI desktop app rather than Claude',async t=>{
  const db=open(join(process.env.KIER_DATA_DIR,'kier.db'));t.after(()=>{db.close();rmSync(process.env.KIER_DATA_DIR,{recursive:true,force:true})})
  for(const [agent,n] of [['Sol','1'],['GPT-6','2']])addItems(db,[{id:`ai:${n}`,source:'ai',thread:`Archive migration ${n}`,sender:agent,fromMe:true,ts:now(),text:'Archive migration implementation',meta:{kind:'session',agent,session:id,cwd:'/tmp/example'}}])
  const found=await quick(db,'archive migration')
  assert.equal(found.length,2)
  for(const r of found)assert.equal(r.open.url,`codex://threads/${id}`)
})
