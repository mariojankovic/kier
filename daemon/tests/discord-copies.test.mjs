import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { discordCopy, discordMessage, reconcileDiscordCopies } from '../lib/discord-copies.mjs'
const screen = { id: 'screen', source: 'discord', thread: '#💬SAMPLE | Sample server', sender: 'Nika', from_me: 0, ts: 1000, text: '@Me add the archive page' }
const notice = { id: 'notice', source: 'notifications', thread: 'Discord', sender: '\u2068Nika\u2069 (\u2068#💬SAMPLE\u2069, \u2068Text\u2069)', from_me: 0, ts: 1015, text: '\u2068Nika\u2069 (\u2068#💬SAMPLE\u2069, \u2068Text\u2069): \u2068@Me\u2069 add the archive page' }
function fixture(t, extra = []) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  db.exec('create table items(id text primary key, source text, thread text, sender text, from_me int, ts int, text text); create table tags(item_id text primary key, is_task int, model text, confirmed int); create table task_state(item_id text primary key, status text, changed_at int, reason text, url text)')
  for (const r of [screen, notice, ...extra]) db.prepare('insert into items values (?, ?, ?, ?, ?, ?, ?)').run(r.id,r.source,r.thread,r.sender,r.from_me,r.ts,r.text)
  return db
}
test('notification wrappers and direction marks identify the same Discord message', t => {
  const db = fixture(t)
  assert.equal(discordCopy(db,notice).id,screen.id)
  assert.equal(discordMessage(notice).text,screen.text)
  assert.equal(discordMessage(notice).sender,'Nika')
  assert.equal(discordCopy(db,screen),null)
})
test('do not fold another sender, channel, time or merely similar message', t => {
  const db = fixture(t)
  for (const item of [{...notice,sender:notice.sender.replace('Nika','Tea')}, {...notice,sender:notice.sender.replace('SAMPLE','OTHER')}, {...notice,ts:2000}, {...notice,text:notice.text+' too'}]) assert.equal(discordCopy(db,item),null)
})
test('ambiguous identical channel names in different servers remain separate', t => {
  const db = fixture(t,[{...screen,id:'other-server',thread:'#💬SAMPLE | Second sample server'}])
  assert.equal(discordCopy(db,notice),null)
})
test('reconciliation preserves completion and hides only the notification copy', t => {
  const db = fixture(t)
  db.exec("insert into tags(item_id,is_task,model) values ('notice',1,'model'),('screen',1,'model'); insert into task_state values ('notice','done',1100,'marked in the timeline',null)")
  assert.equal(reconcileDiscordCopies(db),1)
  assert.equal(db.prepare("select is_task from tags where item_id='screen'").get().is_task,1)
  assert.equal(db.prepare("select is_task from tags where item_id='notice'").get().is_task,0)
  assert.equal(db.prepare("select status from task_state where item_id='screen'").get().status,'done')
  assert.equal(reconcileDiscordCopies(db),0)
})
test('wait for the richer capture to be tagged and retain its explicit choice', t => {
  const db = fixture(t)
  db.exec("insert into tags(item_id,is_task,model) values ('notice',1,'model'); insert into task_state values ('notice','done',1100,'user',null),('screen','open',1200,'user',null)")
  assert.equal(reconcileDiscordCopies(db),0)
  db.exec("insert into tags(item_id,is_task,model) values ('screen',1,'model')")
  assert.equal(reconcileDiscordCopies(db),1)
  assert.equal(db.prepare("select status from task_state where item_id='screen'").get().status,'open')
})
