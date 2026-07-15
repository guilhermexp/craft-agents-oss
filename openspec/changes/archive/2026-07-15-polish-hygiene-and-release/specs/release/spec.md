## MODIFIED Requirements

### Requirement: Publicação como GitHub Release draft

O pipeline SHALL anexar todos os artefatos gerados a uma GitHub Release **draft** (não publicada automaticamente), permitindo revisão humana antes da exposição pública. Uma release parcial (nem todas as plataformas produziram artefato) MAY existir como draft, mas MUST ser sinalizada visivelmente: um job `finalize` — que roda após todos os jobs de build, mesmo quando algum falha — confere os assets da draft contra o conjunto esperado de plataformas (macOS arm64 `.dmg`, macOS x64 `.dmg`, Windows x64 `.exe`) e marca nome e corpo da draft com um aviso "⚠️ INCOMPLETE — missing: <plataformas>" quando faltar artefato. Uma draft parcial MUST NOT parecer completa.

#### Scenario: Artefatos esperados aparecem na Release draft

- **GIVEN** todos os jobs do workflow terminam com sucesso
- **WHEN** o step `softprops/action-gh-release@v2` executa com `draft: true`
- **THEN** uma Release draft com nome igual ao da tag (ex: `v0.8.13`) é criada
- **AND** os artefatos `Craft-Agents-arm64.dmg`, `Craft-Agents-x64.dmg`, `Craft-Agents-arm64.zip`, `Craft-Agents-x64.zip`, `Craft-Agents-x64.exe` estão anexados
- **AND** a Release está marcada como `draft: true` na UI do GitHub
- **AND** o job `finalize` não encontra plataformas faltantes e a draft não carrega marca de incompletude

#### Scenario: Release parcial é sinalizada, nunca silenciosa

- **GIVEN** o job Windows falhou e a draft contém apenas os artefatos macOS
- **WHEN** o job `finalize` roda (`if: always()`, após todos os builds)
- **THEN** o nome da draft ganha o prefixo "⚠️ INCOMPLETE" e o corpo lista as plataformas faltantes (ex: `Windows x64 (.exe)`)
- **AND** um humano revisando a draft vê a incompletude antes de publicar

#### Scenario: Re-run completo limpa a marca de incompletude

- **GIVEN** uma draft marcada como incompleta por um run anterior
- **WHEN** a tag é re-empurrada e todos os builds produzem seus artefatos
- **THEN** o job `finalize` remove o aviso do corpo e restaura o nome da draft para o da tag

#### Scenario: Humano publica a Release manualmente

- **GIVEN** a Release draft está pronta com todos os artefatos
- **WHEN** um mantenedor revisa o conteúdo e clica "Publish release" na UI do GitHub
- **THEN** a Release passa de draft para pública
- **AND** os artefatos ficam disponíveis para download via URL pública

#### Scenario: Tag re-empurrada não duplica Release

- **GIVEN** uma tag `v0.8.13` já gerou uma Release draft
- **WHEN** o desenvolvedor força-empurra a mesma tag (`git push -f origin v0.8.13`)
- **THEN** o workflow roda novamente
- **AND** `softprops/action-gh-release@v2` atualiza a Release existente em vez de criar duplicata

### Requirement: Tag-triggered desktop release pipeline

O sistema SHALL executar pipeline CI de release sempre que uma tag git `v*` (semver-compatível, ex: `v0.8.13`, `v1.0.0-rc.1`) for empurrada para o remoto. O pipeline SHALL produzir artefatos binários para macOS (arm64 + x64) e Windows (x64).

#### Scenario: Push de tag final dispara build multi-plataforma

- **GIVEN** o repositório tem `.github/workflows/release.yml` configurado com gatilho `on.push.tags: ['v*']`
- **WHEN** um desenvolvedor executa `git tag v0.8.13 && git push origin v0.8.13`
- **THEN** o workflow `release.yml` é disparado uma única vez
- **AND** três jobs paralelos rodam: macOS arm64 (`macos-14`), macOS x64 (`macos-13`), Windows x64 (`windows-latest`)
- **AND** cada job produz seus artefatos em `apps/electron/release/`

#### Scenario: Push de tag rc é tratado como prerelease

- **GIVEN** o workflow configura `prerelease: contains(github.ref_name, '-rc')`
- **WHEN** o desenvolvedor empurra a tag `v0.8.13-rc.1`
- **THEN** a Release criada no GitHub é marcada com flag `prerelease: true`
- **AND** o ícone "Pre-release" aparece na UI do GitHub Releases

#### Scenario: Push em branch comum não dispara release

- **GIVEN** o gatilho do workflow é exclusivamente `on.push.tags: ['v*']`
- **WHEN** um desenvolvedor faz push para `main` sem criar tag
- **THEN** o workflow `release.yml` NÃO é disparado
- **AND** apenas `validate.yml` e `validate-server.yml` rodam normalmente

#### Scenario: Falha em uma plataforma não cancela as outras

- **GIVEN** o workflow tem `strategy.fail-fast: false`
- **WHEN** o job Windows falha em `bun run electron:dist:win`
- **THEN** os jobs macOS arm64 e macOS x64 continuam até o fim
- **AND** os artefatos macOS são publicados na Release draft mesmo sem o `.exe`
- **AND** o job `finalize` marca a draft como incompleta em vez de deixá-la parecer pronta
