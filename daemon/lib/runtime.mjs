import { childDiagnostics, failure, errorRecord } from './errors.mjs'
import { sockets } from './sidecar-client.mjs'
import { sidecarToken } from './sidecar-auth.mjs'
// Kier's own local model runtime (sidecar/llm_server.py: Qwen 3.5 9B in MLX), used instead of Ollama once it's
// installed (config.mjs). It answers the same /api/chat on its own private socket, so every caller stays as it is. The process
// stays up and small; the weights load on demand and leave after keep_alive.
//
// Setup installs it (installRuntime): a standalone Python, the packages in sidecar/llm-requirements.txt (exact versions,
// checked against their hashes), and the model at a fixed revision. Nothing else needs installing, Ollama included.
import { execFile, managedSpawn as spawn } from './child-process.mjs'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config, dataDir, mlxReady, tmpDir, usesMlx } from './config.mjs'

// Run semantic search in a separate process and socket so background tagging cannot block it.
export const MLX = { python: resolve(dataDir, 'llm/bin/python'), model: resolve(dataDir, 'models/qwen3.5-9b-4bit'), socket: sockets.llm, searchSocket: sockets.embed }
export const mlxInstalled = mlxReady
const SCRIPT = resolve(new URL('../sidecar/llm_server.py', import.meta.url).pathname)
const SIDECAR = resolve(new URL('../sidecar', import.meta.url).pathname)
const REQUIREMENTS = resolve(new URL('../sidecar/llm-requirements.txt', import.meta.url).pathname)
// python-build-standalone's CPython for Apple Silicon, the build of Oct 26 2026.
const PYTHON = {
  url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.12.16%2B20261026-aarch64-apple-darwin-install_only.tar.gz',
  sha256: 'fbf4afef53c2a6b72bb741bc06d5671a9dfaf87bd84e5aa73ac9b3d0d589f14e',
  dir: resolve(dataDir, 'llm-python'),
}
const MODEL = { repo: 'mlx-community/Qwen3.5-9B-4bit', revision: '8b2b98c00a6b4d291155e4890773ca8f769aee53', bytes: 5.98e9 }
// Search by meaning: EmbeddingGemma 2 (Apache 2.0) comes with its image and audio encoders (1.1 GB); only its text
// part is kept (185 MB, sidecar/embedder.py prepare), and the download goes once that's saved.
export const EMBED = { dir: resolve(dataDir, 'models/embeddinggemma-2-text'), repo: 'mlx-community/embeddinggemma-2-4bit', revision: '8ab839e127cb8cb305edd71fb7a02c82f2d49ab3', bytes: 1.1e9 }
export const embedReady = () => existsSync(resolve(EMBED.dir, '.kier-ready'))
const EMBED_DOWNLOAD = resolve(tmpDir, 'embeddinggemma-2')

const children = {}
let log = () => {}
let hooked = false

// Started with the daemon, the model and search each in its own process, and each again a few seconds after it stops.
export function startRuntime(logTo) {
  if (logTo) log = logTo
  if (!existsSync(MLX.python)) return
  if (usesMlx) part('local model', [MLX.model, MLX.socket])
  if (embedReady()) part('search model', ['-', MLX.searchSocket])
  if (hooked) return
  hooked = true
  const stop = () => Object.values(children).forEach((c) => c?.kill())
  process.once('exit', stop)
  process.once('SIGTERM', () => { stop(); process.exit(0) })
}

