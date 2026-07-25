export type BrowserCookieSameSite = -1 | 0 | 1 | 2

export interface BrowserCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  expirationDate?: number
  sameSite: BrowserCookieSameSite
}

export interface BrowserCookieReadResult {
  cookies: BrowserCookie[]
  skipped: number
}
