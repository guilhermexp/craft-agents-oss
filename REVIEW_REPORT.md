# Review Report

Data: 2026-05-11

## Escopo auditado

- Branch atual em `56b3711` (`merge: feat/channels`).
- Commits recentes revisados via `git log --oneline -n 20`, com foco no conjunto Hermes/Channels/Meetings entre `79d5b84` e `56b3711`.
- Working tree dirty revisada:
  - release/package Hermes: `electron-builder.yml`, `copy-assets.ts`, `afterPack-hermes.cjs`, `build-dmg.sh`, `scripts/build/darwin.ts`;
  - seed/runtime Hermes: `packages/shared/src/hermes/seed.ts`, `apps/electron/resources/hermes-seed/**`, `apps/electron/src/main/index.ts`;
  - Settings/RPC env Hermes: `HermesMessengersConfig.tsx`, `packages/server-core/src/handlers/rpc/hermes.ts`;
  - docs: `apps/electron/README.md`, `apps/electron/docs/hermes-embed.md`, `apps/electron/resources/AGENTS.md`.

## Findings

### Corrigido: caminho de seed Hermes desalinhado no skill embarcado

O novo seed skill documentava o caminho macOS empacotado como:

```txt
Craft Agents.app/Contents/Resources/app/resources/hermes-seed/
```

Mas o contrato real do build e os docs atualizados apontam para:

```txt
Craft Agents.app/Contents/Resources/app/dist/resources/hermes-seed/
```

Impacto: em instalação limpa, um agente Hermes poderia procurar a skill seed no local errado e diagnosticar falso problema de empacotamento.

Correção aplicada:

- `apps/electron/resources/hermes-seed/skills/craft-embedded-runtime/SKILL.md` agora usa `Contents/Resources/app/dist/resources/hermes-seed/`.

### Corrigido: bootstrap de seed sem cobertura dedicada

`ensureHermesSeedSkills()` era uma superfície nova sem teste direto para os contratos mais importantes: copiar seed ausente, preservar edição do usuário e rejeitar caminho inseguro no manifest.

Correção aplicada:

- `packages/shared/src/hermes/__tests__/seed.test.ts` cobre:
  - cópia de skill seed ausente para `CRAFT_HERMES_HOME`;
  - preservação de skill já existente/editada pelo usuário;
  - rejeição de manifest com path traversal.
- `packages/shared/src/hermes/seed.ts` agora rejeita path absoluto, backslash e segmento `..` no manifest antes de copiar.

## Documentação

Docs revisadas e alinhadas ao contrato atual:

- `apps/electron/README.md`: descreve layout de release, paths obrigatórios e verificação manual.
- `apps/electron/docs/hermes-embed.md`: descreve `app/vendor/hermes`, `dist/resources/hermes-seed`, exclusão de runtime duplicado e smoke esperado.
- `apps/electron/resources/AGENTS.md`: distingue assets legados sincronizados de seed Hermes e runtime gerado.
- `apps/electron/resources/hermes-seed/README.md`: compatível com o fluxo copy-if-missing.
- `apps/electron/resources/hermes-seed/skills/craft-embedded-runtime/SKILL.md`: corrigido para o path empacotado real.

## Validação executada

Passou:

```bash
bun test packages/shared/src/hermes/__tests__/seed.test.ts \
  packages/shared/src/hermes/__tests__/acp-config.test.ts \
  packages/shared/src/hermes/__tests__/runtime-config.test.ts \
  packages/shared/src/hermes/__tests__/auth-bridge.test.ts
```

Resultado: `43 pass`, `0 fail`.

Passou:

```bash
bun run typecheck:shared
```

Passou:

```bash
bun test packages/shared/src/agent/__tests__/hermes-agent.test.ts \
  apps/electron/src/transport/__tests__/channel-map-parity.test.ts
```

Resultado: `16 pass`, `0 fail`.

Passou:

```bash
git diff --check
```

## Validação bloqueada pelo ambiente

A suíte focada completa recomendada para Hermes/Craft não pôde concluir neste sandbox porque o ambiente bloqueia bind local em `127.0.0.1`.

Comando que falhou:

```bash
bun test packages/shared/src/hermes/__tests__/acp-config.test.ts \
  packages/shared/src/hermes/__tests__/auth-bridge.test.ts \
  packages/shared/src/mcp/session-tools-server.test.ts \
  packages/shared/src/agent/__tests__/hermes-agent.test.ts \
  packages/server-core/src/handlers/rpc/hermes.test.ts \
  apps/electron/src/transport/__tests__/channel-map-parity.test.ts \
  packages/shared/src/hermes/__tests__/seed.test.ts
```

Evidência de ambiente:

- `node` smoke mínimo com `server.listen(0, '127.0.0.1')` falhou com `EPERM`.
- `bun` smoke mínimo equivalente falhou reportando `EADDRINUSE` para `listen(0)`.
- Os testes que falharam dependem de servidores HTTP locais efêmeros: `session-tools-server.test.ts` e partes de `hermes.test.ts`.

Recomendação: rerodar a suíte completa fora deste sandbox/restrição de rede local antes de empacotar release.

## Riscos remanescentes

- Não rodei `bun run electron:dist:mac` nem `bun run bundle:hermes`, porque são builds de release pesados e dependem de runtime/assinatura/artefatos locais. Os scripts agora têm verificações fail-closed para runtime Hermes e seed manifest, mas o pacote final ainda precisa ser validado em ambiente de release.
- A mudança de restart automático do gateway após alteração de env foi revisada por diff, mas os testes de handler RPC que exercitam dashboard HTTP local ficaram bloqueados pelo sandbox.

