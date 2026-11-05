import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-plans-context-'))
after(() => rmSync(process.env.KIER_DATA_DIR, { recursive: true, force: true }))
const { open, addItems, now } = await import('../lib/db.mjs')
const { config } = await import('../lib/config.mjs')
const { read } = await import('../lib/plans.mjs')
const AT = now() - 1800
function vault(t) { const db = open(':memory:'); t.after(() => db.close()); return db }
function message(db, id, text, { ts = AT, owner = false, thread = 'Nika', group = false } = {}) {
  addItems(db, [{ id, source: 'whatsapp', thread, sender: owner ? config.me : 'Nika', fromMe: owner, ts, text, meta: { group } }])
  return db.prepare('select * from items where id = ?').get(id)
}
function model(t, answer) {
  const previous = globalThis.fetch, calls = []
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body)
    const content = typeof answer === 'function' ? answer(body, calls.length) : answer
    return { ok: true, json: async () => ({ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }) }
  }
  t.after(() => { globalThis.fetch = previous }); return calls
}

const { modelFixture } = await import('./model-fixture.mjs')
await modelFixture({ decision: false })

test('same-second earlier owner turns are context, but later rows cannot supply a plan', async t => {
  const db=vault(t)
  message(db,'earlier','When does the puzzle club open?',{owner:true,ts:AT})
  const item=message(db,'current','It opens at 13:20.',{ts:AT})
  message(db,'later','Unrelated future walk tomorrow at 09:10.',{owner:true,ts:AT})
  const calls=model(t,{plan:false,owner:'',when:'',start:'',what:''})
  await read(db,item)
  assert.match(calls[0].messages[1].content,/When does the puzzle club open/)
  assert.doesNotMatch(calls[0].messages[1].content,/Unrelated future walk/)
})
