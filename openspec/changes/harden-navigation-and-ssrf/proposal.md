# Harden client-side navigation and OAuth SSRF guards (F7)

## Why

Um review adversarial pós-F1/F2/F4 encontrou 4 vetores de escape que os fixes
anteriores não cobriram — todos verificados no código:

1. **R1 [HIGH]** — a allowlist de esquema (`isAllowedTopLevelUrl`, F1.1) só é
   aplicada no call site `navigate` do agente e no `setWindowOpenHandler`.
   Navegação client-side (`window.location='file:///…'`) e redirects para
   esquemas internos passam pelo `will-navigate` / `did-redirect-navigation`
   sem bloqueio — a proteção F1.1 é contornável por qualquer página carregada.
2. **R2 [HIGH]** — o guard SSRF `isUrlSafeToFetch` compara `hostname === '::1'`,
   mas a URL WHATWG devolve `'[::1]'` (com colchetes) → IPv6 loopback passa.
   ULA (fc00::/7), link-local (fe80::/10), `::` e IPv4-mapped
   (`::ffff:127.0.0.1`) também não são filtrados.
3. **R3 [HIGH]** — os fetches OAuth seguem redirects automaticamente sem
   re-validar o destino, e `token_endpoint`/`registration_endpoint` vindos do
   metadata são usados em fetch sem passar pelo guard SSRF (que só cobre
   metadataUrl/authServer/mcpUrl).
4. **R4 [MEDIUM]** — `BrowserCDP` só invalida refs `@eN` em
   `did-navigate`/`did-navigate-in-page`; navegação de iframe
   (`did-frame-navigate`) não limpa os maps → ref antiga pode resolver para
   backendNodeId reciclado.

## What Changes

- **R1** — `will-navigate` do pageWc bloqueia (preventDefault + log) URLs que
  falham `isAllowedTopLevelUrl`, depois de deep links e navigationPolicy.
  `did-redirect-navigation` (main frame) reage a destino proibido com
  `stop()` + `loadURL('about:blank')`. Mesmo tratamento reativo no
  `did-redirect-navigation` de popups (popups já têm allowlist na abertura).
- **R2** — `isUrlSafeToFetch` normaliza hostname IPv6 (strip `[]`) e bloqueia
  `::1`, `::`, fc00::/7, fe80::/10 e IPv4-mapped `::ffff:` com IPv4 privado
  (reusando a checagem IPv4 existente, extraída para helper).
- **R3** — `fetchWithTimeout` passa a usar `redirect: 'manual'` e segue no
  máximo 3 redirects validando cada `Location` com `isUrlSafeToFetch`.
  Todos os fetches de endpoints derivados de metadata
  (`token_endpoint`, `registration_endpoint`) validam o endpoint com
  `isUrlSafeToFetch` antes do fetch e passam pelo mesmo caminho
  redirect-safe. `tryFetchAuthServerMetadata` também rejeita metadata cujo
  `token_endpoint`/`registration_endpoint` seja unsafe.
- **R4** — `BrowserCDP` também escuta `did-frame-navigate` e invalida todos os
  refs (refMap, refDetails, backendNodeRefMap) em qualquer navegação de frame.

- **Não-objetivo**: bloquear loopback/link-local na navegação do browser
  agêntico (segue `TODO(security)` da F1.1); resolução DNS anti-rebinding no
  guard SSRF; validar `authorization_endpoint` (não é fetchado — é aberto no
  browser do sistema).

## Impact

- `apps/electron/src/main/browser-pane-manager.ts` (R1)
- `packages/shared/src/auth/oauth.ts` (R2, R3)
- `apps/electron/src/main/browser-cdp.ts` (R4)
- Specs: `session-tools-mcp` (R1, R4), `workspace-and-sources` (R2, R3)
