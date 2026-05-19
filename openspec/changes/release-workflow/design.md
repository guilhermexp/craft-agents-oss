## Context

Build atual roda em laptop do desenvolvedor (macOS). Não há paridade Windows e não há trilha de auditoria. Decisão é introduzir CI tag-triggered como base, **sem** misturar signing, notarização ou auto-update — cada um vira change própria depois.

## Suposições declaradas (Think Before Coding)

| # | Suposição | Risco se errada | Mitigação |
|---|---|---|---|
| 1 | GitHub-hosted runners `macos-14` (arm64) e `macos-13` (x64) têm Xcode CLI tools + Homebrew suficientes pra rodar `bundle:hermes` (bash) | Build de Hermes Python pode falhar em runner stock | Worker valida em primeiro dry-run. Se falhar, adiciona step `brew install` específico. |
| 2 | `windows-latest` tem PowerShell + bash + Node default; `bundle:hermes:win` (PowerShell) roda | Falha em download de Python embeddable | Worker valida; fallback é usar `pwsh` action específica |
| 3 | `electron-builder` com `CSC_IDENTITY_AUTO_DISCOVERY=false` produz DMG/ZIP unsigned válidos apesar de `hardenedRuntime: true` no yml | DMG pode dar erro de codesign mesmo sem cert | Já é o comportamento do script `electron:dist:dev:mac` — comprovado funcionar |
| 4 | WhatsApp worker (`packages/messaging-gateway/dist/whatsapp-worker.cjs`) e vendor binaries (`vendor/codex/`, `vendor/copilot/`, `vendor/bun/`) são gerados/baixados via `bun install` ou scripts já invocados | Build quebra por arquivo faltante | Worker confirma; se faltar step, adiciona explícito antes de `electron:dist` |
| 5 | GH Release com 5 artefatos (`Craft-Agents-arm64.dmg`, `Craft-Agents-x64.dmg`, `Craft-Agents-arm64.zip`, `Craft-Agents-x64.zip`, `Craft-Agents-x64.exe`) cabe no limite gratuito | Limite GH Releases é 2GB/asset, ~5GB total free → ok | Anotar tamanhos no primeiro dry-run |

## Decisions

### Decision 1: Trigger por tag git (não workflow_dispatch ou semantic-release)

**O que:** workflow roda em `on.push.tags: ['v*']`.

**Por quê:**
- Reprodutível: tag aponta pra commit exato.
- Padrão da indústria — qualquer dev novo entende.
- Não exige bumpar versão via UI do GitHub (workflow_dispatch precisaria).
- Sem dependência adicional (semantic-release adiciona ~5 deps + commit convention strict).

**Trade-off aceito:** desenvolvedor precisa lembrar de `npm version patch` antes da tag. Mitigação: `RELEASING.md` documenta passo-a-passo.

### Decision 2: Hospedar artefatos em GitHub Releases (não storage próprio)

**O que:** workflow publica via `softprops/action-gh-release@v2` numa release draft.

**Por quê:**
- Zero infra adicional (já temos cluster Dokploy mas é overhead pra esta change).
- Histórico de releases na UI do GH "de graça".
- Limites GH free são suficientes pro tamanho do app.

**Trade-off aceito:** auto-update via `electron-updater` em **repo privado** exige token. Resolvido em change separada `release-auto-update` (esta change não toca electron-updater).

### Decision 3: Signing desligado por flag, não removido do `electron-builder.yml`

**O que:** workflow exporta `CSC_IDENTITY_AUTO_DISCOVERY=false` antes de `electron:dist:mac`. `electron-builder.yml` permanece com `hardenedRuntime: true` e seção de notarize comentada como hoje.

**Por quê:**
- Quando signing entrar (change futura), basta remover a flag e adicionar secrets — zero refactor.
- Manter `hardenedRuntime: true` é correto: produz binário compatível com notarização futura.

### Decision 4: Release inicial sai como **draft**, não auto-publicada

**O que:** `softprops/action-gh-release@v2` com `draft: true`. Humano revisa artefatos e clica "Publish release" na UI.

**Por quê:**
- Permite cancelar release errada (tag rasgada, build com bug detectado tarde) sem deletar release pública.
- Custo: 1 clique adicional por release. Aceitável.

### Decision 5: Não publicar `latest.yml` / `latest-mac.yml` nesta change

**O que:** workflow inclui esses arquivos como artefatos da Release, mas `electron-updater` continua apontando pra `https://agents.craft.do/electron/latest` (não muda).

**Por quê:**
- Auto-update do fork é decisão própria (vide trade-off A/B/C/D discutido). Fica pra `release-auto-update`.
- Subir os `.yml` na Release já agora **não** atrapalha: se nada lê deles, nada acontece.

### Decision 6: Limpeza dos 3 scripts fantasma cabe nesta change

**O que:** `package.json` raiz tem `release`, `check-version`, `oss-sync` apontando pra arquivos inexistentes. Esta change remove as 3 linhas.

**Por quê:**
- Housekeeping legítimo: a única razão dos scripts existirem era um release flow anterior que nunca foi finalizado. Esta change substitui esse flow.
- Surgical: 3 linhas. Sem efeito em código rodando (scripts nunca foram chamados além daqui).

**Trade-off aceito:** se algum agente externo dependia do nome `bun run release`, vai quebrar. Risco aceito — scripts não funcionavam.

## Critério verificável de done (Goal-Driven)

Após implementação:

1. `git tag v0.8.13-rc1 && git push origin v0.8.13-rc1` dispara `release.yml`.
2. Workflow termina verde em ≤ 30 minutos.
3. GH Release draft `v0.8.13-rc1` existe com no mínimo:
   - `Craft-Agents-arm64.dmg`
   - `Craft-Agents-x64.dmg`
   - `Craft-Agents-arm64.zip`
   - `Craft-Agents-x64.zip`
   - `Craft-Agents-x64.exe`
4. Download de cada artefato funciona (≥ 100MB cada esperado).
5. DMG arm64 abre no Mac Apple Silicon após ctrl+click → Open.
6. `package.json` raiz **não** contém mais entradas `release`, `check-version`, `oss-sync` em `scripts`.
7. `RELEASING.md` existe na raiz com passo-a-passo numerado.
8. `bun run typecheck:electron` continua passando (validate:ci pulado nesta change devido a TS error pré-existente não-relacionado, tracked separadamente).

## Open questions

Nenhuma bloqueante. Possíveis follow-ups (não desta change):
- Cache de `bun install` cross-runs pra acelerar workflow.
- Build arm64 Windows (não suportado por electron-builder com NSIS estável hoje).
- Universal binary macOS (vs arm64+x64 separados) — decisão depende de telemetria de usuários.
