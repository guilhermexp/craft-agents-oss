# session-tools-mcp — delta: favicon transport do browser pane

## ADDED Requirements

### Requirement: Page-chosen favicon URLs never reach the privileged renderer

O browser pane SHALL manter no processo main a URL de favicon anunciada por
uma página carregada (`page-favicon-updated`). O renderer privilegiado SHALL
receber apenas uma `data:` URL já validada, ou `null` — nunca uma URL de rede
escolhida pela página. O processo main SHALL buscar os bytes na `session` da
própria partition do pane, para herdar cookies e proxy daquele perfil e não
usar credencial de outra partition.

A busca SHALL ser guardada por:

- allowlist de esquema: apenas `http:` e `https:`; `file:`, `data:`,
  `javascript:`, esquemas internos e URLs inválidas SHALL ser rejeitados sem
  qualquer requisição;
- timeout curto (4 segundos) e abort;
- limite rígido de tamanho (32 KiB), aplicado tanto ao `content-length`
  anunciado quanto aos bytes efetivamente recebidos, sempre por chunk — o
  transporte SHALL NOT bufferizar um corpo inteiro antes de compará-lo com o
  teto;
- allowlist de content-type de imagem raster (`image/png`, `image/x-icon`,
  `image/vnd.microsoft.icon`, `image/gif`, `image/jpeg`, `image/webp`),
  testada como conjunto fechado (`Object.hasOwn`) e nunca por veracidade de
  lookup: um header `constructor` ou `__proto__` SHALL ser rejeitado como
  qualquer outro tipo fora da lista;
- allowlist de credenciais: a requisição SHALL ser emitida com
  `credentials: 'omit'`, porque decoração não carrega cookie nem autenticação
  da partition para um host escolhido pela página;
- política de redirect explícita: o transporte SHALL NOT seguir um redirect
  automaticamente. Cada salto SHALL ser revalidado contra a mesma allowlist de
  esquema antes de ser seguido, com teto de 2 saltos; um salto reprovado ou
  além do teto SHALL abortar a requisição;
- resposta HTTP de sucesso.

`image/svg+xml` SHALL ser rejeitado: um SVG escolhido por página não-confiável
não deve ser parseado pelo motor de SVG do renderer privilegiado quando o
benefício é apenas decorativo.

Qualquer guarda que falhe SHALL resultar em favicon `null`, silenciosamente: a
falha SHALL NOT derrubar a instância, SHALL NOT emitir log por navegação e
SHALL NOT virar erro visível ao usuário.

A diretiva `img-src` da CSP do renderer SHALL permanecer inalterada; `data:` já
é permitido por ela.

#### Scenario: dev server local em http tem favicon renderizado

- **GIVEN** um pane com `http://localhost:3003` carregado
- **WHEN** a página anuncia `http://localhost:3003/favicon.ico` e o recurso é um
  ícone válido dentro do limite de tamanho
- **THEN** o renderer recebe uma `data:` URL com o content-type validado
- **AND** a URL `http://localhost:3003/...` nunca é atribuída a `instance.favicon`
- **AND** a diretiva `img-src` da CSP não é alterada

#### Scenario: página aponta o favicon para uma porta local arbitrária

- **GIVEN** um pane com uma página não-confiável carregada
- **WHEN** a página declara `<link rel="icon" href="http://localhost:9999/probe">`
- **THEN** a sondagem, se ocorrer, parte do processo main na sessão daquele pane
- **AND** o renderer privilegiado nunca emite a requisição
- **AND** uma resposta que não seja imagem raster permitida dentro do limite
  resulta em favicon `null`

#### Scenario: favicon com esquema não suportado

- **GIVEN** um pane carregado
- **WHEN** a página anuncia um favicon `file:///etc/passwd` ou
  `data:image/png;base64,...`
- **THEN** nenhuma requisição é feita
- **AND** o favicon resultante é `null`

#### Scenario: recurso grande demais ou de content-type proibido

- **GIVEN** um pane carregado
- **WHEN** o recurso de favicon excede 32 KiB, ou responde
  `image/svg+xml`, `text/html` ou qualquer content-type fora da allowlist
- **THEN** o corpo é descartado (abortado assim que o teto é ultrapassado)
- **AND** o favicon resultante é `null` sem erro visível

#### Scenario: servidor redireciona o favicon para um destino não permitido

- **GIVEN** um pane carregado cujo favicon anunciado passou a allowlist de esquema
- **WHEN** o servidor responde `302` com `Location` para um esquema fora de
  `http:`/`https:`, ou a cadeia ultrapassa 2 saltos
- **THEN** o salto não é seguido e a requisição é abortada
- **AND** o favicon resultante é `null`
- **AND** nenhum destino que não tenha passado a allowlist chega a ser requisitado

#### Scenario: content-type herdado da cadeia de protótipo

- **GIVEN** um pane carregado
- **WHEN** o servidor responde `Content-Type: constructor` ou `__proto__`
- **THEN** o content-type é tratado como fora da allowlist
- **AND** o favicon resultante é `null`, sem `data:` URL emitida

### Requirement: The whole candidate list is honoured

O browser pane SHALL percorrer os candidatos buscáveis entregues por
`page-favicon-updated` em ordem, até que um sobreviva a todas as guardas, com
teto de tentativas e mantendo uma única busca em voo por instância. Um
candidato rejeitado SHALL NOT descartar os seguintes.

Esta é a condição que sustenta o racional de rejeitar `image/svg+xml`: sites
que anunciam `favicon.svg` primeiro expõem PNG/ICO em seguida.

#### Scenario: primeiro candidato é SVG e o segundo é PNG

- **GIVEN** um pane cuja página anuncia `favicon.svg` seguido de `favicon.png`
- **WHEN** o SVG é rejeitado pela allowlist de content-type
- **THEN** o PNG é requisitado em seguida
- **AND** o favicon resultante é a `data:` URL do PNG

### Requirement: Favicon resolution never blocks or outlives the page that requested it

A emissão de estado do browser pane SHALL NOT esperar pela resolução do
favicon: o estado SHALL ser emitido imediatamente sem favicon e atualizado
depois, se e quando bytes válidos chegarem.

Uma busca de favicon em voo SHALL ser abortada quando a instância navega para
outra página ou é destruída, e um resultado que chegue depois dessa transição
SHALL ser descartado em vez de aplicado à página atual.

#### Scenario: estado é emitido antes dos bytes chegarem

- **GIVEN** um pane cuja página acabou de anunciar um favicon
- **WHEN** a busca dos bytes ainda está em voo
- **THEN** o state change já foi emitido com favicon `null`
- **AND** um segundo state change é emitido quando a `data:` URL fica pronta

#### Scenario: navegação descarta o favicon da página anterior

- **GIVEN** uma busca de favicon em voo para a página A
- **WHEN** a instância navega para a página B
- **THEN** a busca é abortada e o favicon volta a `null`
- **AND** uma resposta tardia da página A não é aplicada ao estado da página B

#### Scenario: instância destruída durante a busca

- **GIVEN** uma busca de favicon em voo
- **WHEN** a instância é destruída
- **THEN** a busca é abortada
- **AND** nenhum state change é emitido para a instância removida

#### Scenario: renderer da página morre durante a busca

- **GIVEN** uma busca de favicon em voo
- **WHEN** o processo de renderização da página termina (`render-process-gone`)
  e a instância sobrevive
- **THEN** a busca é abortada
- **AND** nenhum ícone é aplicado à página morta depois disso
