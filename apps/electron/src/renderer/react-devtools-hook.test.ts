import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const html = readFileSync(join(import.meta.dir, 'index.html'), 'utf8')

test('only shims the React DevTools hook in packaged builds', () => {
  expect(html).toContain("} else if (location.protocol === 'file:') {")
  expect(html).not.toContain("} else if (location.protocol === 'file:' || location.hostname === 'localhost') {")
})
