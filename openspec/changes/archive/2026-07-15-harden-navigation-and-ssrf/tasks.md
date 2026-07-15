# Tasks — harden-navigation-and-ssrf (F7)

## 1. R1 — Allowlist de esquema em navegação client-side/redirect

- [x] 1.1 `will-navigate` do pageWc: bloquear URL que falha `isAllowedTopLevelUrl` (preventDefault + log), após deep link e navigationPolicy
- [x] 1.2 `did-redirect-navigation` do pageWc (main frame): destino proibido → `stop()` + `loadURL('about:blank')` + log
- [x] 1.3 Mesmo tratamento reativo no `did-redirect-navigation` de popups
- [x] 1.4 Testes: will-navigate `file:///etc/passwd` → preventDefault; `https://ok.com` → não bloqueia; deep link Craft continua funcionando; redirect p/ `file://` → stop + about:blank

## 2. R2 — SSRF guard IPv6

- [x] 2.1 Extrair checagem IPv4 privada para helper reusável
- [x] 2.2 Normalizar hostname IPv6 (strip `[]`); bloquear `::1`, `::`, fc00::/7, fe80::/10, IPv4-mapped `::ffff:` com IPv4 privado
- [x] 2.3 Exportar `isUrlSafeToFetch` para teste direto
- [x] 2.4 Testes: `[::1]`, `[fe80::1]`, `[fc00::1]`, `[::ffff:127.0.0.1]` (e forma hex) → unsafe; `[2606:4700::1111]` → safe

## 3. R3 — SSRF em redirects e endpoints de metadata

- [x] 3.1 `fetchWithTimeout`: `redirect: 'manual'` + seguir ≤3 redirects validando `Location` com `isUrlSafeToFetch`
- [x] 3.2 Guard `isUrlSafeToFetch` antes de todo fetch de `token_endpoint`/`registration_endpoint` (CraftOAuth + fluxo MCP standalone), roteando pelos fetches redirect-safe
- [x] 3.3 `tryFetchAuthServerMetadata` rejeita metadata com `token_endpoint`/`registration_endpoint` unsafe
- [x] 3.4 Testes: metadata com `token_endpoint='https://127.0.0.1/'` → rejeitado sem fetch; redirect 302 com Location interno → rejeitado; redirect p/ destino público → segue

## 4. R4 — Invalidação de refs em navegação de subframe

- [x] 4.1 `BrowserCDP` escuta `did-frame-navigate` e chama `invalidateRefs()`
- [x] 4.2 Teste: did-frame-navigate → refMap/backendNodeRefMap limpos, ref antiga vira stale

## 5. Validação

- [x] 5.1 `HOME=/tmp/craft-worker-home bun run validate:ci` → exit 0
- [x] 5.2 Baselines mantidos: browser-pane ≤8 fails pré-existentes; oauth e browser-cdp verdes
- [x] 5.3 `openspec validate harden-navigation-and-ssrf --strict --no-interactive` verde
