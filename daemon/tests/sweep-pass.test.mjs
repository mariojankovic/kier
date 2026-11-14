import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// sweep.py is arithmetic on a model's layers, so it needs MLX: the Python Kier installs for its own model, or one
// named in KIER_MLX_PYTHON. No weights are loaded; the model is a toy (sweep-pass.py).
const python = process.env.KIER_MLX_PYTHON || join(homedir(), 'Library/Application Support/Kier/llm/bin/python')

test('a layer-at-a-time pass says what a straight run does, shared, kept or recalled', { skip: !existsSync(python) && 'no Python with MLX on this machine' }, () => {
  const out = execFileSync(python, ['-I', '-B', new URL('./sweep-pass.py', import.meta.url).pathname], { timeout: 240000, stdio: 'pipe', encoding: 'utf8' })
  assert.match(out, /ok\s*$/)
})
