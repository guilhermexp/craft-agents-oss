/**
 * Resolves the page-level background a preview document paints for itself.
 *
 * Full HTML documents/reports set an opaque, non-white background on
 * <html>/<body> and expect to render edge-to-edge. Emails and HTML fragments
 * leave those transparent (or white) and look best framed by the white paper
 * card. Returns the color to adopt for the card when the content is full-bleed,
 * or null to keep the default white paper framing.
 */
export function resolveHtmlPreviewBackground(
  htmlBg: string | undefined,
  bodyBg: string | undefined,
): string | null {
  const color = pickOpaqueColor(htmlBg) ?? pickOpaqueColor(bodyBg)
  if (!color) return null
  const rgb = parseCssRgb(color)
  // Near-white content keeps the paper look; honor anything darker/colored.
  if (rgb && rgb[0] >= 248 && rgb[1] >= 248 && rgb[2] >= 248) return null
  return color
}

function pickOpaqueColor(color: string | undefined): string | null {
  if (!color) return null
  const c = color.trim()
  if (!c || c.toLowerCase() === 'transparent') return null
  const inner = c.match(/^rgba?\(([^)]+)\)$/i)?.[1]
  if (inner) {
    const parts = inner.split(',').map((p) => p.trim())
    const alpha = parts[3]
    if (parts.length === 4 && alpha !== undefined && parseFloat(alpha) === 0) return null
  }
  return c
}

function parseCssRgb(color: string): [number, number, number] | null {
  const inner = color.match(/^rgba?\(([^)]+)\)$/i)?.[1]
  if (!inner) return null
  const [r, g, b] = inner.split(',').map((p) => parseFloat(p.trim()))
  if (r === undefined || g === undefined || b === undefined) return null
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null
  return [r, g, b]
}
