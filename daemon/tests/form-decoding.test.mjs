import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// form.py is arithmetic on the model's output, so it needs MLX: the Python Kier installs for its own model, or one
// named in KIER_MLX_PYTHON. No weights are loaded; the "model" is a script (form-decoding.py).
const python = process.env.KIER_MLX_PYTHON || join(homedir(), 'Library/Application Support/Kier/llm/bin/python')

test('a form comes out well-formed, with probabilities that add up', { skip: !existsSync(python) && 'no Python with MLX on this machine' }, () => {
  const out = execFileSync(python, ['-I', '-B', new URL('./form-decoding.py', import.meta.url).pathname], { timeout: 240000, stdio: 'pipe', encoding: 'utf8' })
  assert.match(out, /ok\s*$/)
})
