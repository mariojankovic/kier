import { execFileSync } from './child-process.mjs'

export function notify(text) {
  const lines = text.split('\n').filter(line => line.startsWith('- '))
  const body = lines.length ? `${lines.length} things. ${lines[0].slice(2)}` : 'Nothing waiting on you.'
  execFileSync('osascript', ['-'], {
    input: `display notification ${JSON.stringify(body)} with title "Kier" subtitle "Open the timeline for the rest"`,
    stdio: ['pipe', 'ignore', 'ignore'],
  })
}
