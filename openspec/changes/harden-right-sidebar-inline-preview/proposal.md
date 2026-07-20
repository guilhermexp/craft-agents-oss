## Why

O preview inline de arquivos na sidebar direita amplia o fluxo persistente de
inspeção de arquivos, mas o primeiro rascunho possui regressões de roteamento,
layout, loading, navegação Markdown, i18n e restauração da largura. A mudança
precisa preservar os viewers especializados existentes e continuar utilizável
em janelas menores ou após troca de monitor.

## What Changes

- Manter a árvore de arquivos visível ao lado do preview inline quando houver
  largura suficiente, expandindo a sidebar até o mínimo do split.
- Enviar ao preview inline somente imagens e tipos textuais que ele realmente
  renderiza; PDF, áudio e outros formatos continuam no diálogo especializado.
- Tornar loading, troca de sessão e restauração/redimensionamento da sidebar
  determinísticos, sem estado stale ou handle fora da viewport.
- Encaminhar links Markdown para os handlers existentes de URL e arquivo.
- Usar imports diretos e chaves i18n em todos os locales.

## Capabilities

### Modified Capabilities

- `audio-preview-and-markdown`: adiciona o contrato do preview inline na
  sidebar e preserva o roteamento por classificação de arquivo.

## Impact

- `apps/electron/src/renderer/components/app-shell/AppShell.tsx`
- `apps/electron/src/renderer/components/app-shell/SessionInfoPopover.tsx`
- `apps/electron/src/renderer/components/app-shell/right-sidebar-sizing.ts`
- `apps/electron/src/renderer/components/right-sidebar/SessionFilesSection.tsx`
- Testes focados do renderer e locales do Electron.

## Non-goals

- Reimplementar os viewers especializados de PDF ou áudio dentro da sidebar.
- Alterar o diálogo de preview existente.
- Alterar formatos persistidos de sessão ou workspace.
