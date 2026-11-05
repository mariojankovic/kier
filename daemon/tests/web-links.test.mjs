import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeLink } from '../ui/links.mjs'
test('vault links allow web and supported chats, never executable schemes', () => {
  for (const value of ['https://example.com/page?q=1', 'http://example.com', 'whatsapp://send?text=hello', 'imessage://fixture']) assert.ok(safeLink(value), value)
  for (const value of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', '\tjavascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///tmp/example', 'shell:run', '//example.com', 'https://user:secret@example.com', null]) assert.equal(safeLink(value), null)
})
