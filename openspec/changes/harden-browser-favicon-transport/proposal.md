# Harden browser-pane favicon transport (page URL never reaches the renderer)

## Why

O favicon de qualquer site servido por `http://` — todo dev server local —
nunca renderiza no tab badge nem no toolbar do browser pane. Log de runtime:

```
Loading the image 'http://localhost:3003/favicon.ico?favicon.2vob68tjqpejf.ico'
violates the following Content Security Policy directive:
"img-src 'self' data: https: file: thumbnail:". The action has been blocked.
```

A causa é a forma do campo, não a diretiva. `page-favicon-updated` entrega uma
URL **escolhida pela página** e o handler em
`apps/electron/src/main/browser-pane-manager.ts` propaga essa URL crua para o
renderer privilegiado, que a consome como `<img src={instance.favicon}>` em
`BrowserTabBadge.tsx` e `ToolbarStatusSlot.tsx`.

O anti-fix óbvio — acrescentar `http://localhost:* http://127.0.0.1:*` ao
`img-src` — reabre exatamente o vetor que
`openspec/changes/archive/2026-07-15-harden-navigation-and-ssrf/` fechou: uma
página não-confiável declara `<link rel="icon" href="http://localhost:9999/x">`
e passa a fazer o renderer privilegiado sondar portas locais arbitrárias. O
mesmo problema já existe hoje em menor grau via `https:`: a página escolhe uma
URL https qualquer e o renderer a busca, dando beaconing (presença, IP, horário
de abertura) sem que nada valide o destino.

A correção certa elimina os dois de uma vez e não toca na CSP.

## What Changes

- **Novo módulo** `apps/electron/src/main/browser/favicon-transport.ts`: camada
  pura/injetável que decide se uma URL de favicon é buscável, faz a requisição
  com timeout e abort, aplica limite de bytes e allowlist de content-type, e
  devolve uma `data:` URL — ou `null`. Nunca lança.
- **`browser-pane-manager.ts`**: o handler de `page-favicon-updated` deixa de
  propagar `favicons[0]`. Ele emite o estado **sem** favicon imediatamente e
  dispara a busca na `session` da própria partition do pane (herda
  cookies/proxy, não vaza credencial de outra partition). Quando (e se) os
  bytes chegarem válidos, `instance.favicon` recebe a `data:` URL e um novo
  state change é emitido. Resultado de uma página já abandonada é descartado.
- **Ciclo de vida**: `did-navigate` limpa o favicon e aborta a busca em voo;
  `finalizeDestroyedInstance` aborta também. Um token monotônico por instância
  descarta resposta obsoleta mesmo que o abort perca a corrida.
- **CSP intacta**: `apps/electron/src/renderer/index.html` não é tocado. `data:`
  já está em `img-src`.
- **Forma do campo inalterada**: `BrowserInstance.favicon` e
  `BrowserInstanceInfo.favicon` continuam `string | null`; os componentes de UI
  não mudam (o `onError` deles vira caminho morto na prática, mas continua
  correto).

### Guardas (todas obrigatórias)

| Guarda | Valor | Razão |
|---|---|---|
| Esquema | `http:` / `https:` apenas | `file:` leria disco local pela sessão do pane; `data:`/`javascript:`/`chrome:` não são transporte de rede |
| Timeout | 4s | Favicon é decoração; um servidor que pendura não pode segurar um socket da partition indefinidamente |
| Tamanho | 32 KiB | Ver abaixo |
| Content-type | allowlist de raster | Ver abaixo |
| Status | só `response.ok` | Um 404 HTML não vira ícone |
| Falha | `instance.favicon = null`, em silêncio | Favicon é decoração: nunca derruba a instância, nunca polui log por navegação, nunca vira erro visível |

### Decisão: 32 KiB

Um favicon real fica entre 1 KB (PNG 32×32) e ~25 KB (ICO multi-resolução). O
teto não é só memória: a `data:` URL viaja em **todo** `emitStateChange` da
instância (título, loading, navegação), então cada byte é amplificado ~1.37×
por base64 e repetido por evento de estado. 32 KiB cobre o caso real e limita a
amplificação a ~44 KB por push. Recurso maior é rejeitado — a UI já tem
fallback de ícone genérico.

O `content-length` é checado antes de ler o corpo, e o corpo é lido com o mesmo
teto aplicado por chunk: uma resposta `chunked` sem `content-length` é abortada
assim que ultrapassa o limite, em vez de bufferizar até o timeout.

### Decisão: `image/svg+xml` é **rejeitado**

O brief permitia aceitar com justificativa escrita. Rejeitamos:

- SVG num `data:` URL dentro de `<img>` não executa script (contexto
  não-interativo do SVG), mas ainda é **parseado pelo motor de SVG do renderer
  privilegiado** — superfície de parser muito maior que a de um decodificador
  de raster, escolhida por uma página não-confiável, e historicamente fonte de
  CVEs de parser no Blink.
