## Why

Hoje o release do app desktop é manual: `bash scripts/release-mac.sh arm64` numa máquina local, sem Windows, sem CI, sem rastreabilidade de tag. Três consequências:

1. **Sem build Windows reproduzível** — `apps/electron/scripts/build-win.ps1` existe mas roda só em Windows local; ninguém na equipe atualmente faz release Windows.
2. **Sem trilha de auditoria** — qual commit gerou o DMG instalado? Quem assinou? Em qual data? Não há rastro.
3. **Débito acumulado** — `package.json` referencia 3 scripts (`release.ts`, `check-version.ts`, `oss-sync.ts`) que não existem em disco. Sintoma de fluxo de release que nunca foi formalizado.

## What Changes

- **ADDED** capability `release`: pipeline CI tag-triggered que builda macOS (arm64 + x64) e Windows (x64), publica artefatos em GitHub Release draft.
- **Workflow novo** `.github/workflows/release.yml`:
  - Gatilho: push de tag `v*` (ex: `v0.8.13`)
  - Matrix: `macos-14` (arm64), `macos-13` (x64), `windows-latest` (x64)
  - Reusa toolchain do `validate.yml`: Bun 1.3.10 + uv + `bun install --frozen-lockfile`
  - Roda `bun run electron:dist:{mac|win}` com `CSC_IDENTITY_AUTO_DISCOVERY=false` (signing off por flag)
  - Publica `.dmg`, `.zip`, `.exe` numa GH Release draft via `softprops/action-gh-release@v2`
- **Limpeza** `package.json` raiz: remover scripts fantasma `release`, `check-version`, `oss-sync` (apontam pra arquivos inexistentes).
- **Doc nova** `RELEASING.md` na raiz: passo-a-passo do release humano (bump versão → tag → push → revisar draft → publicar).

**Não-objetivos (escopo explícito do que fica fora):**
- Code signing/notarização macOS (entra em change separada `release-signing-macos`)
- Code signing Windows (entra em `release-signing-windows`)
- Auto-update via `electron-updater` apontando pro GH Releases (entra em `release-auto-update`)
- Linux build (validate-server.yml já cobre testes Linux; dist Linux não é prioridade)
- Bump automático de versão (semantic-release/changesets) — bump manual via `npm version`

## Impact

- Affected specs:
  - `release/` — ADDED (capability nova)
- Affected code:
  - `+.github/workflows/release.yml` (novo, ~80 linhas estimadas)
  - `~package.json` (remoção de 3 entradas em `scripts`, ~3 linhas)
  - `+RELEASING.md` (novo, doc curto)
- **NÃO toca**: `electron-builder.yml`, código TypeScript, validate.yml/validate-server.yml/dependabot-automerge.yml, electron-updater config.
- Bloqueado por: `init-openspec-setup` (precisa do contrato OpenSpec completo antes).
- Risco: baixo. Build unsigned é só warning de Gatekeeper/SmartScreen — não bloqueia execução com ctrl+click. Workflow disparado só por tag (não dispara em PR/push), zero risco de release acidental.
