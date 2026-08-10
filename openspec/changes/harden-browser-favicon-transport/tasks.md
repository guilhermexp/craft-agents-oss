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
- [x] 5.2 Atualizar `AGENTS.md` raiz com allowlist fechada, política de redirect e caminhada de candidatos

## 6. Hardening pós-revisão de segurança

- [x] 6.1 Allowlist de content-type vira conjunto fechado (`Object.hasOwn`); `constructor`, `__proto__`, `toString`, `hasOwnProperty` e variações de caixa rejeitados
- [x] 6.2 `firstHeaderValue` lê headers da resposta com a mesma disciplina, sem lookup pela cadeia de protótipo
- [x] 6.3 Fetcher passa a dirigir `net.request` na session da partition com `credentials: 'omit'` e `redirect: 'manual'` — `session.fetch` não expõe o salto (evidência no proposal)
- [x] 6.4 `shouldFollowFaviconRedirect` revalida o alvo de cada salto contra a allowlist de esquema, teto de 2 saltos; salto reprovado aborta a requisição
- [x] 6.5 `FaviconHttpResponse.body` passa a ser obrigatório; o fallback `arrayBuffer()` (que bufferizava antes de checar o teto) foi eliminado, e o stub default dos testes passa a exercitar o caminho streaming de produção
- [x] 6.6 `page-favicon-updated` percorre a lista de candidatos (teto de 4, sequencial, single-in-flight) em vez de só `favicons[0]`
- [x] 6.7 `render-process-gone` aborta a busca em voo
- [x] 6.8 `.catch()` morto removido; `faviconAbort` limpo em todo caminho terminal cujo token ainda é o corrente
- [x] 6.9 Testes de ciclo de vida em `browser-pane-manager.test.ts`: estado antes dos bytes, abort em navegação com resposta tardia descartada, abort no destroy sem state change, abort no crash do renderer, opções da requisição, saltos de redirect, caminhada de candidatos
- [ ] 6.10 Amplificação de IPC (`data:` URL em todo `emitStateChange`, 43.714 bytes no teto, `page-title-updated` sem throttle) — **não corrigido de propósito**: coalescer `emitStateChange` muda a ordem observável para todos os consumidores. Registrado no proposal e em `forward.fragile[]`
