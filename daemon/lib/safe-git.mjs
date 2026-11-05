// Inspect through a disposable Git directory. The repository's config is used only
// by rev-parse (a metadata read); status/log never load it or any filter definitions.
import { execFile } from './child-process.mjs'
import { promisify } from 'node:util'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
const run = promisify(execFile)
const env = () => ({ PATH: '/usr/bin:/bin', HOME: '/dev/null', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1', GIT_LITERAL_PATHSPECS: '1' })
const options = () => ({ env: env(), timeout: 5000, maxBuffer: 2 ** 20 })
const controls = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', '-c', 'core.untrackedCache=false', '-c', 'log.showSignature=false',
  '-c', 'gpg.program=/usr/bin/false', '-c', 'gpg.ssh.program=/usr/bin/false', '-c', 'gpg.x509.program=/usr/bin/false']
export async function inspectGit(root, args) {
  const meta = async (arg) => (await run('/usr/bin/git', [...controls, '-C', root, 'rev-parse', arg], options())).stdout.trim()
  const gitdir = await meta('--absolute-git-dir')
  const common = resolve(root, await meta('--git-common-dir'))
  const format = await meta('--show-object-format')
  // The disposable refs must preserve the caller's local-branch scope.
  const refs = (await meta(args.includes('--branches') ? '--branches' : '--all')).split('\n').filter(Boolean)
  if (!['sha1', 'sha256'].includes(format)) throw Error('GIT_INSPECTION_FAILED')
  let head
  try { head = await meta('HEAD') } catch {
    // Only a genuinely unborn repository may omit HEAD.
    const raw = readFileSync(join(gitdir, 'HEAD'), 'utf8').trim()
    if (!/^ref: refs\/heads\/[A-Za-z0-9_./-]+$/.test(raw)) throw Error('GIT_INSPECTION_FAILED')
  }
  if (head && !new RegExp(`^[a-f0-9]{${format === 'sha1' ? 40 : 64}}$`).test(head)) throw Error('GIT_INSPECTION_FAILED')
  const scratch = mkdtempSync(join(tmpdir(), 'kier-git-read-'))
  try {
    mkdirSync(join(scratch, 'refs/heads'), { recursive: true })
    for (const [i, ref] of refs.entries()) {
      if (!new RegExp(`^[a-f0-9]{${format === 'sha1' ? 40 : 64}}$`).test(ref)) throw Error('GIT_INSPECTION_FAILED')
      writeFileSync(join(scratch, 'refs/heads', String(i)), ref + '\n')
    }
    mkdirSync(join(scratch, 'objects/info'), { recursive: true })
    // No repository config, hooks, includes, attribute files or executables are copied.
    writeFileSync(join(scratch, 'config'), `[core]\nrepositoryformatversion = ${format === 'sha256' ? 1 : 0}\nbare = false\n${format === 'sha256' ? '[extensions]\nobjectFormat = sha256\n' : ''}`)
    writeFileSync(join(scratch, 'HEAD'), head ? `${head}\n` : 'ref: refs/heads/unborn\n')
    const objects = join(common, 'objects')
    if (/[\r\n]/.test(objects)) throw Error('GIT_INSPECTION_FAILED')
    writeFileSync(join(scratch, 'objects/info/alternates'), objects + '\n')
    if (existsSync(join(gitdir, 'index'))) {
      // Keep the index's own times: git compares them with file times to catch edits made in the same second.
      const index = statSync(join(gitdir, 'index'))
      copyFileSync(join(gitdir, 'index'), join(scratch, 'index'))
      utimesSync(join(scratch, 'index'), index.atime, index.mtime)
    }
    return (await run('/usr/bin/git', [...controls, `--git-dir=${scratch}`, `--work-tree=${root}`, ...args], options())).stdout
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