- O benefício é nulo: qualquer site que serve `favicon.svg` também expõe
  `favicon.ico`/PNG via `<link>` ou pelo caminho default, e o Electron entrega
  a lista de candidatos.
- O custo do erro é assimétrico: aceitar errado é execução de parser no
  processo privilegiado; rejeitar errado é um ícone genérico.

A allowlist final é `image/png`, `image/x-icon`, `image/vnd.microsoft.icon`,
`image/gif`, `image/jpeg`, `image/webp`.

**Não confundir** com `apps/electron/src/renderer/public/favicon.svg` (commit
`14fec059`): aquele é asset próprio do app, servido por `'self'`, e não passa
por este caminho.

### Decisão: allowlist é conjunto fechado, não lookup por veracidade

A chave do lookup é um header escolhido pelo atacante. Um object literal herda
de `Object.prototype`, então `Content-Type: constructor` e `__proto__`
passavam a allowlist e o valor era interpolado direto na `data:` URL
(`data:constructor;base64,<32 KiB>`). A checagem é `Object.hasOwn`, a mesma
disciplina do dispatch de capability em `browser-pane-manager.ts`. O mesmo
vale para ler headers da resposta (`firstHeaderValue`).

### Decisão: redirect é revalidado salto a salto, com `net.request`

O esquema era validado só na URL de entrada; o `session.fetch` seguia redirect
por default, então a URL final de um 302 nunca era revalidada. A invariante
"destino requisitado passou pela allowlist" não existia — o que segurava o
caso era o isolamento de partition, não este código.

`session.fetch` não consegue corrigir isso. `net.fetch` não registra listener
de `redirect`, então `redirect: 'manual'` lá apenas mata a requisição
(`ClientRequest._die(new Error('Redirect was cancelled'))`,
`lib/common/api/net-client-request.ts:481-493` do Electron 43.1.1) e não expõe
`Location`; e `redirect: 'follow'` não permite revalidar depois, porque
`Response.url` é documentado como incorreto sob `net.fetch`.

Então o fetcher injetado passa a dirigir `net.request` na `session` da
partition, com `credentials: 'omit'` e `redirect: 'manual'`, e chama
`followRedirect()` **synchronously** apenas quando o alvo do salto passa a
mesma allowlist de esquema, com teto de 2 saltos. A decisão fica pura em
`shouldFollowFaviconRedirect`; o `ClientRequest` só a executa.

`credentials: 'omit'` é independente disso: decoração não tem motivo para
levar cookie ou autenticação da partition a um host escolhido pela página.

### Decisão: a lista de candidatos é percorrida

O racional de rejeitar SVG se apoia em "o Electron entrega a lista de
candidatos". Usar só `favicons[0]` tornava a frase falsa: um site que anuncia
`favicon.svg` primeiro perdia o ícone mesmo tendo PNG em seguida. O pane
percorre até 4 candidatos buscáveis, sequencialmente, mantendo uma única busca
em voo.

### Ciclo de vida

`render-process-gone` também aborta a busca: a instância sobrevive ao crash do
renderer da página, então sem isso um ícone ainda pintaria até 4s depois.
`faviconAbort` é limpo em todo caminho terminal cujo token ainda é o corrente,
não só no sucesso, para o campo não mentir que há busca em voo.

## Impact

- `apps/electron/src/main/browser/favicon-transport.ts` (novo; allowlist
  fechada, política de redirect pura, leitura de header, corpo só por stream)
- `apps/electron/src/main/browser/__tests__/favicon-transport.test.ts` (novo)
- `apps/electron/src/main/browser-pane-manager.ts` (fetcher `net.request` com
  `credentials: 'omit'` e revalidação de salto, caminhada pela lista de
  candidatos, campos de ciclo de vida da instância, reset em `did-navigate`,
  abort em `render-process-gone` e no destroy)
- `apps/electron/src/main/__tests__/browser-pane-manager.test.ts` (ciclo de
  vida do favicon: anti-stale, abort, redirect, candidatos)
- Specs: `session-tools-mcp`
- **Não** muda: `apps/electron/src/renderer/index.html` (CSP), os componentes
  que consomem `instance.favicon`, o DTO `BrowserInstanceInfo`.

### Conhecido e aceito: amplificação de IPC

A `data:` URL viaja em todo `toInfo()` e portanto em todo `emitStateChange`,
que é broadcast `to: 'all'`. No teto são 43.714 bytes por push. O churn por
troca de favicon está contido pelo single-in-flight e pelo dedupe da lista de
candidatos, mas `page-title-updated` emite sem throttle: uma página hostil
fazendo `document.title = n++` custa ~44 KB por push. Não corrigido aqui —
coalescer `emitStateChange` mudaria a ordem observável para todos os
consumidores do estado do pane, o que é redesenho, não hardening de favicon.
