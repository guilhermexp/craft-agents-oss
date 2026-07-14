## 1. F5.1 — Traduzir keys meetings.* nos locales não-EN

- [ ] 1.1 Levantar programaticamente o conjunto real de keys `meetings.*` (+ `sidebar.meetings`) byte-idênticas ao en.json por locale (baseline: de=37, es=34, hu=34, ja=35, pl=35, zh-Hans=35)
- [ ] 1.2 Traduzir todas em de/es/hu/ja/pl/zh-Hans, consistentes com termos já usados no locale (common.save, sessionMenu.archive, automations.labelModel, etc.); preservar interpolações `{{var}}` e marcas (Craft, Hermes, Deepgram)
- [ ] 1.3 Manter idênticas apenas as neutras legítimas (`meetings.captureModeHermes`, `meetings.inputPlaceholder`); re-rodar o check e colar contagem antes/depois

## 2. F5.2 — Summary do main process locale-aware

- [ ] 2.1 Adicionar keys do summary em en.json + 7 locales: corpo (processing/no-transcription/interrupted/missing-key/completed com plural/empty/failed/placeholders/defaults) e labels do Markdown (Origin/Status/Link/Start/End/Transcription/Summary heading)
- [ ] 2.2 `meeting-service.ts` usa `i18n.t()` (com `setupI18n()` lazy para testes) em todas as strings PT-BR hardcoded; status reusa `meetings.status*`; owner reusa `meetings.captureMode*`
- [ ] 2.3 Trocar `toLocaleString('pt-BR')` por `toLocaleString(i18n.resolvedLanguage)`
- [ ] 2.4 Testes de meetings seguem verdes (meeting-service.test.ts + meeting-summary-service.test.ts, baseline 17 pass)

## 3. Validação

- [ ] 3.1 `bun run lint:i18n:parity` verde (paridade de keys mantida; plurais divergentes permitidos)
- [ ] 3.2 `bun run validate:ci` exit 0
- [ ] 3.3 `openspec validate complete-meetings-i18n --strict` verde
