## ADDED Requirements

### Requirement: Repositório mantém contrato OpenSpec completo

O repositório SHALL manter um setup OpenSpec completo: `openspec/project.md` escrito à mão descrevendo Purpose/Tech Stack/Conventions/Commands, `openspec/AGENTS.md` gerado pelo CLI, e bloco managed em `AGENTS.md` raiz apontando pra documentação OpenSpec.

#### Scenario: Agente novo entra no repo e enxerga contrato

- **GIVEN** o repositório tem `openspec/project.md`, `openspec/AGENTS.md` e `AGENTS.md` raiz com bloco managed
- **WHEN** um agente automatizado (Claude/Codex/Ralphy) inicia uma sessão no repositório
- **THEN** ele encontra o bloco `<!-- OPENSPEC:START --> @/openspec/AGENTS.md <!-- OPENSPEC:END -->` no `AGENTS.md` raiz
- **AND** segue o link e lê as instruções sobre como criar/validar changes
- **AND** consegue executar `openspec list` e `openspec validate` sem configuração extra

#### Scenario: project.md descreve estado real do projeto

- **GIVEN** o arquivo `openspec/project.md`
- **WHEN** lido por humano ou agente
- **THEN** contém seção `## Purpose` com 1 parágrafo sobre o produto
- **AND** contém seção `## Tech Stack` listando linguagens, frameworks, runtimes e ferramentas de build
- **AND** contém seção `## Conventions` cobrindo estilo, padrões de import, naming
- **AND** contém seção `## Commands` com comandos canônicos (`bun run electron:dev`, `bun run validate:ci`, etc.)

### Requirement: Slash commands opsx ficam disponíveis em projetos com Claude Code

O repositório SHALL incluir os slash commands `/opsx:propose`, `/opsx:explore`, `/opsx:apply` e `/opsx:archive` em `.claude/commands/opsx/` para invocação dentro do Claude Code do projeto.

#### Scenario: openspec init gera comandos opsx

- **GIVEN** o CLI `openspec` versão ≥ 1.3.1 está disponível
- **WHEN** `openspec init --tools claude --force` é executado na raiz do repositório
- **THEN** os arquivos `.claude/commands/opsx/propose.md`, `.claude/commands/opsx/explore.md`, `.claude/commands/opsx/apply.md` e `.claude/commands/opsx/archive.md` são criados
- **AND** o agente roda `/opsx:apply <change-id>` em uma sessão Claude Code

### Requirement: openspec update mantém arquivos managed sincronizados

A documentação dos arquivos managed pelo CLI (`openspec/AGENTS.md` e `.claude/commands/opsx/*.md`) SHALL ser regenerada após upgrade do CLI sem destruir conteúdo escrito à mão (como `openspec/project.md` ou specs).

#### Scenario: Upgrade do CLI não toca specs ou project.md

- **GIVEN** o CLI foi atualizado para uma versão nova
- **WHEN** um mantenedor executa `openspec update`
- **THEN** `openspec/AGENTS.md` e `.claude/commands/opsx/*.md` são regenerados com o template novo
- **AND** `openspec/project.md` permanece exatamente como estava
- **AND** arquivos em `openspec/specs/**` permanecem exatamente como estavam
