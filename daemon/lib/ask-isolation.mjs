// A policy is not an enforcement mechanism. Until the Codex runner can attest an
// exact global tool allowlist, Ask refuses to launch it, even after clean discovery.
import { execFile } from './child-process.mjs'
import { promisify } from 'node:util'
import { chmodSync, constants, closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
export const READ_TOOLS = Object.freeze(['kier_brief', 'kier_tasks', 'kier_search', 'kier_day', 'kier_item'])
export const CODEX_UNAVAILABLE = 'Codex Ask is unavailable because this version cannot limit its access to Kier. Use Claude or Kier instead.'
const run = promisify(execFile)
export function isolatedAskConfig(parent, { node, mcp, dataDir, authFile }) {
  const root = mkdtempSync(resolve(parent, 'ask-isolated-'))
  try {
    chmodSync(root, 0o700)
    for (const name of ['home', 'config', 'work', 'tmp']) mkdirSync(resolve(root, name), { mode: 0o700 })
    const env = { PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: resolve(root, 'home'), CODEX_HOME: resolve(root, 'config'), XDG_CONFIG_HOME: resolve(root, 'config'), TMPDIR: resolve(root, 'tmp') }
    if (authFile) {
      const fd = openSync(authFile, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = fstatSync(fd)
        if (!info.isFile() || info.uid !== process.getuid() || info.size > 1024 * 1024) throw Error('ASK_LOGIN_INVALID')
        writeFileSync(resolve(env.CODEX_HOME, 'auth.json'), readFileSync(fd), { mode: 0o600, flag: 'wx' })
      } finally { closeSync(fd) }
    }
    const server = { command: node, args: ['--disable-warning=ExperimentalWarning', mcp], env: { KIER_DATA_DIR: dataDir, KIER_CLIENT: 'codex', KIER_MCP_ROLE: 'read-only' }, enabled_tools: [...READ_TOOLS] }
    const q = JSON.stringify
    const config = `approval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\nproject_doc_max_bytes = 0\ncheck_for_update_on_startup = false\n[features]\nshell_tool = false\nunified_exec = false\nview_image = false\napps = false\nplugins = false\nhooks = false\nmemories = false\nmulti_agent = false\ncode_mode = false\ncode_mode_host = false\ncomputer_use = false\nbrowser_use = false\n[tools.update_plan]\nenabled = false\n[mcp_servers.kier]\ncommand = ${q(server.command)}\nargs = ${q(server.args)}\nenabled_tools = ${q(server.enabled_tools)}\nrequired = true\n[mcp_servers.kier.env]\n${Object.entries(server.env).map(([k,v]) => `${k} = ${q(v)}`).join('\n')}\n`
    writeFileSync(resolve(env.CODEX_HOME, 'config.toml'), config, { mode: 0o600 })
    return { root, env, cwd: resolve(root, 'work'), server, cleanup: () => rmSync(root, { recursive: true, force: true }) }
  } catch { rmSync(root, { recursive: true, force: true }); throw Error('ASK_ISOLATION_FAILED') }
}
export function validateDiscovery(raw, expected) {
  let servers
  try { servers = JSON.parse(raw) } catch { throw Error('ASK_DISCOVERY_FAILED') }
  if (!Array.isArray(servers) || servers.length !== 1 || servers[0].name !== 'kier' || servers[0].enabled !== true ||
    servers[0].transport?.command !== expected.command || JSON.stringify(servers[0].transport?.args) !== JSON.stringify(expected.args) ||
    servers[0].transport?.env?.KIER_MCP_ROLE !== 'read-only') throw Error('ASK_DISCOVERY_FAILED')
}
export async function codexPreflight(binary, parent, options, probe = run) {
  let isolation
  try {
    isolation = isolatedAskConfig(parent, options)
    let result
    try { result = await probe(binary, ['mcp', 'list', '--json'], { env: isolation.env, cwd: isolation.cwd, timeout: 15000, maxBuffer: 64 * 1024 }) }
    catch { throw Error('ASK_DISCOVERY_FAILED') }
    validateDiscovery(result.stdout, isolation.server)
    // The supported CLI interface has no verifiable global tool allowlist. Do not
    // infer safety from flags, prompt instructions, or MCP readOnlyHint annotations.
    throw Error('ASK_TOOLS_ONLY_UNAVAILABLE')
  } finally { isolation?.cleanup() }
}
