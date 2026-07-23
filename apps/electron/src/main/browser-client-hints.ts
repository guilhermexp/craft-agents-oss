/**
 * Chromium User-Agent Client Hint normalization for embedded browser panes.
 *
 * We already strip the `Electron/<ver>` and `<AppToken>/<ver>` tokens from the
 * page User-Agent so it reads as vanilla Chrome. But Chromium's low-entropy
 * `Sec-CH-UA` brand list still only advertises `"Chromium"` + a greased brand
 * — never `"Google Chrome"`. Google's sign-in flow cross-checks the UA against
 * that brand list: a Chrome-looking UA whose brands lack `"Google Chrome"` is
 * flagged as an embedded/insecure browser and the login is rejected with
 * "This browser or app may not be secure" (the `v3/signin/rejected` redirect).
 *
 * To keep the UA and the client hints internally consistent we:
 *  - drop any Electron / app brand (mirrors the UA sanitization), and
 *  - inject a `"Google Chrome"` brand version-matched to the `"Chromium"` brand.
 *
 * Requests that carry no `Sec-CH-UA` header are left untouched — Chromium
 * deliberately omits brand hints for some contexts and we must not invent them.
 */

interface Brand {
  brand: string
  version: string
}

const BRAND_ENTRY = /"((?:[^"\\]|\\.)*)";\s*v="((?:[^"\\]|\\.)*)"/g

function parseBrands(value: string): Brand[] {
  const brands: Brand[] = []
  BRAND_ENTRY.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = BRAND_ENTRY.exec(value)) !== null) {
    brands.push({ brand: match[1], version: match[2] })
  }
  return brands
}

function normalizeBrandHeader(value: string): string | null {
  const brands = parseBrands(value)
  if (brands.length === 0) return null

  const chromiumVersion = brands.find((b) => /^chromium$/i.test(b.brand.trim()))?.version
  const filtered = brands.filter((b) => !/electron/i.test(b.brand) && !/craft\s*agents?/i.test(b.brand))

  if (chromiumVersion && !filtered.some((b) => /^google chrome$/i.test(b.brand.trim()))) {
    const chrome: Brand = { brand: 'Google Chrome', version: chromiumVersion }
    const chromiumIdx = filtered.findIndex((b) => /^chromium$/i.test(b.brand.trim()))
    if (chromiumIdx >= 0) {
      filtered.splice(chromiumIdx + 1, 0, chrome)
    } else {
      filtered.push(chrome)
    }
  }

  return filtered.map((b) => `"${b.brand}";v="${b.version}"`).join(', ')
}

/**
 * Returns a copy of `headers` with the `Sec-CH-UA` / `Sec-CH-UA-Full-Version-List`
 * brand lists rewritten to include a `"Google Chrome"` brand and to exclude any
 * Electron/app brand. If no `Sec-CH-UA` header is present the input is returned
 * unchanged (same reference).
 */
export function normalizeChromeClientHints(
  headers: Record<string, string>,
): Record<string, string> {
  const keys = Object.keys(headers)
  const lowEntropyKey = keys.find((key) => key.toLowerCase() === 'sec-ch-ua')
  if (!lowEntropyKey) return headers

  const lowEntropy = normalizeBrandHeader(headers[lowEntropyKey] ?? '')
  if (!lowEntropy) return headers

  const result: Record<string, string> = { ...headers }
  result[lowEntropyKey] = lowEntropy

  const fullListKey = keys.find((key) => key.toLowerCase() === 'sec-ch-ua-full-version-list')
  if (fullListKey) {
    const fullList = normalizeBrandHeader(headers[fullListKey] ?? '')
    if (fullList) result[fullListKey] = fullList
  }

  return result
}
