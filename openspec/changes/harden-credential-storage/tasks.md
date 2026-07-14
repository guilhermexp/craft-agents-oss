## 1. F4.4 — SSRF guard no discovery OAuth

- [ ] 1.1 `discoverOAuthMetadata` valida `mcpUrl` com `isUrlSafeToFetch` antes de qualquer fetch (cobre o probe RFC 9728 e os candidates derivados do origin)
- [ ] 1.2 Cada candidate do fallback RFC 8414 é validado antes de `tryFetchAuthServerMetadata`
- [ ] 1.3 Testes: `169.254.169.254`, `localhost`, `10.x` → bloqueado sem fetch; URL pública → discovery prossegue

## 2. F4.3a — Guard Origin/Host nos servidores MCP loopback

- [ ] 2.1 Helper `assertLoopbackRequest(req)` em `packages/shared/src/mcp/loopback-guard.ts` (Host deve ser loopback; Origin, se presente, deve ser loopback)
- [ ] 2.2 `CraftSessionToolsMcpServer` rejeita com 403 requests que falham o guard
- [ ] 2.3 `McpPoolServer` rejeita com 403 requests que falham o guard
- [ ] 2.4 Testes: Origin web externa → 403; Host não-loopback (DNS rebinding) → 403; request loopback normal (cliente MCP real) → aceito

## 3. F4.3b — Bearer opt-in (infra, desligado por default)

- [ ] 3.1 Opção `authToken` nos dois servidores; quando setada, exige `Authorization: Bearer <token>` (comparação timing-safe), senão 401
- [ ] 3.2 Nenhum caller liga o token por default (Hermes/Codex/Copilot seguem sem bearer)
- [ ] 3.3 Testes do modo com token ligado (aceita token correto, rejeita ausente/errado)
- [ ] 3.4 PENDENTE (fase futura): wiring via ACP `session.mcpServers[].headers` + validação runtime do handshake Hermes Python ↔ MCP antes de ligar

## 4. F4.2 — Seam de key protector no SecureStorageBackend (default inalterado)

- [ ] 4.1 Interface `CredentialKeyProtector` + opções de construtor (`keyProtector`, paths injetáveis para teste hermético)
- [ ] 4.2 Com protector: chave-mestra aleatória protegida em sidecar `credentials.key`; payload cifrado com ela
- [ ] 4.3 Leitura do formato atual (machine-id v2) e legado (v1) preservada; migração lazy para o protector ao carregar
- [ ] 4.4 Fallback não-destrutivo: sidecar presente + protector indisponível → load retorna null SEM deletar `credentials.enc`
- [ ] 4.5 Testes: round-trip sem protector (formato atual); leitura de arquivo antigo com protector presente + migração lazy; round-trip com protector; proteção contra deleção destrutiva
- [ ] 4.6 PENDENTE (fase futura): implementar protector real com `electron.safeStorage` no main + distribuição de chave para o server subprocess + validação em app empacotado — só então considerar trocar o default

## 5. F4.1 — Análise (sem código)

- [ ] 5.1 Documentar por que o `refresh_token` do Codex no auth.json não pode ser removido (refresh nativo do Hermes + watcher de sync reverso exige access+refresh)

## 6. Validação

- [ ] 6.1 `HOME=/tmp/craft-worker-home bun run validate:ci` → exit 0
- [ ] 6.2 Baselines: session-tools-server 11/11 (+ novos), browser-pane 64/8, meetings 17 pass
- [ ] 6.3 `openspec validate harden-credential-storage --strict` verde
