import { defaultUrlTransform, type UrlTransform } from 'react-markdown'

export const markdownUrlTransform: UrlTransform = (value, key, node) => {
  const tagName = typeof node === 'object' && node && 'tagName' in node
    ? String((node as { tagName?: unknown }).tagName)
    : ''

  // For anchors, the custom <a> needs the original target so it can route normal
  // clicks through onFileClick/onUrlClick (and it writes a separately sanitized
  // DOM href). ReactMarkdown's default transform strips file: along with the XSS
  // schemes (javascript:/data:/vbscript:/blob:), so we can't just return the
  // default — that would drop the routable file: links.
  //
  // Defense-in-depth: instead of returning the raw value (which would let a
  // javascript:/data: href reach the DOM if any consumer ever forgets to
  // re-sanitize), we keep whatever the default transform considers safe and
  // ONLY re-allow file: from the set the default strips. The XSS schemes stay
  // stripped at this layer, independent of the component's own sanitization.
  if (key === 'href' && tagName === 'a') {
    const sanitized = defaultUrlTransform(value)
    if (sanitized) return sanitized
    return /^\s*file:/i.test(value) ? value : sanitized
  }
  return defaultUrlTransform(value)
}
