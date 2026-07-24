# Design — pi-computer-use v0.5.0

## Contexto

O Pi server é compilado para `packages/pi-agent-server/dist/index.js`, enquanto extensões vendorizadas são carregadas pelo `DefaultResourceLoader` a partir de paths adicionais. No app empacotado, `scripts/build/common.ts::copyPiAgentServer()` monta `resources/pi-agent-server/`. A extensão v0.5 usa um helper macOS separado em `~/Applications/pi-computer-use.app` e substitui os tools coordenados da v0.1.6 por um contrato stateful.

Há uma segunda extensão vendorizada, `pi-better-subagents`, já integrada ao loader e ao copy de recursos. A mudança deve compor com esse trabalho e não recriar loaders concorrentes.

## Fluxo alvo

```text
Craft session (Pi, desktop, macOS, enableComputerUse)
  -> pi-agent-server index.js
  -> resource loader único
       -> pi-better-subagents (quando presente)
       -> pi-computer-use v0.5 (quando presente)
  -> allowlist explícita dos tools v0.5
  -> helper ~/Applications/pi-computer-use.app
  -> Accessibility + Screen Recording
```

## Estratégia de vendorização

O diretório `src/pi-computer-use/` será sincronizado com o commit fixado e receberá somente um overlay Craft pequeno e documentado: provenance do commit e `skills/computer-use/SKILL.md`. O build do Pi server continuará materializando o diretório em `dist/pi-computer-use`.

## Estratégia de carregamento runtime

A extensão precisa carregar tanto no checkout quanto dentro do recurso Electron isolado. O implementador deve escolher a solução mínima entre:

1. pré-compilar/prebundle da extensão preservando a instância de `ExtensionAPI`; ou
2. copiar as dependências runtime mínimas necessárias ao loader dinâmico.

A escolha é subordinada ao teste de isolamento: iniciar/carregar a extensão a partir de uma árvore temporária que não possa resolver o `node_modules` raiz. Copiar todo o monorepo ou todo `node_modules` não é aceitável.

## Contrato de tools

`COMPUTER_USE_TOOL_NAMES` torna-se a fonte explícita da allowlist Craft. O array conterá somente:

- `find_roots`
- `observe_ui`
- `search_ui`
- `expand_ui`
- `inspect_ui`
- `act_ui`
- `read_text`
- `wait_for`
- `launch_browser`
- `navigate_browser`
- `evaluate_browser`

A skill instrui o modelo a obter `stateId`, preferir alvos semânticos e reobservar após navegação/mutação. Não haverá camada de tradução dos tools antigos.

## Empacotamento

`copyPiAgentServer()` copiará `dist/pi-computer-use` inteiro ao lado de `index.js`, `koffi` e `pi-better-subagents`. O teste de packaging verificará os arquivos sentinela do pacote e as dependências runtime escolhidas. `electron-builder.yml` só será alterado se o recurso montado atualmente não for incluído no `.app`.

## Validação real

Após build/restart do Craft, a validação usará uma sessão Pi nova. O helper v0.5 será instalado no path estável, o usuário concederá Accessibility e Screen Recording, e o smoke usará um documento temporário do TextEdit: descobrir raiz, observar conteúdo não preto, inserir marcador, confirmar estado e fechar sem salvar. A mesma sessão observará a janela Craft para provar captura do host real.

## Riscos

- **Identidade TCC nova:** autorização deve apontar para o helper instalado, não para Bun/Electron antigo.
- **Dependência escondida no checkout:** o teste isolado e a inspeção do `.app` impedem falso positivo de dev.
- **Drift do upstream não lançado:** SHA completo torna a integração reproduzível.
- **Conflito entre extensões:** loader único e teste conjunto impedem substituição acidental.
