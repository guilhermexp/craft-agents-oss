# Tasks — harden-browser-favicon-transport

## 1. Módulo de transporte (pure/injetável)

- [x] 1.1 Criar `apps/electron/src/main/browser/favicon-transport.ts` com constantes documentadas (`FAVICON_MAX_BYTES`, `FAVICON_FETCH_TIMEOUT_MS`, allowlist de content-type sem `image/svg+xml`)
- [x] 1.2 `isFetchableFaviconUrl` — só `http:`/`https:`; rejeita `file:`, `data:`, `javascript:`, esquemas internos e URL inválida
- [x] 1.3 `normalizeFaviconContentType` — descarta parâmetros, normaliza caixa, devolve `null` fora da allowlist
- [x] 1.4 `toFaviconDataUrl` — `data:<type>;base64,<bytes>` bem-formada; `null` para corpo vazio ou acima do teto
- [x] 1.5 `fetchFaviconDataUrl` — fetch injetável, timeout + abort externo composto, checagem de `content-length`, leitura do corpo com teto por chunk, nunca lança

## 2. Wiring no browser pane

- [x] 2.1 Campos de ciclo de vida em `BrowserInstance` (`faviconToken`, `faviconSourceUrl`, `faviconAbort`) inicializados na criação
- [x] 2.2 `page-favicon-updated` deixa de propagar `favicons[0]`; emite estado sem favicon e dispara a busca na `session` da partition do pane
- [x] 2.3 Aplicar a `data:` URL e reemitir estado só quando o token ainda for o corrente
- [x] 2.4 `did-navigate` limpa favicon e aborta a busca em voo
- [x] 2.5 `finalizeDestroyedInstance` aborta a busca em voo
- [x] 2.6 CSP e componentes de UI intocados (o campo continua `string | null`)

## 3. Testes

- [x] 3.1 `apps/electron/src/main/browser/__tests__/favicon-transport.test.ts` — allowlist de esquema, sem requisição para esquema rejeitado
- [x] 3.2 Allowlist de content-type (com parâmetros), `image/svg+xml` e `text/html` rejeitados
- [x] 3.3 Teto de tamanho: `content-length` acima do teto rejeita sem ler corpo; corpo chunked acima do teto aborta; exatamente no teto passa
- [x] 3.4 `data:` URL bem-formada e round-trip dos bytes
- [x] 3.5 Caminhos de falha devolvem `null`: status não-ok, fetch que lança, corpo vazio, abort externo, timeout

## 4. Validação

- [x] 4.1 `openspec validate harden-browser-favicon-transport --strict --no-interactive`
- [x] 4.2 `bun run typecheck:electron`
- [ ] 4.3 `cd apps/electron && bun run lint` — **bloqueado por débito pré-existente**: `@typescript-eslint/typescript-estree` 8.64 crasha no load com TypeScript 7 (`Cannot read properties of undefined (reading 'Cjs')`), antes de ler qualquer arquivo. Documentado em `//lint:check` no `apps/electron/package.json`; `typecheck:electron` cobre a análise estática
- [x] 4.4 `bun test apps/electron/src/main/browser/__tests__/favicon-transport.test.ts`
- [x] 4.5 `git diff main..HEAD -- apps/electron/src/renderer/index.html` prova `img-src` idêntico à `main`
- [x] 4.6 `bun test` completo comparado com a baseline em stash (delta zero de falhas)

## 5. DOX

- [x] 5.1 Atualizar `AGENTS.md` raiz com o contrato do favicon transport
