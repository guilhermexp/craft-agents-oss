## Context

A UI já possui previews ricos para conteúdo emitido por agentes e arquivos do workspace. O comportamento relevante está distribuído entre overlays de preview, renderer de Markdown, utilitários de resolução/linkificação, transcript viewer e classificação de arquivos. Esta change documenta o contrato atual sem alterar código.

## Goals / Non-Goals

**Goals:**

- Definir o contrato do `AudioPreviewOverlay` como player de áudio com visualização de transcrição.
- Definir o contrato do `HTMLPreviewOverlay` como renderização inline/fullscreen de HTML sanitizado em iframe sandboxed.
- Definir o contrato do `Markdown` como renderer rico com Shiki, linkify de URLs e caminhos de arquivo, callouts/embeds e previews inline.
- Definir que `folder-context-prefix` transforma listas de basenames em links resolvíveis quando há contexto de pasta/workspace.
- Definir o transcript viewer como superfície de navegação por timestamps, com seek por segmento e barra de progresso sincronizada.
- Definir que `file-classification` roteia tipos conhecidos para o overlay ou preview correto.

**Non-Goals:**

- Reescrever o renderer de Markdown, os overlays ou a sanitização de HTML.
- Adicionar novos formatos de arquivo ou novos overlays.
- Alterar contrato de segurança do iframe além do comportamento já implementado.

## Decisions

- `AudioPreviewOverlay` usa `TranscriptViewerContainer` como composição única de player, barra de scrub, botão play/pause e palavras alinhadas. Isso mantém o estado de áudio e transcrição sincronizado em uma única árvore de contexto.
- `HTMLPreviewOverlay` prepara o HTML com `prepareHtmlPreviewSrcDoc` antes de atribuir `srcDoc` ao iframe. O iframe permanece sandboxed sem `allow-scripts`, e a sanitização remove scripts antes da renderização.
- `Markdown` roda `prefixFolderContext` antes de `preprocessLinks`. Assim, respostas de agentes com `Pasta:`/`Folder:` e itens relativos viram links absolutos antes da etapa geral de linkify.
- `CodeBlock` usa Shiki com tema do app quando não há links detectados; quando URLs ou caminhos aparecem no conteúdo, renderiza texto linkificado para preservar click targets.
- `file-classification` centraliza a decisão por extensão para manter link detection e roteamento de preview alinhados.

## Risks / Trade-offs

- Sanitização baseada em regex é limitada para HTML arbitrário complexo → mitigada pelo iframe sandboxed sem execução de scripts.
- Linkify dentro de code blocks pode priorizar links clicáveis em vez de HTML Shiki quando há URLs/caminhos detectados → mitigado por manter o conteúdo textual intacto e preservar callbacks de URL/arquivo.
- Resolução por contexto de pasta depende de marcadores textuais emitidos pelo agente → mitigada por ser idempotente e ignorar code fences, links já formatados e caminhos relativos sem contexto absoluto.

## Migration Plan

Não há migração de dados ou código. A change apenas registra o contrato atual em OpenSpec.

## Open Questions

- Nenhuma aberta para este bootstrap retroativo.
