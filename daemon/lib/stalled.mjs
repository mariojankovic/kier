import { inspectGit } from './safe-git.mjs'
// Work an AI session left unfinished: a pull request still open, or changes never committed, once the session has been
// quiet a few hours. A card says what and which session, and closes itself when the PR is merged or closed or the
// changes are committed. Only for people who use Claude Code or Codex with git (and GitHub's gh for pull requests);
// without them nothing is found and nothing shows.
import { execFile } from './child-process.mjs'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, dirname, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { config, dataDir } from './config.mjs'
import { addItems, now } from './db.mjs'

const run = promisify(execFile)
const QUIET = 3 * 3600
// Like a request from someone else, it stays in the brief for three days and then lets go.
const DAYS = 3
const FRESH = 30 * 60
const looked = new Map()
const key = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16)
const metaOf = (x) => { try { return JSON.parse(x.meta || '{}') } catch { return {} } }
const files = (n) => `${n} changed file${n === 1 ? '' : 's'}`

// A pull request as GitHub has it now, looked up at most every half hour unless asked to look now.
async function pull(url, fresh) {
  const hit = looked.get(url)
  if (hit && !fresh && now() - hit.at < FRESH) return hit.pr
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  // GitHub is an online helper: with helpers off, open pull requests go unnoticed; uncommitted changes still count.
  if (!config.online) return null
  const pr = m ? await run('gh', ['api', `repos/${m[1]}/${m[2]}/pulls/${m[3]}`], { timeout: 15000 }).then((r) => JSON.parse(r.stdout)).catch(() => null) : null
  looked.set(url, { at: now(), pr })
  return pr
}

// The account gh is signed into, rather than the Mac's name or a session's model name.
let account
async function viewer(fresh) {
  if (!config.online) return null
  if (account && !fresh && now() - account.at < FRESH) return account.login
  const login = await run('gh', ['api', 'user', '--jq', '.login'], { timeout: 15000 })
    .then(r => r.stdout.trim() || null).catch(() => null)
  account = { at: now(), login }
  return login
}

// Seeing a PR URL in a transcript does not assign it to the owner. Only GitHub's
// author, assignee or direct review request is evidence. Unknown metadata cannot
// create a task, and cannot revoke an existing task either.
export function pullOwnership(pr, login) {
  if (!pr || !login) return null
  const me = String(login).toLowerCase()
  const mine = user => String(user?.login || '').toLowerCase() === me
  if (mine(pr.user) || pr.assignees?.some(mine) || pr.requested_reviewers?.some(mine)) return true
  if (!pr.user?.login || !Array.isArray(pr.assignees) || !Array.isArray(pr.requested_reviewers)) return null
  return false
}

// The repository a file is in: the nearest folder above it with.git (a file, in a worktree).
const roots = new Map()
function repoOf(file) {
  const start = dirname(file)
  if (roots.has(start)) return roots.get(start)
  let d = start
  while (d !== dirname(d) && !existsSync(resolve(d, '.git'))) d = dirname(d)
  const root = d === dirname(d) ? null : d
  roots.set(start, root)
  return root
}

