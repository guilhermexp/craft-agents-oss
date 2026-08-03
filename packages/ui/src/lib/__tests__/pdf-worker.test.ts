import { describe, expect, it } from 'bun:test'
import { Glob } from 'bun'

const UI_ROOT = new URL('../..', import.meta.url).pathname
const REPO_ROOT = new URL('../../../../..', import.meta.url).pathname

describe('pdf worker ownership', () => {
  it('keeps the worker url and workerSrc assignment in one module', async () => {
    // GlobalWorkerOptions.workerSrc is a single global slot on react-pdf's
    // pdfjs. A second writer silently wins for the whole renderer, and if its
    // bare `pdfjs-dist` specifier hoists to another major the app throws
    // "API version does not match Worker version" at render time.
    const offenders: string[] = []

    for (const dir of [`${UI_ROOT}`, `${REPO_ROOT}apps/electron/src`]) {
      for await (const file of new Glob('**/*.{ts,tsx}').scan({ cwd: dir, absolute: true })) {
        if (file.includes('/__tests__/')) continue
        if (file.endsWith('.d.ts')) continue
        if (file.endsWith('/lib/pdf-worker.ts')) continue
        const source = await Bun.file(file).text()
        if (source.includes('GlobalWorkerOptions') || source.includes('pdf.worker.min.mjs')) {
          offenders.push(file.replace(REPO_ROOT, ''))
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('resolves the worker from the same pdfjs-dist copy react-pdf uses', async () => {
    // react-pdf depends on an exact pdfjs-dist version, so it resolves a
    // nested copy. The worker must come from that same copy, not a hoisted
    // sibling on a different major.
    const reactPdfManifest = await Bun.file(`${REPO_ROOT}node_modules/react-pdf/package.json`).json()
    const requiredVersion = reactPdfManifest.dependencies?.['pdfjs-dist']
    expect(typeof requiredVersion).toBe('string')

    const workerCopy = Bun.resolveSync('pdfjs-dist/package.json', `${UI_ROOT}lib`)
    const workerVersion = (await Bun.file(workerCopy).json()).version

    expect(workerVersion).toBe(requiredVersion)
  })
})
