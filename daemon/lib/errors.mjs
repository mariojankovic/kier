// Error payloads from models and child processes are untrusted private content.
// Routine diagnostics expose only codes chosen by the calling boundary.
const codes = new Set(['MODEL_JSON_INVALID', 'PLANS_JSON_INVALID', 'HEADSUP_JSON_INVALID', 'BACKGROUND_FAILED', 'COLLECT_FAILED', 'COLLECT_TIMEOUT', 'COLLECT_REPORT_INVALID', 'ACCESS_REQUIRED', 'SUBPROCESS_FAILED', 'RUNTIME_INSTALL_FAILED', 'SIDECAR_OUTPUT', 'SIDECAR_STDERR', 'SIDECAR_SPAWN_FAILED'])
export function failure(code) { return new Error(codes.has(code) ? code : 'BACKGROUND_FAILED') }
export function errorRecord(code) { return { code: failure(code).message } }
export function parseModelJSON(text, code = 'MODEL_JSON_INVALID') {
  try { return JSON.parse(text) } catch { throw failure(code) }
}
export function childDiagnostics(child, log) {
  // At most one event per stream per child; never forward text or exception messages.
  child.stdout?.once('data', () => log(JSON.stringify(errorRecord('SIDECAR_OUTPUT'))))
  child.stdout?.on('data', () => {})
  child.stderr?.once('data', () => log(JSON.stringify(errorRecord('SIDECAR_STDERR'))))
  child.stderr?.on('data', () => {})
  child.on('error', () => log(JSON.stringify(errorRecord('SIDECAR_SPAWN_FAILED'))))
}
