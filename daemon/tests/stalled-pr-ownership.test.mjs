import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-pr-ownership-'))
after(() => rmSync(process.env.KIER_DATA_DIR, { recursive: true, force: true }))
const { open, addItems, now } = await import('../lib/db.mjs')
const { checkStalled, pullOwnership } = await import('../lib/stalled.mjs')
const url = 'https://github.com/example/site/pull/42'
const pr = { number: 42, title: 'Add an archive guide', state: 'open', draft: true,
  user: { login: 'teammate' }, assignees: [], requested_reviewers: [] }
const github = value => ({ pull: async () => value, viewer: async () => 'owner' })
function vault(t) { const db = open(':memory:'); t.after(() => db.close()); return db }
function session(db, agent = 'Claude') {
  addItems(db, [{ id: `session:${agent}`, source: 'ai', thread: 'site', sender: agent, ts: now() - 4 * 3600,
    text: 'Reviewed some copy fixes', meta: { kind: 'session', session: `session-${agent}`, cwd: homedir(), agent,
      provider: agent === 'Claude' ? 'claude' : 'codex', model: agent === 'Claude' ? 'opus' : 'gpt-test', human: true, edits: [], prs: [url] } }])
}
const tasks = db => db.prepare("select i.id, i.meta, t.is_task, t.model, s.status from items i join tags t on t.item_id=i.id left join task_state s on s.item_id=i.id where t.card='stalled'").all()
function oldCard(db, id, { status, confirmed } = {}) {
  addItems(db, [{ id, source: 'ai', thread: 'site', sender: 'Codex', ts: now() - 3600, text: 'Pick up PR', meta: { kind: 'stalled', pr: url } }])
  db.prepare("insert into tags(item_id,is_task,summary,model,tagged_at,card,confirmed) values (?,1,'Pick up PR','rule',?,'stalled',?)").run(id,now()-3600,confirmed ?? null)
  if (status) db.prepare("insert into task_state(item_id,status,changed_at,reason) values (?,?,?,'owner choice')").run(id,status,now()-1800)
}

test('only author, assignee or direct requested reviewer establishes PR ownership', () => {
  assert.equal(pullOwnership(pr,'owner'),false)
  assert.equal(pullOwnership({...pr,user:{login:'OWNER'}},'owner'),true)
  assert.equal(pullOwnership({...pr,assignees:[{login:'owner'}]},'owner'),true)
  assert.equal(pullOwnership({...pr,requested_reviewers:[{login:'owner'}]},'owner'),true)
  assert.equal(pullOwnership({...pr,requested_teams:[{slug:'everyone'}]},'owner'),false)
  assert.equal(pullOwnership(pr,null),null)
  assert.equal(pullOwnership(null,'owner'),null)
  assert.equal(pullOwnership({state:'open'},'owner'),null)
})

test('a PR merely mentioned in either Claude or Codex output makes no owner task', async t => {
  for (const agent of ['Claude','Sol']) {
    const db = vault(t); session(db,agent)
    await checkStalled(db,{github:github(pr)})
    assert.equal(tasks(db).length,0,agent)
  }
})

test('owned PRs make cards for both providers and retain session identity', async t => {
  for (const agent of ['Claude','Sol']) {
    const db = vault(t); session(db,agent)
    await checkStalled(db,{github:github({...pr,user:{login:'owner'}})})
    const [card] = tasks(db)
    assert.equal(card.is_task,1)
    const meta = JSON.parse(card.meta)
    assert.equal(meta.agent,agent)
    assert.equal(meta.provider,agent==='Claude'?'claude':'codex')
    assert.equal(meta.model,agent==='Claude'?'opus':'gpt-test')
  }
})

test('reconciliation hides false closed cards while preserving state and explicit ownership', async t => {
  const db = vault(t)
  oldCard(db,'unclaimed')
  for (const status of ['done','dismissed','open','snoozed']) oldCard(db,status,{status})
  oldCard(db,'mine',{confirmed:1})
  const before = db.prepare('select * from task_state order by item_id').all()
  const result = await checkStalled(db,{github:github(pr)})
  assert.equal(result.excluded,3)
  for (const id of ['unclaimed','done','dismissed']) assert.equal(tasks(db).find(t=>t.id===id).is_task,0,id)
  for (const id of ['open','snoozed','mine']) assert.equal(tasks(db).find(t=>t.id===id).is_task,1,id)
  assert.deepEqual(db.prepare('select * from task_state order by item_id').all(),before, 'completion and dismissal records remain unchanged')
})

test('a failed account or PR lookup cannot create or remove a card', async t => {
  for (const api of [{pull:async()=>null,viewer:async()=> 'owner'}, {pull:async()=>pr,viewer:async()=>null}]) {
    const db = vault(t); session(db); oldCard(db,'existing')
    const result=await checkStalled(db,{github:api})
    assert.equal(result.excluded,0)
    assert.equal(tasks(db).length,1)
    assert.equal(tasks(db)[0].is_task,1)
  }
})

test('a newly assigned PR can return after ownership previously removed the automatic card', async t => {
  const db = vault(t); session(db,'Sol')
  await checkStalled(db,{github:github({...pr,assignees:[{login:'owner'}]})})
  await checkStalled(db,{github:github(pr)})
  assert.equal(tasks(db)[0].is_task,0)
  await checkStalled(db,{github:github({...pr,requested_reviewers:[{login:'owner'}]})})
  assert.equal(tasks(db).length,1)
  assert.equal(tasks(db)[0].is_task,1)
  assert.equal(tasks(db)[0].model,'rule')
})
