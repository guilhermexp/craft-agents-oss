/**
 * pdf.js worker configuration — single owner.
 *
 * `pdfjs.GlobalWorkerOptions.workerSrc` is one global slot on react-pdf's
 * pdfjs instance, so the last writer wins for the whole renderer. It is set
 * here, and only here.
 *
 * The worker URL must come from the same pdfjs-dist copy react-pdf's API does.
 * react-pdf pins an exact peer, so it resolves a nested copy inside this
 * package; a bare `pdfjs-dist` specifier from any other package can hoist to a
 * different major and produce "API version does not match Worker version" at
 * runtime. Importing it from here keeps resolution next to react-pdf's own.
 */

import { pdfjs } from 'react-pdf'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker

/**
 * Document options shared by every pdf surface.
 *
 * pdf.js reaches for eval unless told not to; the renderer CSP omits
 * 'unsafe-eval' on purpose, so leaving this off breaks rendering outright.
 */
export const PDF_DOCUMENT_OPTIONS = { isEvalSupported: false } as const
