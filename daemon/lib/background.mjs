// Own the promise for an entire background loop, including failures outside its inner awaits.
export async function background(work, { report = () => {}, retry = false, pause = () => new Promise(r => setTimeout(r, 1000)) } = {}) {
  do {
    try { return await work() }
    catch { try { report('BACKGROUND_FAILED') } catch {} }
    if (retry) { try { await pause() } catch { return } }
  } while (retry)
}
