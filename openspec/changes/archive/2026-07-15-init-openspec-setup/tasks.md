## 1. Rodar openspec init

- [x] 1.1 Confirmar versão `openspec --version` (esperado: ≥ 1.3.1)
- [x] 1.2 Rodar `openspec init --tools claude --force` na raiz do repositório
- [x] 1.3 Confirmar criação de `openspec/AGENTS.md`
- [x] 1.4 Confirmar criação de `.claude/commands/opsx/{propose,explore,apply,archive}.md`

## 2. Escrever openspec/project.md

- [x] 2.1 Criar `openspec/project.md` com seções obrigatórias:
  - `## Purpose` — 1 parágrafo descrevendo o produto (Claude Code-like agent for Craft documents)
  - `## Tech Stack` — Electron 41 + Bun 1.3.10 + TypeScript + Vite + electron-builder; Python (Hermes runtime embedded); subprocess: WhatsApp worker, Codex CLI, Copilot CLI
  - `## Conventions` — Bun como runtime + package manager; ESLint + eslint-plugin-react; workspaces (`packages/*`, `apps/*`); imports diretos (sem barrel files conforme CLAUDE.md global); i18n via `lint:i18n:parity`
  - `## Commands` — `bun run electron:dev`, `bun run validate:ci`, `bun run typecheck`, `bun run lint`, `bun run electron:dist:{mac,win,linux}`, `bash scripts/release-mac.sh [arm64|x64]`
- [x] 2.2 Conferir que o arquivo é coerente com o estado atual (não inventar comandos)

## 3. Atualizar AGENTS.md raiz

- [x] 3.1 Ler `AGENTS.md` raiz e identificar se já existe bloco `<!-- OPENSPEC:START -->`
- [x] 3.2 Se não existe: anexar ao final do arquivo o bloco managed:
  ```
  <!-- OPENSPEC:START -->
  @/openspec/AGENTS.md
  <!-- OPENSPEC:END -->
  ```
- [x] 3.3 Não remover/reescrever conteúdo Hermes-contract pré-existente

## 4. Validação final

- [x] 4.1 Rodar `openspec list` — confirmar que esta change aparece como ativa
- [x] 4.2 Rodar `openspec validate init-openspec-setup --strict --no-interactive` — verde
- [x] 4.3 Confirmar que `bun run validate:ci` continua passando — RESOLVIDO 2026-07-15 (PR #3): o bloqueio não era TS error, eram 3 testes obsoletos `restoreOpus46` (função dead-code); removidos na F0. `validate:ci` exit 0.
- [x] 4.4 Reportar: paths criados/modificados + saída de `openspec list` (reportado no chat de orquestração 2026-05-19)
