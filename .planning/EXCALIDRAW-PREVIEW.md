# Excalidraw Preview in Craft

## Objetivo
Renderizar arquivos `.excalidraw` e `.excalidraw.md` dentro do preview do Craft, igual Mermaid/PDF/Image, sem depender do Obsidian.

## Resultado investigado
Craft já tem uma arquitetura boa para isso:

- `packages/ui/src/lib/file-classification.ts` classifica links/arquivos para preview.
- `apps/electron/src/renderer/hooks/useLinkInterceptor.ts` lê conteúdo e cria `FilePreviewState`.
- `apps/electron/src/renderer/App.tsx` roteia `FilePreviewState` para overlays.
- Mermaid já é referência direta:
  - inline markdown: `packages/ui/src/components/markdown/MarkdownMermaidBlock.tsx`
  - fullscreen: `packages/ui/src/components/overlay/MermaidPreviewOverlay.tsx`
  - zoom/pan: `useRichBlockInteractions` + `ZoomControls`

## Demo do excalidraw-mcp
O GIF mostra um MCP App retornando uma UI resource (`create_view`) que renderiza um canvas Excalidraw embutido no chat, com streaming/progressão de elementos.

Isso é diferente de simplesmente abrir um arquivo `.excalidraw.md`:

1. **MCP Apps route** — suportar `registerAppTool` / `ui://...` no renderer do Craft e renderizar iframe/app resources vindos do MCP. Mais genérico, maior.
2. **Native file preview route** — implementar overlay nativo para `.excalidraw` / `.excalidraw.md`. Mais rápido e suficiente para o que criamos no Obsidian.

## Caminho recomendado agora
Implementar **Native file preview** primeiro.

### Formatos a suportar
1. `.excalidraw` — JSON Excalidraw direto.
2. `.excalidraw.md` do Obsidian — markdown com bloco:
   ```compressed-json
   <LZString.compressToBase64 do scene JSON>
   ```

O workspace já usa esse padrão.

### Dependências prováveis
Adicionar no pacote UI/app:

- `@excalidraw/excalidraw` — para `exportToSvg` ou componente `<Excalidraw />`.
- `lz-string` — para `decompressFromBase64`.

Alternativa: implementar só `lz-string` local, mas pacote é melhor.

### Componentes novos
- `packages/ui/src/components/overlay/ExcalidrawPreviewOverlay.tsx`
  - recebe `filePath`, `content`, `theme`
  - parseia `.excalidraw` ou `.excalidraw.md`
  - renderiza SVG exportado ou canvas view-only
  - reutiliza `PreviewOverlay`, `ZoomControls`, `useRichBlockInteractions`

- `packages/ui/src/components/markdown/MarkdownExcalidrawBlock.tsx` opcional
  - para code fence futuro, ex: ```excalidraw-json

### Integrações
- `packages/ui/src/lib/file-classification.ts`
  - adicionar type `'excalidraw'`
  - especial-case para basename terminando em `.excalidraw.md` antes de `md`
  - aceitar `.excalidraw`

- `apps/electron/src/renderer/hooks/useLinkInterceptor.ts`
  - adicionar `ExcalidrawPreview` no union
  - tratar como text-based file

- `apps/electron/src/renderer/App.tsx`
  - importar `ExcalidrawPreviewOverlay`
  - case `excalidraw`

- `packages/ui/src/index.ts`
  - exportar overlay novo

## MVP de preview
MVP deve:

- abrir link para `.excalidraw.md` no Craft
- detectar como Excalidraw, não markdown genérico
- descomprimir `compressed-json`
- renderizar o scene JSON como SVG/canvas
- fullscreen com pan/zoom
- botão copy JSON
- botão Open/Revelar já vem do `PreviewOverlay`

## Depois
Fase 2: suporte a MCP Apps de verdade no Craft.

Isso permitiria rodar `excalidraw-mcp` remoto/local e mostrar o `create_view` diretamente como card interativo de tool call, igual o GIF. Exige suporte renderer para MCP App resources (`ui://...`) e sandbox/iframe/CSP para tool results.
