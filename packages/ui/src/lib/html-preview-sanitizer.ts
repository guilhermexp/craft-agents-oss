/**
 * Prepares untrusted HTML for sandboxed preview iframes.
 *
 * Preview iframes intentionally do not use `allow-scripts`. Removing script
 * tags before assigning `srcDoc` avoids Chromium console errors while keeping
 * the preview sandboxed.
 */
function sanitizeHtmlPreview(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/\s*>/gi, '')
}

/**
 * Inject `<base target="_top">` so link clicks navigate the top frame,
 * which Electron's will-navigate handler intercepts.
 */
function injectHtmlPreviewBaseTarget(html: string): string {
  if (/<base\s/i.test(html)) return html
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/(<head[^>]*>)/i, '$1<base target="_top">')
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/(<html[^>]*>)/i, '$1<head><base target="_top"></head>')
  }
  return `<head><base target="_top"></head>${html}`
}

export function prepareHtmlPreviewSrcDoc(html: string): string {
  return injectHtmlPreviewBaseTarget(sanitizeHtmlPreview(html))
}
