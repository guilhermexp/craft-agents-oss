## Why

O repositório já tem `openspec/specs/` com 13 capabilities, mas o setup OpenSpec está incompleto:

- Falta `openspec/project.md` (Project Context: purpose, stack, conventions, comandos canônicos)
- Falta `openspec/AGENTS.md` (gerado pelo `openspec init`, instrui agentes a usarem o contrato)
- Falta `.claude/commands/opsx/*.md` (slash commands `/opsx:propose|explore|apply|archive`)
- `AGENTS.md` raiz não tem o bloco managed `<!-- OPENSPEC:START -->` apontando pra `openspec/AGENTS.md`

Sem esse setup, qualquer agente novo entrando no repositório não enxerga o contrato vivo — o que já causou drift entre specs e implementação (3 scripts referenciados em `package.json` não existem em disco).

## What Changes

- Rodar `openspec init --tools claude --force` na raiz do repositório (gera `openspec/AGENTS.md` + `.claude/commands/opsx/*.md`)
- Escrever `openspec/project.md` denso à mão com: Purpose, Tech Stack, Conventions (TypeScript/Bun/Electron padrões), Comandos Canônicos (test, lint, build, dev)
- Garantir bloco managed em `AGENTS.md` raiz:
  ```
  <!-- OPENSPEC:START -->
  @/openspec/AGENTS.md
  <!-- OPENSPEC:END -->
  ```
  Sem sobrescrever conteúdo Hermes-contract existente no arquivo.
- **Não-objetivo**: popular retroativamente as 13 specs já existentes (entram conforme tocamos).
- **Não-objetivo**: criar capability nova nesta change.

## Impact

- Affected specs: nenhuma (change operacional, sem capabilities novas/modificadas).
- Affected code:
  - `openspec/AGENTS.md` (criado por init)
  - `openspec/project.md` (novo)
  - `AGENTS.md` raiz (acréscimo do bloco managed, sem remoção de conteúdo)
  - `.claude/commands/opsx/{propose,explore,apply,archive}.md` (criados por init)
- Bloqueia: `release-workflow` (próxima change que documenta workflow CI em spec — depende do contrato estar completo)
- Risco: baixo. `openspec init --force` regenera só arquivos managed; conteúdo escrito à mão não é tocado.
