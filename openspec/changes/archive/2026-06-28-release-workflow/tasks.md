## Fasing

| Fase | Sections | Escopo |
|---|---|---|
| F1 | 1, 2 | Workflow release.yml + dry-run em runner GH |
| F2 | 3 | Housekeeping package.json (3 scripts fantasma) |
| F3 | 4 | Doc RELEASING.md |
| F4 | 5 | Validação final + handoff |

## 1. Workflow .github/workflows/release.yml

- [x] 1.1 Criar `.github/workflows/release.yml` com:
  - `on.push.tags: ['v*']` (gatilho exclusivo — sem PR/push branch)
  - `concurrency: release-${{ github.ref }}` com `cancel-in-progress: false` (não cancelar release em curso)
  - `permissions: { contents: write }` (necessário pra criar Release)
- [x] 1.2 Job `build` com `strategy.matrix.include`:
  - `{ os: macos-14, arch: arm64, target: mac }`
  - `{ os: macos-13, arch: x64, target: mac }`
  - `{ os: windows-latest, arch: x64, target: win }`
  - `fail-fast: false` (uma plataforma falhar não cancela as outras)
- [x] 1.3 Steps comuns a todos os jobs (na ordem):
  1. `actions/checkout@v4` (sem `fetch-depth: 0` — não precisamos)
  2. `oven-sh/setup-bun@v2` com `bun-version: "1.3.10"` (mesmo do validate.yml)
  3. `astral-sh/setup-uv@v5`
  4. `bun install --frozen-lockfile`
- [x] 1.4 Step `Build artifacts` com `env.CSC_IDENTITY_AUTO_DISCOVERY: "false"`:
  - macOS: `bun run electron:dist:mac` (arquitetura nativa do runner)
  - Windows: `bun run electron:dist:win`
- [x] 1.5 Step `Upload to release draft` usando `softprops/action-gh-release@v2`:
  - `draft: true`
  - `prerelease: contains(github.ref_name, '-rc')` (auto-detect rc tags)
  - `files: apps/electron/release/Craft-Agents-*.{dmg,zip,exe,yml}`
  - `fail_on_unmatched_files: false`
  - `token: ${{ secrets.GITHUB_TOKEN }}`

## 2. Dry-run e ajustes

- [~] 2.1 Após commit do workflow, criar tag de teste: `git tag v0.0.0-rc.workflow-test && git push origin v0.0.0-rc.workflow-test` — pulado intencionalmente nesta fase; exige push/tag e runner GitHub real.
- [~] 2.2 Observar execução em `gh run watch`. Se falhar em `bundle:hermes` ou downloads vendor, adicionar step explícito antes (ex: `setup-python` ou `pwsh` actions). Documentar fix. — pulado intencionalmente nesta fase.
- [~] 2.3 Confirmar artefatos aparecem na Release draft com nomes esperados. — pulado intencionalmente nesta fase.
- [~] 2.4 Deletar tag e draft de teste após validar. — pulado intencionalmente nesta fase.

## 3. Limpeza package.json (raiz)

- [x] 3.1 Remover do bloco `scripts` em `/Users/guilhermevarela/Documents/Projetos/SelfHosting/craft-agents-oss/package.json`:
  - `"release": "bun run scripts/release.ts"`
  - `"check-version": "bun run scripts/check-version.ts"`
  - `"oss:sync": "bun run scripts/oss-sync.ts"`
- [x] 3.2 Confirmar via `bun install` que lockfile não muda (são scripts, não deps)
- [x] 3.3 Confirmar validação substituta `bun run typecheck:electron` passa; `bun run validate:ci` fica pulado conforme §5.2.

## 4. Doc RELEASING.md

- [x] 4.1 Criar `/Users/guilhermevarela/Documents/Projetos/SelfHosting/craft-agents-oss/RELEASING.md` com seções:
  - `## Quick release` — sequência canônica: `npm version patch` (ou `minor`/`major`) → confirma versão alinhada em `package.json` raiz E `apps/electron/package.json` → `git push --follow-tags` → aguarda CI verde → revisa draft no GitHub → "Publish release"
  - `## Prerelease (rc)` — `npm version 0.8.13-rc.1` para testar workflow sem expor ao público
  - `## Signing status` — link pra changes futuras (`release-signing-macos`, `release-signing-windows`) e nota explicando que builds atuais saem unsigned (Gatekeeper warning esperado)
  - `## Troubleshooting` — comandos pra rodar build local equivalente (`bun run electron:dist:mac` + `CSC_IDENTITY_AUTO_DISCOVERY=false`); como deletar release draft quebrada
- [x] 4.2 Linkar `RELEASING.md` a partir do `CONTRIBUTING.md` existente

## 5. Validação final

- [x] 5.1 Rodar `openspec validate release-workflow --strict --no-interactive` — verde
- [~] 5.2 ~~Rodar `bun run validate:ci`~~ — pulado nesta change (TS error pré-existente bloqueia, tracked separadamente). Substituído por: `bun run typecheck:electron` continua passando (escopo da change não toca TS).
- [x] 5.3 Confirmar critérios verificáveis do `design.md` seção "Critério verificável de done":
  - Release draft gerada via dry-run — pulado intencionalmente nesta fase; exige push/tag e runner GitHub real.
  - 5 artefatos esperados presentes — pulado intencionalmente nesta fase; exige push/tag e runner GitHub real.
  - package.json sem scripts fantasma
  - RELEASING.md existe e linka pra signing changes futuras
- [x] 5.4 Reportar: paths criados/modificados, saída de `openspec list`; link da Release draft de teste pulado intencionalmente nesta fase.
