## Context

O app Electron expõe settings em páginas registradas no renderer para app/env, AI, Hermes, appearance, input, workspace, permissions, labels, messaging, server, shortcuts e preferences. A área Hermes subdivide o fluxo em messengers, skills, logs, AI models e profiles, enquanto o contrato de produto também trata workspace e Hermes como superfícies explícitas de configuração.

`packages/shared/src/config` é a camada compartilhada para preferences, themes, storage, validators, LLM connections, defaults e migrations de startup. `packages/server-core/src/handlers/rpc/settings.ts` e handlers vizinhos expõem essas configurações por RPC para o renderer, com escopo por app, usuário ou workspace conforme o setting.

## Goals / Non-Goals

**Goals:**

- Registrar a capability `settings-and-config` como contrato retroativo do comportamento já implementado.
- Explicitar quais settings são app-level, user-level ou workspace-level.
- Fixar persistência imediata por tab, sem botão global de salvar.
- Fixar migrations de storage como idempotentes, versionadas e bloqueantes quando falham no startup.
- Proteger regressões conhecidas em LLM connections, default thinking level, i18n parity e modelos customizados do Hermes.

**Non-Goals:**

- Não redesenhar a UI de settings.
- Não alterar armazenamento, schema ou handlers RPC nesta change.
- Não substituir a arquitetura de Hermes embutido, nem misturar `HERMES_HOME` app-scoped com `~/.hermes`.
- Não definir novos providers ou novos tipos de autenticação LLM.

## Decisions

### Settings tabs continuam como superfície renderer registrada

As tabs de settings devem continuar centralizadas no registry do renderer e expostas por componentes dedicados. Isso mantém cada tab responsável pela leitura, validação visual e chamada RPC específica, sem criar um formulário global.

Alternativa considerada: consolidar tudo em uma única página com submit global. Rejeitada porque o comportamento atual persiste alterações pontuais imediatamente e várias configurações afetam a UI ao vivo.

### Preferences são chave-valor por usuário

Preferences permanecem em arquivo JSON de usuário, com merge parcial para campos compostos como localização e preferências de diff. O conteúdo é consumido pelo app e pelo prompt do agente como preferências explicitamente definidas pelo usuário.

Alternativa considerada: mover todas as preferences para workspace config. Rejeitada porque nome, timezone, localização e notas representam o usuário, não um workspace específico.

### Themes são app-level e aplicadas ao vivo

O modo light/dark/system, preset de tema e overrides de theme devem ser resolvidos no app e aplicados ao DOM sem exigir reload. A camada compartilhada mantém merge de themes e geração de CSS variables.

Alternativa considerada: aplicar tema apenas no restart. Rejeitada porque theme é uma configuração visual interativa e a UI já depende de atualização live.

### Storage local usa migrations no startup

O storage local em `packages/shared/src/config` deve aplicar migrations no startup antes de o app usar conexões LLM, defaults ou config dependente. Migrations precisam ser idempotentes, versionadas ou marcadas quando one-shot, e devem preservar customizações do usuário quando o modo de seleção indicar ownership manual.

Alternativa considerada: migrar sob demanda no primeiro acesso de cada setting. Rejeitada porque produziria boot parcial com partes do app vendo schemas diferentes.

### Default thinking level é configuração de inferência

`defaultThinkingLevel` é app-level e serve como fallback para novas sessões, enquanto workspaces podem definir overrides próprios quando aplicável. Valores legados devem ser normalizados antes do uso.

Alternativa considerada: gravar thinking level apenas por sessão. Rejeitada porque a UI expõe default de inferência como preferência operacional do app/workspace.

### LLM connections validam antes de persistir credenciais novas

Configurações de LLM connection devem passar por validação de input e conectividade/auth quando API key ou OAuth forem fornecidos. Credenciais não devem ser persistidas como válidas quando a validação de setup falha.

Alternativa considerada: salvar primeiro e validar depois. Rejeitada porque isso deixa o app em estado aparentemente configurado, mas quebrado na primeira sessão.

### Hermes settings preservam modelos customizados

Atualizações feitas por settings/dashboard Hermes devem preservar providers customizados, `base_url` e modelos definidos pelo usuário quando o dashboard não retorna uma lista completa. Essa proteção evita resetar custom endpoints e modelos 3-tier/user-defined.

Alternativa considerada: sempre sincronizar lista de modelos do provider. Rejeitada porque providers customizados podem não ter discovery confiável e a lista do usuário é a fonte de verdade nesse modo.

## Risks / Trade-offs

- Migration bloqueante falha no startup -> Mitigar com testes focados de storage startup migration e mensagens de erro claras.
- Persistência imediata pode gravar alterações inválidas se a tab não validar input -> Mitigar mantendo validação no handler RPC e na camada compartilhada.
- Model discovery automático pode sobrescrever modelos customizados -> Mitigar com `modelSelectionMode` e guards para providers customizados/Hermes.
- Theme live update pode deixar variáveis antigas no DOM -> Mitigar aplicando resets explícitos ao trocar preset/override.
- i18n pode quebrar tabs novas silenciosamente -> Mitigar com `lint:i18n:parity` no CI.

## Migration Plan

Esta change é retroativa e não executa código. Ao arquivar a change, a capability `settings-and-config` passa a ser o contrato base para futuras alterações de settings e config.

Mudanças futuras nessa área devem atualizar a spec quando alterarem requisitos de tabs, persistência, escopo, migrations, LLM connections, Hermes settings ou i18n.

## Open Questions

- Nenhuma pergunta aberta para o bootstrap retroativo.
