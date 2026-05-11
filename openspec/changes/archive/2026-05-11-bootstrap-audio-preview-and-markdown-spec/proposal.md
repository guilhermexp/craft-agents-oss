## Why

Documentar retroativamente a capability `audio-preview-and-markdown` para que previews de áudio/HTML, renderização rica de Markdown, linkificação de URLs/caminhos e visualização de transcrições tenham contrato escrito antes de mudanças futuras.

## What Changes

- Adicionar a nova capability `audio-preview-and-markdown`.
- Registrar o comportamento esperado dos overlays de preview de áudio e HTML.
- Registrar o contrato do renderer de Markdown com Shiki, linkify de URLs/caminhos de arquivo, previews inline e blocos ricos.
- Registrar o contrato do transcript viewer e da classificação de arquivos usada para rotear previews.

## Capabilities

### New Capabilities

- `audio-preview-and-markdown`: cobre overlays de preview de áudio/HTML, Markdown rico com linkify de URLs e caminhos de arquivo, resolução de contexto de pasta, transcript viewer e classificação de arquivos para roteamento de preview.

### Modified Capabilities

- Nenhuma.

## Impact

- `packages/ui/src/components/overlay/*`
- `packages/ui/src/components/markdown/*`
- `packages/ui/src/components/ui/transcript-viewer.tsx`
- `packages/ui/src/lib/html-preview-sanitizer.ts`
- `packages/ui/src/lib/file-classification.ts`
