## Why

A auditoria de 2026-07-14 (fase F5) apontou que o módulo meetings está com
i18n incompleto em duas frentes:

1. **F5.1** — 34-37 keys do namespace `meetings.*` (mais `meetings.title` /
   `sidebar.meetings` no de) estão byte-idênticas ao `en.json` em 6 locales
   não-EN (de, es, hu, ja, pl, zh-Hans). Usuários desses idiomas veem a UI de
   meetings em inglês, inclusive o gap conhecido `meetings.configProvider`.
2. **F5.2** — o summary Markdown gerado pelo main process
   (`apps/electron/src/main/meetings/meeting-service.ts`) tem ~15 strings
   PT-BR hardcoded (corpo do summary, labels Origem/Status/Link/Início/Fim,
   status Iniciando/Em andamento/Finalizada) e `toLocaleString('pt-BR')`
   fixo. Após o fix ee22cd30 o fallback ficou EN, então um usuário
   alemão/japonês recebe um documento misto EN+PT-BR.

## What Changes

- **F5.1** — traduzir todas as keys `meetings.*` (e `sidebar.meetings`,
  `meetings.title` onde aplicável) que hoje são idênticas ao EN nos 6 locales
  não-EN, consistentes com a terminologia já usada em cada locale
  (`common.save`, `sessionMenu.archive`, etc.). Ficam idênticas apenas as
  neutras legítimas já aceitas pelo pt-BR: `meetings.captureModeHermes`
  ("Hermes", nome próprio) e `meetings.inputPlaceholder` (URL de exemplo).
- **F5.2** — mover as strings PT-BR do summary do main process para o sistema
  i18n compartilhado. O main process já inicializa `setupI18n()` e sincroniza
  o idioma via IPC `i18n:changeLanguage`, então o summary usa `i18n.t()` com
  novas keys `meetings.*` (adicionadas nos 7 locales) e
  `toLocaleString(i18n.resolvedLanguage)` no lugar do `'pt-BR'` fixo. Os
  labels de status reusam as keys existentes `meetings.status*`.

## Impact

- Specs afetadas: `meetings` (summary gerado localizado).
- Código: `packages/shared/src/i18n/locales/{de,es,hu,ja,pl,zh-Hans}.json`
  (traduções), `en.json` + 7 locales (novas keys do summary),
  `apps/electron/src/main/meetings/meeting-service.ts`.
- Paridade de keys (`lint:i18n:parity`) mantida — mesmo conjunto de keys,
  variantes plurais podem divergir por idioma (ja/zh só `_other`, pl com
  `_few`/`_many`), o que o checker já permite.
- Sem mudança de formato on-disk: summaries antigos permanecem como foram
  gerados; novos summaries saem no idioma ativo do app.
