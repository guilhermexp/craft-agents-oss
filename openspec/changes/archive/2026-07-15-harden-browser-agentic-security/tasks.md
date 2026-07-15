## 1. F1.1 — Allowlist de esquema no navigate + windowOpen

- [x] 1.1 Extrair helper `isAllowedTopLevelUrl(url): boolean` (http/https + `about:blank`) em `browser-pane-manager.ts`
- [x] 1.2 `navigate` rejeita URL não-permitida pós-normalização com erro citando o esquema bloqueado
- [x] 1.3 `setWindowOpenHandler` reusa o mesmo helper (dedup da checagem inline)
- [x] 1.4 `TODO(security)` marcando loopback/link-local como fase futura

## 2. F1.2 — Gate de evaluate no path local

- [x] 2.1 Adicionar `assertRemoteEvaluateAllowed()` em `preference-storage.ts` (fonte única do gate)
- [x] 2.2 Callback `evaluate` do `SessionManager` chama o gate antes de `bpm.evaluate`
- [x] 2.3 Default de `allowRemoteEvaluate` inalterado

## 3. F1.3 — Permissões por-partition + allow-set endurecido

- [x] 3.1 Trocar guard booleano `partitionPermissionsInitialized` por dedup por-partition (WeakSet de sessions) → handler registrado em toda partition
- [x] 3.2 Remover `clipboard-read` e `display-capture` do allow-set default (comentário de auditoria)
- [x] 3.3 Manter `media`/`geolocation`/`notifications`/`fullscreen` etc.

## 4. Testes de integração (código real)

- [x] 4.1 `navigate('file:///etc/passwd')` e `navigate('chrome://settings')` rejeitam; `navigate('https://example.com')` passa
- [x] 4.2 windowOpen nega popup `file://`
- [x] 4.3 gate de evaluate rejeita quando `allowRemoteEvaluate=false`
- [x] 4.4 `setupSessionPermissions` registra handler para 2 partitions distintas
- [x] 4.5 `clipboard-read` e `display-capture` negados por default; `geolocation` permitido

## 5. Validação

- [x] 5.1 `HOME=/tmp/craft-worker-home bun run validate:ci` → exit 0
- [x] 5.2 `openspec validate harden-browser-agentic-security --strict --no-interactive` → verde
