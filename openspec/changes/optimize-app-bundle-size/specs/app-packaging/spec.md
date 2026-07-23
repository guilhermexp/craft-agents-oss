## ADDED Requirements

### Requirement: Binários de runtime embarcam uma única vez

O pacote Electron MUST embarcar cada binário de runtime (ex.: `uv`) uma única
vez. A árvore de assets autoritativa lida pelo runtime SHALL ser preservada; a
cópia redundante gerada pelo espelhamento `resources/` → `dist/resources/`
combinada com as entradas `files` do `electron-builder` NÃO DEVE embarcar o
mesmo binário duas vezes.

#### Scenario: uv embarca uma vez e é resolvível

- **GIVEN** um `.app` empacotado
- **WHEN** o conteúdo de `Contents/Resources/app` é inspecionado
- **THEN** o binário `uv` aparece em apenas uma árvore
- **AND** o resolver de runtime (`main/index.ts`) ainda encontra o `uv` embarcado

### Requirement: Assets de instalador ficam fora do runtime

O pacote MUST manter assets de instalador fora do runtime. Os arquivos usados
apenas para montar o instalador (`dmg-background.tiff`, `dmg-background.png`,
`dmg-background@2x.png`, `source.png`) NÃO DEVEM ser empacotados dentro de
`Contents/Resources/app`. Eles SHALL permanecer disponíveis ao `electron-builder`
como `buildResources` para produzir o DMG.

#### Scenario: DMG monta sem assets no runtime

- **WHEN** o `electron-builder` produz o DMG
- **THEN** o background do DMG é aplicado a partir de `resources/`
- **AND** `Contents/Resources/app` não contém `dmg-background.*` nem `source.png`

### Requirement: Árvore de assets sem duplicação no pacote

O pacote MUST embarcar cada asset de aplicação (bridge-mcp-server,
session-mcp-server, tool-icons, docs) uma única vez, sem duplicá-lo entre
`app/resources` e `app/dist/resources`. Uma árvore autoritativa por asset SHALL
ser embarcada e os resolvers SHALL apontar para ela.

#### Scenario: asset embarca uma vez

- **GIVEN** um `.app` empacotado
- **WHEN** bridge-mcp-server, session-mcp-server, tool-icons e docs são localizados
- **THEN** cada um aparece em uma única árvore de assets
- **AND** o app abre e opera sem erro de asset ausente

### Requirement: Bundle do processo principal minificado com sourcemap externo

O `dist/main.cjs` empacotado MUST ser minificado. Um sourcemap SHALL ser gerado
**out-of-band** (disponível no artefato de build/CI) e NÃO DEVE ser embarcado no
`.app`, permitindo desminificar crash logs do processo principal.

#### Scenario: main minificado e crash mapeável

- **WHEN** o build empacotado é produzido
- **THEN** `dist/main.cjs` está minificado e não embarca o `.map`
- **AND** um crash do processo principal pode ser mapeado para a linha original usando o sourcemap out-of-band

### Requirement: Gramáticas de highlight carregadas sob demanda

O renderer MUST carregar as gramáticas de highlight (Shiki) sob demanda e NÃO
DEVE embarcar todas no bundle inicial. As gramáticas SHALL ser carregadas ao
renderizar o primeiro bloco de cada linguagem, preservando highlight para todas
as linguagens.

#### Scenario: linguagem exótica ainda tem highlight

- **GIVEN** um app com Shiki em lazy-load
- **WHEN** um bloco de código de uma linguagem não-comum (ex.: wolfram, wasm) é renderizado
- **THEN** a gramática correspondente é carregada e o bloco recebe highlight
- **AND** o bundle inicial do renderer não contém todas as gramáticas

### Requirement: Tamanho do pacote medido antes e depois

O trabalho de redução de tamanho MUST ser validado por medição real do `.app`
empacotado antes e depois, comparado ao baseline de 981 MB (macOS arm64).

#### Scenario: delta de tamanho registrado

- **WHEN** o `.app` é reempacotado após as mudanças
- **THEN** o tamanho é medido com `du -sh` e comparado ao baseline
- **AND** o delta é registrado sem regressão funcional no smoke real