function part(name, args) {
  if (children[name]) return
  const child = spawn(MLX.python, ['-I', '-E', SCRIPT, ...args], {
    env: { KIER_SIDECAR_TOKEN: sidecarToken(), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false', KIER_MODEL_NAME: config.model, KIER_EMBED_MODEL: EMBED.dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children[name] = child
  childDiagnostics(child, log)
  child.on('exit', (code) => {
    log(`${name} stopped (${code})`)
    children[name] = null
    setTimeout(() => part(name, args), 5000).unref()
  })
}

// Where the install is, for the setup step: which part, how far the model has come, and what went wrong.
export const installing = { phase: null, error: null, secondError: null }
export function installProgress() {
  if (installing.phase === 'embed') return Math.min(99, Math.round((size(EMBED_DOWNLOAD) / EMBED.bytes) * 100))
  if (installing.phase === 'second') return Math.min(99, Math.round((size(D1.model) / D1.bytes) * 100))
  if (installing.phase !== 'model') return null
  return Math.min(99, Math.round((size(MLX.model) / MODEL.bytes) * 100))
}

function size(dir) {
  let total = 0
  try {
    for (const name of readdirSync(dir)) {
      const p = resolve(dir, name)
      const s = statSync(p)
      total += s.isDirectory() ? size(p) : s.size
    }
  } catch {}
  return total
}

export const runtimeCommand = (cmd, args, opts = {}) => new Promise((done, fail) => execFile(cmd, args, { timeout: 60 * 60_000, maxBuffer: 1 << 24, ...opts }, (e, out, err) => {
  if (e) fail(failure('SUBPROCESS_FAILED'))
  else done(out)
}))

async function download(url, file, sha256) {
  const res = await fetch(url)
  if (!res.ok) throw Error(`the Python download failed (${res.status})`)
  const hash = createHash('sha256')
  const out = createWriteStream(file)
  for await (const chunk of res.body) {
    hash.update(chunk)
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
  }
  await new Promise((done, fail) => out.end((e) => (e ? fail(e) : done())))
  if (hash.digest('hex') !== sha256) {
    rmSync(file, { force: true })
    throw Error('the Python download failed its checksum')
  }
}

// The search model on its own, for a Kier that already runs its own model (Setup's "Search by meaning"). The runtime
// loads it on the first search, so nothing restarts.
async function fetchEmbedder() {
  if (embedReady()) return
  installing.phase = 'embed'
  await runtimeCommand(MLX.python, ['-I', '-E', '-c', `from huggingface_hub import snapshot_download; snapshot_download(${JSON.stringify(EMBED.repo)}, revision=${JSON.stringify(EMBED.revision)}, local_dir=${JSON.stringify(EMBED_DOWNLOAD)})`],
    { env: { HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_PROGRESS_BARS: '1' } })
  await runtimeCommand(MLX.python, ['-I', '-E', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(SIDECAR)}); import embedder; embedder.prepare(${JSON.stringify(EMBED_DOWNLOAD)}, ${JSON.stringify(EMBED.dir)})`])
  writeFileSync(resolve(EMBED.dir, '.kier-ready'), EMBED.revision)
  rmSync(EMBED_DOWNLOAD, { recursive: true, force: true })
}

export async function installEmbedder() {
  if (installing.phase) return
  installing.error = null
  try {
    await fetchEmbedder()
    installing.phase = null
    log('search by meaning installed')
  } catch (e) {
    installing.phase = null
    installing.error = 'RUNTIME_INSTALL_FAILED'
    log(JSON.stringify(errorRecord('RUNTIME_INSTALL_FAILED')))
  }
}

// Kier's own Python, which every install builds its environment from.
async function standalonePython() {
  if (existsSync(resolve(PYTHON.dir, 'bin/python3'))) return
  installing.phase = 'python'
  const tar = resolve(tmpDir, 'kier-python.tar.gz')
  await download(PYTHON.url, tar, PYTHON.sha256)
  rmSync(PYTHON.dir, { recursive: true, force: true })
  mkdirSync(PYTHON.dir, { recursive: true })
  await runtimeCommand('tar', ['-xzf', tar, '-C', PYTHON.dir, '--strip-components=1'])
  rmSync(tar, { force: true })
}

// Install the optional second-opinion model in its own Python environment.
// Skip completed steps so a retry resumes an interrupted installation.
export const D1 = { repo: 'LiquidAI/d1-2B', revision: 'cfe5760ff5d5998f91d9ac56bd4b2dbd96996d41', bytes: 3.85e9, env: resolve(dataDir, 'py'), model: resolve(dataDir, 'models/d1-2B') }
const D1_REQUIREMENTS = resolve(new URL('../sidecar/d1-requirements.txt', import.meta.url).pathname)

export async function installSecond() {
  if (installing.phase) return
  installing.secondError = null
  try {
    await standalonePython()
    installing.phase = 'second-packages'
    const py = resolve(D1.env, 'bin/python')
    if (!existsSync(py)) await runtimeCommand(resolve(PYTHON.dir, 'bin/python3'), ['-I', '-E', '-m', 'venv', D1.env])
    await runtimeCommand(py, ['-I', '-E', '-m', 'ensurepip', '--default-pip'])
    await runtimeCommand(py, ['-I', '-E', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--only-binary', ':all:', '--require-hashes', '-r', D1_REQUIREMENTS])
    installing.phase = 'second'
    await runtimeCommand(py, ['-I', '-E', '-c', `from huggingface_hub import snapshot_download; snapshot_download(${JSON.stringify(D1.repo)}, revision=${JSON.stringify(D1.revision)}, local_dir=${JSON.stringify(D1.model)})`],
      { env: { HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_PROGRESS_BARS: '1' } })
    installing.phase = null
    log('second opinion installed')
  } catch (e) {
    installing.phase = null
    installing.secondError = 'RUNTIME_INSTALL_FAILED'
    log(JSON.stringify(errorRecord('RUNTIME_INSTALL_FAILED')))
  }
}

// Each part is skipped when it's already there, so a stopped install picks up where it left off.
export async function installRuntime() {
  if (installing.phase) return
  installing.error = null
  try {
    if (!existsSync(MLX.python)) {
      await standalonePython()
      installing.phase = 'packages'
      await runtimeCommand(resolve(PYTHON.dir, 'bin/python3'), ['-I', '-E', '-m', 'venv', resolve(dataDir, 'llm')])
    }
    installing.phase = 'packages'
    await runtimeCommand(MLX.python, ['-I', '-E', '-m', 'ensurepip', '--default-pip'])
    await runtimeCommand(MLX.python, ['-I', '-E', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--only-binary', ':all:', '--require-hashes', '-r', REQUIREMENTS])
    installing.phase = 'model'
    await runtimeCommand(MLX.python, ['-I', '-E', '-c', `from huggingface_hub import snapshot_download; snapshot_download(${JSON.stringify(MODEL.repo)}, revision=${JSON.stringify(MODEL.revision)}, local_dir=${JSON.stringify(MLX.model)})`],
      { env: { HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_PROGRESS_BARS: '1' } })
    writeFileSync(resolve(MLX.model, '.kier-ready'), MODEL.revision)
    await fetchEmbedder()
    installing.phase = null
    // The daemon picks its runtime as it starts (config.mjs): it quits, and the login agent starts it again on this one.
    log('local model installed; restarting on it')
    setTimeout(() => process.exit(0), 1000)
  } catch (e) {
    installing.phase = null
    installing.error = 'RUNTIME_INSTALL_FAILED'
    log(JSON.stringify(errorRecord('RUNTIME_INSTALL_FAILED')))
  }
}
