## MODIFIED Requirements

### Requirement: File classification routes previews

O sistema SHALL classificar caminhos por extensão e SHALL rotear cada arquivo
somente para uma superfície que implemente seu tipo. O preview inline da
sidebar SHALL aceitar imagens, código, texto, Markdown, JSON e Excalidraw.
Áudio, PDF e tipos sem renderer inline SHALL continuar no diálogo/viewer
especializado existente.

#### Scenario: Arquivo textual abre inline

- **WHEN** o usuário seleciona na sidebar um arquivo classificado como código, texto, Markdown, JSON ou Excalidraw
- **THEN** a árvore permanece visível e o conteúdo abre no preview inline
- **Test:** `unit`

#### Scenario: Imagem abre inline

- **WHEN** o usuário seleciona na sidebar uma imagem suportada
- **THEN** o preview inline lê e renderiza a imagem sem sair da sidebar
- **Test:** `integration`

#### Scenario: Viewer especializado é preservado

- **WHEN** o usuário seleciona PDF, áudio ou outro tipo não implementado pelo preview inline
- **THEN** o arquivo segue diretamente para o diálogo/viewer existente
- **Test:** `unit`

### Requirement: Preview inline da sidebar preserva layout utilizável

O sistema SHALL manter árvore e preview utilizáveis em modo split, SHALL
expandir a sidebar até a largura mínima necessária e MUST reclamp a largura
persistida quando a viewport diminuir.

#### Scenario: Preview abre com sidebar estreita

- **WHEN** um preview inline é aberto enquanto a sidebar está abaixo do mínimo do split
- **THEN** a sidebar cresce até o mínimo que mantém as duas colunas utilizáveis
- **Test:** `unit`

#### Scenario: Janela fica menor

- **WHEN** a largura persistida da sidebar excede o máximo seguro da viewport atual
- **THEN** a largura efetiva é reduzida e o resize handle permanece acessível
- **Test:** `unit`

### Requirement: Preview inline mantém estado e navegação determinísticos

O sistema SHALL limpar loading em toda troca de arquivo, MUST impedir que um
preview de outra sessão seja exibido e SHALL encaminhar links Markdown para
os handlers existentes de URL e arquivo.

#### Scenario: Troca durante carregamento

- **WHEN** o usuário troca de um arquivo em carregamento para outro tipo
- **THEN** o loading anterior é cancelado e o novo estado não fica preso
- **Test:** `unit`

#### Scenario: Sessão muda

- **WHEN** a sidebar passa a representar outra sessão
- **THEN** nenhum preview selecionado na sessão anterior é renderizado
- **Test:** `unit`

#### Scenario: Link Markdown é acionado

- **WHEN** o usuário clica em uma URL ou caminho de arquivo no Markdown inline
- **THEN** o handler correspondente abre a URL ou o arquivo
- **Test:** `integration`
