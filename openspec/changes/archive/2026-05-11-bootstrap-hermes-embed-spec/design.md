## Context

O Craft Agents OSS já executa Hermes como um backend separado em Python via ACP stdio. A interface Electron publica variáveis `CRAFT_HERMES_*`, o backend compartilhado normaliza essas variáveis, `HermesAgent` cria um provider ACP e o subprocesso Python vendorizado executa `-m acp_adapter`.

Arquitetura observada:

```text
renderer/settings
  -> Electron main
  -> server-core RPC hermes.ts
  -> HermesAgent
  -> ACP stdio
  -> bundled Python em app/vendor/hermes
```

Os componentes atuais são:

- vendor de runtime: `apps/electron/scripts/bundle-hermes.{sh,ps1}` gera `apps/electron/resources/vendor/hermes` a partir de `NousResearch/hermes-agent`, pinado por `hermes-version.txt` e ajustado por `hermes-patches/*.patch`;
- seed skills bootstrap: `apps/electron/resources/hermes-seed` é copiado para o `HERMES_HOME` app-scoped por `ensureHermesSeedSkills`;
- auth bridge: `seedHermesAuthFromCraft` injeta credenciais do Craft no ambiente do subprocesso e no slot `openai-codex` de `auth.json`;
- ACP `session.mcpServers`: `HermesAgent` passa `craft-sources` e `craft-session` para Hermes sem mover ferramentas nativas para `mcp.json` global;
- RPC handler: `packages/server-core/src/handlers/rpc/hermes.ts` expõe detecção, dashboard, update em dev, logs, arquivos, skills, profiles, provider models e sync de tokens;
- packaging: `copy-assets.ts`, `electron-builder.yml` e `afterPack-hermes.cjs` separam seed, runtime vendorizado e limpeza/codesign do pacote.

## Goals / Non-Goals

**Goals:**

- Registrar o contrato implementado para o Hermes embutido no Craft.
- Preservar o isolamento entre Hermes embutido e qualquer Hermes standalone do usuário.
- Descrever as decisões que mantêm runtime, estado, MCPs, auth e packaging coerentes.
- Tornar futuras mudanças testáveis contra requisitos OpenSpec.

**Non-Goals:**

- Alterar código do runtime Hermes, scripts de bundle, RPC handlers ou specs globais.
- Redesenhar a UI de Settings ou o dashboard Hermes.
- Definir uma nova estratégia de update além do fluxo atual por dashboard em dev e release do Craft em produção.
- Migrar Craft tools para configuração global do Hermes.

## Decisions

### Runtime vendorizado por pin upstream mais patches overlay

Hermes é tratado como dependência upstream pinada, não como fork irmão mantido manualmente. O bundle resolve `hermes-version.txt` ou `HERMES_VERSION`, usa cache próprio em `apps/electron/scripts/.hermes-cache/source`, aplica `apps/electron/scripts/hermes-patches/*.patch` com `git apply --check` e gera `apps/electron/resources/vendor/hermes`.

Alternativa considerada: usar `hermes` do `PATH` ou um checkout irmão. Essa opção mistura runtime, estado e versões do usuário com o app empacotado, então fica limitada a dev fallback explícito.

### Estado app-scoped em `userData/hermes`

O Electron main resolve `HERMES_HOME` como `app.getPath('userData')/hermes` e publica `CRAFT_HERMES_HOME`. Em modo embutido, o runtime não deve ler nem escrever `~/.hermes`.

Alternativa considerada: reutilizar `~/.hermes` para compatibilidade com standalone. Isso quebra isolamento, pode vazar profiles/secrets de outro contexto e dificulta suporte de release.

### Falha fechada em build empacotado

Quando o Python vendorizado está ausente em app empacotado, o main marca `CRAFT_HERMES_REQUIRE_BUNDLED=1`; a normalização usa o comando ausente em vez de cair para `hermes` do `PATH`.

Alternativa considerada: fallback transparente para sistema. Isso esconderia erro de empacotamento e executaria um runtime não gerenciado.

### Seed conservador de skills

`resources/hermes-seed/manifest.json` lista assets de seed e `ensureHermesSeedSkills` copia apenas quando o destino não existe. O manifesto rejeita paths absolutos, `..` e backslashes.

Alternativa considerada: sobrescrever sempre a skill seed. Isso apagaria edições do usuário dentro do `HERMES_HOME`; mudanças futuras devem usar migrações versionadas explícitas.

### Ferramentas Craft via ACP `session.mcpServers`

`HermesAgent` injeta `craft-sources` e `craft-session` por sessão. Os nomes Craft são preservados no patch de MCP tool naming, enquanto MCPs externos continuam usando nomes normais do Hermes.

Alternativa considerada: escrever MCPs nativos em `mcp.json` global. Isso tornaria ferramentas de browser, sessão e delegação globais e fora do escopo da sessão Craft.

### Auth bridge scoped ao spawn

O Craft Credential Manager continua sendo a fonte de verdade. O spawn do Hermes recebe env vars de API key/OAuth e o bridge escreve tokens Codex no `auth.json` app-scoped; o handler observa refreshes e sincroniza de volta para o Craft.

Alternativa considerada: manter secrets duplicados em `.env` do Hermes. Isso criaria drift e uma segunda superfície persistente de credenciais.

## Risks / Trade-offs

- Patch overlay pode quebrar quando `upstream/main` muda → o bundle roda `git apply --check` antes de aplicar e falha antes de gerar runtime inválido.
- Runtime vendorizado aumenta tamanho do pacote → o build exclui duplicação em `dist/resources` e envia o runtime por `extraResources`.
- `HERMES_SRC` em dev pode mascarar o fluxo real de release → o contrato limita esse override a desenvolvimento curto e exige validação sem override.
- Seed copy-if-missing não atualiza conteúdo já copiado → futuras mudanças incompatíveis exigem migração versionada no manifesto.
- Auth em env vars é efêmero, mas ainda sensível em processo filho → logs devem continuar redigindo secrets e o bridge não deve gravar secrets em seed resources.
- Dashboard update só funciona em dev → builds empacotados atualizam Hermes por release do Craft, preservando assinatura e integridade do app.
