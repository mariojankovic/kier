// Strip comments from packaged JavaScript. The published source keeps engineering notes.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const transpiler = new Bun.Transpiler({ loader: 'js', target: 'node', trimUnusedImports: false })
let files = 0
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (name === 'node_modules') continue
    if (statSync(path).isDirectory()) walk(path)
    else if (name.endsWith('.mjs')) {
      const src = readFileSync(path, 'utf8')
      // A shebang isn't JavaScript; it goes back on top.
      const bang = src.startsWith('#!') ? src.slice(0, src.indexOf('\n') + 1) : ''
      writeFileSync(path, bang + transpiler.transformSync(bang ? src.slice(bang.length) : src))
      files++
    }
  }
}
walk(process.argv[2])
console.log(`${files} files without comments`)
