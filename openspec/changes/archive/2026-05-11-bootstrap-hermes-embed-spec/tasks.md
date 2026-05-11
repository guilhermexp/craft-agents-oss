## 1. Runtime e empacotamento

- [x] 1.1 Implementar bundling do runtime Python em `apps/electron/scripts/bundle-hermes.sh`.
- [x] 1.2 Implementar bundling equivalente no Windows em `apps/electron/scripts/bundle-hermes.ps1`.
- [x] 1.3 Configurar `electron-builder.yml` para empacotar `resources/vendor/hermes` como `app/vendor/hermes`.
- [x] 1.4 Excluir runtime Hermes duplicado de `dist/resources` em `apps/electron/scripts/copy-assets.ts`.
- [x] 1.5 Adicionar `afterPack-hermes.cjs` para limpar symlinks, restaurar venv e assinar binários macOS.

## 2. Bootstrap e isolamento

- [x] 2.1 Publicar paths `CRAFT_HERMES_*` no Electron main com `HERMES_HOME` sob `userData/hermes`.
- [x] 2.2 Garantir falha fechada em app empacotado quando o Python vendorizado estiver ausente.
- [x] 2.3 Adicionar seed bootstrap em `packages/shared/src/hermes/seed.ts`.
- [x] 2.4 Wire main process para chamar `ensureHermesSeedSkills` no boot.
- [x] 2.5 Adicionar manifesto e skill seed em `apps/electron/resources/hermes-seed`.

## 3. ACP, auth e RPC

- [x] 3.1 Configurar `packages/shared/src/hermes/acp-config.ts` para command, args, env e `session.mcpServers`.
- [x] 3.2 Atualizar `packages/shared/src/agent/hermes-agent.ts` para spawn ACP stdio com `craft-session` e `craft-sources`.
- [x] 3.3 Adicionar auth bridge em `packages/shared/src/hermes/auth-bridge.ts`.
- [x] 3.4 Atualizar `packages/server-core/src/handlers/rpc/hermes.ts` para detecção, dashboard, update em dev, skills, logs, files, providers, profiles e sync de auth.
- [x] 3.5 Preservar custom provider models e `base_url` no fluxo RPC de provider/model.

## 4. Overlay e validação

- [x] 4.1 Manter patches Craft em `apps/electron/scripts/hermes-patches/*.patch`.
- [x] 4.2 Validar patches com `git apply --check` antes de aplicar no bundle.
- [x] 4.3 Testes: `packages/shared/src/hermes/__tests__/seed.test.ts` cobre copy, preserve e path traversal.
- [x] 4.4 Testes focados: `acp-config.test.ts`, `auth-bridge.test.ts`, `session-tools-server.test.ts`, `hermes-agent.test.ts`, `hermes.test.ts` e `channel-map-parity.test.ts`.
- [x] 4.5 Documentar contrato em `apps/electron/docs/hermes-embed.md`, `apps/electron/README.md`, `apps/electron/resources/AGENTS.md` e `AGENTS.md`.
