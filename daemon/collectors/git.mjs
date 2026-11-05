import { execFileSync } from '../lib/child-process.mjs'
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { config, home } from '../lib/config.mjs'
import { inspectGit } from '../lib/safe-git.mjs'
import { addItems, now } from '../lib/db.mjs'

// Read matching commit subjects and links as advisory evidence, without collecting source code.
export const source = 'git'
const ROOTS = (config.workRoots || ['Work', 'Developer', 'Projects', 'code', 'src']).map((d) => resolve(home, d)).filter(existsSync)
const DAYS = 14

const run = (args, cwd) => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return '' }
}

function repos() {
  const found = []
  for (const root of ROOTS) {
    try {
      const out = execFileSync('find', [root, '-maxdepth', '4', '-name', '.git', '-type', 'd', '-not', '-path', '*/node_modules/*'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] })
      found.push(...out.split('\n').filter(Boolean).map((g) => g.slice(0, -'/.git'.length)))
    } catch {}
  }
  return found
}

// SSH and HTTPS GitHub remotes both become a web link to the commit.
function web(remote, sha) {
  const m = remote.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/)
  return m ? `https://github.com/${m[1]}/${m[2]}/commit/${sha}` : null
}

export async function collect(db) {
  const authors = config.gitAuthors || [run(['config', '--global', 'user.email']).trim()].filter(Boolean)
  if (!authors.length) return 0
  const since = String(now() - DAYS * 86400)
  const items = []
  for (const repo of repos()) {
    const name = basename(repo)
    const remote = run(['config', '--no-includes', '--file', resolve(repo, '.git/config'), '--get', 'remote.origin.url'], repo)
    const log = await inspectGit(repo, ['log', '--no-show-signature', '--no-ext-diff', '--no-textconv', '--branches', `--since=${since}`, ...authors.map((a) => `--author=${a}`), '--format=%H%x1f%ct%x1f%s']).catch(() => '')
    for (const line of log.split('\n').filter(Boolean)) {
      const [sha, ts, subject] = line.split('\x1f')
      items.push({
        id: `${source}:${name}:${sha.slice(0, 12)}`, source, thread: name, sender: config.me, fromMe: true, ts: Number(ts),
        text: subject, url: web(remote, sha),
      })
    }
  }
  return addItems(db, items)
}
