## Why

A auditoria de segurança de 2026-07-14 encontrou uma cadeia de exfiltração de
credenciais explorável via **prompt-injection** no in-app browser controlado
pelo agente. Um agente comprometido por conteúdo malicioso de uma página pode:

1. **Ler arquivos locais / fazer SSRF** — `browser_tool navigate` aceita
   qualquer esquema. `navigate('file:///Users/…/.aws/credentials')`,
   `file://…/.env`, `id_rsa`, ou `http://169.254.169.254/…` carregam no
   `webContents` e ficam legíveis via snapshot/screenshot/evaluate.
2. **Executar JS arbitrário sem gate** — `browser_tool evaluate` no path local
   (agente → SessionManager) não checa `allowRemoteEvaluate`, ao contrário do
   path remoto (dispatcher) que já valida.
3. **Ganhar permissões sensíveis sem prompt** — o handler de permissões só é
   registrado na **primeira** partition (guard booleano de instância), então
   profiles secundários caem no default permissivo do Electron; e o allow-set
   default concede `clipboard-read` e `display-capture` a qualquer origem.

Juntos, esses três dão a um atacante um caminho leitura-de-arquivo →
exfiltração dentro do próprio agente confiável.

## What Changes

- **F1.1** — `navigate` passa a validar o esquema pós-normalização: só
  `http:`/`https:` (+ `about:blank`) são permitidos; `file:`, `chrome:`, etc.
  são rejeitados com erro claro. A validação é extraída para um helper
  compartilhado `isAllowedTopLevelUrl(url)` reusado por `navigate` e pelo
  `setWindowOpenHandler` (popups), que já fazia a mesma checagem inline.
- **F1.2** — o gate `allowRemoteEvaluate` passa a valer também no path local
  (`SessionManager` → `bpm.evaluate`), fechando o bypass. O default da config
  **não muda** nesta fase.
- **F1.3** — o handler de permissões passa a ser registrado **por partition**
  (não só na primeira); e `clipboard-read` + `display-capture` saem do
  allow-set default (negados, revisáveis). `media`/`geolocation`/`notifications`/
  `fullscreen` etc. permanecem (podem ser features do browser agêntico).

- **Não-objetivo**: bloquear loopback/link-local nesta fase (marcado como
  `TODO(security)`), mudar o default de `allowRemoteEvaluate`, ou remover
  `media`/`geolocation` do allow-set.

## Impact

- Affected specs: `session-tools-mcp` (ADDED requirements de segurança do
  browser agêntico).
- Affected code:
  - `apps/electron/src/main/browser-pane-manager.ts` — helper de allowlist de
    esquema, gate no `navigate`, handler de permissões por-partition, allow-set
    default endurecido.
  - `packages/server-core/src/sessions/SessionManager.ts` — gate
    `allowRemoteEvaluate` no callback `evaluate` local.
  - `packages/shared/src/config/preference-storage.ts` — helper
    `assertRemoteEvaluateAllowed()` (fonte única do gate).
- Risco: baixo/médio. Muda comportamento observável do browser agêntico
  (esquemas não-http, clipboard/display-capture). Coberto por testes de
  integração contra o código real.