// Which of these files still differ from the last commit (new ones included), as paths; null when the repository is gone. Only
// files the session wrote count, so a checkout that was already untidy isn't blamed on whoever worked there last.
async function changed(root, files) {
  if (!existsSync(resolve(root, '.git'))) return null
  return inspectGit(root, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all', '--', ...files.map((f) => relative(root, f))])
    .then((out) => out.split('\0').filter(Boolean).map((l) => l.slice(3))).catch(() => undefined)
}

// Failure means unknown, never a clean checkout or a completed task.
const committed = (root, files, since) => inspectGit(root, ['log', '-1', `--since=@${since}`, '--format=%h', '--', ...files.map((f) => relative(root, f))])
  .then((out) => !!out.trim()).catch(() => false)
const scratch = (path) => path.startsWith(dataDir) || /^(\/private)?\/tmp\/|\/var\/folders\//.test(path)

export async function checkStalled(db, { fresh = false, github = {} } = {}) {
  const getPull = github.pull || pull
  const getViewer = github.viewer || viewer
  let identity
  const owner = () => identity ||= Promise.resolve(getViewer(fresh))
  // Each session's latest day; scratch runs in temporary folders and Kier's own don't count.
  const latest = new Map()
  for (const s of db.prepare("select thread, sender, ts, meta from items where source = 'ai' and json_extract(meta, '$.kind') = 'session' and ts > ? order by ts desc")
    .all(now() - DAYS * 86400)) {
    const m = metaOf(s)
    if (!m.session || latest.has(m.session) || !m.cwd || scratch(m.cwd)) continue
    latest.set(m.session, { ...s, m, at: m.at || s.ts })
  }
  const sessions = [...latest.values()]
  const quiet = sessions.filter((s) => now() - s.at > QUIET)
  // What a session still running is touching is being worked on.
  const busy = sessions.filter((s) => now() - s.at <= QUIET)
  const busyPrs = new Set(busy.flatMap((s) => s.m.prs || []))
  // A file belongs to the last session that wrote it.
  const taken = new Set(busy.flatMap((s) => s.m.edits || []))
  const busyRepos = new Set(busy.flatMap((s) => [s.m.cwd, ...(s.m.edits || [])].map(repoOf)).filter(Boolean))
  const items = []
  const tags = []
  // The card carries its session, so the item page shows what you asked and where it stopped, and Continue opens it.
  const card = (id, s, text, url, summary, meta) => {
    items.push({ id, source: 'ai', thread: s.thread, sender: s.m.agent || s.sender, fromMe: false, ts: Math.floor(s.at), text, url,
      meta: { kind: 'stalled', session: s.m.session, agent: s.m.agent || s.sender, provider: s.m.provider, model: s.m.model, app: s.m.app, cwd: s.m.cwd, request: s.m.request, said: s.m.latest, ...meta } })
    tags.push([id, summary])
  }
  const seen = new Set()
  for (const s of quiet) {
    for (const url of s.m.prs || []) {
      if (seen.has(url) || busyPrs.has(url)) continue
      seen.add(url)
      const pr = await getPull(url, fresh)
      if (pullOwnership(pr, await owner()) !== true) continue
      if (pr?.state !== 'open') continue
      card(`ai:stalled:${key(url)}`, s, `${s.thread} left PR #${pr.number} "${pr.title}" open`, url,
        `Pick up PR #${pr.number} “${pr.title}” (still open${pr.draft ? ', a draft' : ''})`, { pr: url })
    }
  }
  // Keep dismissed uncommitted work closed until a new commit changes its state.
  // Another session touching the same files must not resurrect it.
  const settled = new Map()
  for (const c of db.prepare(`select i.meta, s.changed_at from items i join task_state s on s.item_id = i.id join tags t on t.item_id = i.id
      where i.source = 'ai' and t.card = 'stalled' and s.status in ('done', 'dismissed') and s.changed_at > ?`).all(now() - 30 * 86400)) {
    const m = metaOf(c)
    if (!m.repo || !m.files?.length || await committed(m.repo, m.files, c.changed_at)) continue
    settled.set(m.repo, new Set([...(settled.get(m.repo) || []), ...m.files]))
  }
  // Changes only from sessions you talked to: a scheduled run that rewrites its own log every day left nothing behind.
  for (const s of quiet) {
    const mine = (s.m.edits || []).filter((f) => !taken.has(f) && !scratch(f))
    mine.forEach((f) => taken.add(f))
    if (!s.m.human) continue
    const byRepo = new Map()
    for (const f of mine) {
      const root = repoOf(f)
      if (root && !busyRepos.has(root) && !settled.get(root)?.has(f)) byRepo.set(root, [...(byRepo.get(root) || []), f])
    }
    for (const [root, list] of byRepo) {
      const dirty = (await changed(root, list)) || []
      // Named, so the card says which: "06-final.md", not just "1 changed file".
      const names = `${dirty.slice(0, 2).map((f) => basename(f)).join(', ')}${dirty.length > 2 ? ` and ${dirty.length - 2} more` : ''}`
      if (dirty?.length) card(`ai:stalled:repo:${key(`${s.m.session}|${root}`)}`, s, `${s.thread} left ${files(dirty.length)} uncommitted in ${root}: ${dirty.join(', ')}`, null,
        `Commit or discard ${dirty.length === 1 ? names : `${files(dirty.length)} (${names})`} in ${basename(root)}`, { repo: root, files: list })
    }
  }
  const added = addItems(db, items)
  // The count of changed files moves as you work, so the line follows it.
  const tag = db.prepare(`insert into tags (item_id, is_task, due, when_words, amount, urgency, summary, model, tagged_at, second, card)
    values (?, 1, '', '', '', 1, ?, 'rule', ?, 1, 'stalled') on conflict(item_id) do update set summary = excluded.summary,
      is_task = case when tags.model = 'not-my-pr' then 1 else tags.is_task end,
      model = case when tags.model = 'not-my-pr' then 'rule' else tags.model end where tags.card = 'stalled'`)
  for (const [id, summary] of tags) tag.run(id, summary, now())

  // Earlier cards close themselves once the PR is merged or closed, or the changes are committed.
  const done = db.prepare(`insert into task_state (item_id, status, changed_at, reason, url) values (?, 'handled', ?, ?, ?) on conflict(item_id) do nothing`)
  // Reconcile cards created before ownership was checked, including false cards the
  // owner closed just to clear them. Keep those state records; Mine and explicit
  // open/snoozed choices establish ownership. Failed lookups leave everything alone.
  const exclude = db.prepare("update tags set is_task = 0, model = 'not-my-pr' where item_id = ?")
  let excluded = 0
  for (const c of db.prepare(`select i.id, i.meta from items i join tags t on t.item_id = i.id
    left join task_state s on s.item_id = i.id where i.source = 'ai' and t.card = 'stalled'
    and t.is_task = 1 and t.confirmed is null
    and (s.item_id is null or s.status in ('done', 'dismissed', 'handled'))`).all()) {
    const m = metaOf(c)
    if (!m.pr) continue
    if (pullOwnership(await getPull(m.pr, fresh), await owner()) === false) { exclude.run(c.id); excluded++ }
  }
  let closed = 0
  for (const c of db.prepare(`select i.id, i.meta, t.tagged_at made from items i join tags t on t.item_id = i.id left join task_state s on s.item_id = i.id
    where i.source = 'ai' and t.card = 'stalled' and t.is_task = 1 and s.item_id is null`).all()) {
    const m = metaOf(c)
    let why = null
    if (m.pr) {
      const pr = await getPull(m.pr, fresh)
      if (pr && pr.state !== 'open') why = `PR #${pr.number} ${pr.merged_at ? 'merged' : 'closed'}`
    } else if (m.repo && m.files?.length) {
      const dirty = await changed(m.repo, m.files)
      if (dirty?.length === 0) why = (await committed(m.repo, m.files, c.made)) ? `Committed in ${basename(m.repo)}` : `Changes in ${basename(m.repo)} put back`
      else if (dirty === null) why = `${basename(m.repo)} was removed`
    }
    if (why) { done.run(c.id, now(), why, m.pr || null); closed++ }
  }
  return { stalled: added, closed, excluded }
}
