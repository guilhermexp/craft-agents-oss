# release Specification

## Purpose
TBD - created by archiving change release-workflow. Update Purpose after archive.
## Requirements
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

### Requirement: Toolchain do release reusa toolchain de validação

O pipeline de release SHALL usar exatamente as mesmas versões de runtime e ferramentas que `validate.yml` (Bun 1.3.10, uv) para garantir paridade entre validação e build.

#### Scenario: Versão de Bun é a mesma do validate

- **GIVEN** `.github/workflows/validate.yml` usa `oven-sh/setup-bun@v2` com `bun-version: "1.3.10"`
- **WHEN** o pipeline de release é executado
- **THEN** ele usa o mesmo `oven-sh/setup-bun@v2` com a mesma versão `1.3.10`

#### Scenario: Dependências são instaladas com lockfile congelado

- **GIVEN** o workflow inclui step `bun install --frozen-lockfile`
- **WHEN** o lockfile (`bun.lock`) e o `package.json` estão divergentes
- **THEN** o build falha em `bun install` antes de produzir qualquer artefato
- **AND** nenhum dos próximos steps roda

### Requirement: Build unsigned por flag de ambiente

O pipeline SHALL produzir builds não-assinados (unsigned) por padrão, controlado por variável de ambiente `CSC_IDENTITY_AUTO_DISCOVERY=false`. A configuração do `electron-builder.yml` SHALL permanecer compatível com signing futuro (campos `hardenedRuntime`, `entitlements`, `notarize` preservados).

#### Scenario: Build macOS roda sem cert mas com hardened runtime preservado

- **GIVEN** `electron-builder.yml` tem `mac.hardenedRuntime: true` e seção `notarize` comentada
- **AND** o env do workflow define `CSC_IDENTITY_AUTO_DISCOVERY=false`
- **WHEN** `bun run electron:dist:mac` é executado no runner
- **THEN** o DMG é gerado sem erro de codesign
- **AND** o app embutido tem hardened runtime habilitado (pronto pra notarização quando cert chegar)

#### Scenario: Build Windows roda sem certificado

- **GIVEN** nenhum secret `CSC_LINK` está configurado
- **WHEN** `bun run electron:dist:win` é executado em `windows-latest`
- **THEN** o instalador NSIS `.exe` é gerado sem signing
- **AND** o usuário final verá warning do SmartScreen ao executar (esperado nesta fase)

### Requirement: Publicação como GitHub Release draft

O pipeline SHALL anexar todos os artefatos gerados a uma GitHub Release **draft** (não publicada automaticamente), permitindo revisão humana antes da exposição pública.

#### Scenario: Artefatos esperados aparecem na Release draft

- **GIVEN** todos os jobs do workflow terminam com sucesso
- **WHEN** o step `softprops/action-gh-release@v2` executa com `draft: true`
- **THEN** uma Release draft com nome igual ao da tag (ex: `v0.8.13`) é criada
- **AND** os artefatos `Craft-Agents-arm64.dmg`, `Craft-Agents-x64.dmg`, `Craft-Agents-arm64.zip`, `Craft-Agents-x64.zip`, `Craft-Agents-x64.exe` estão anexados
- **AND** a Release está marcada como `draft: true` na UI do GitHub

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

### Requirement: Permissions mínimas

O workflow SHALL declarar permissions explícitas e mínimas (`contents: write`) em vez de herdar permissões padrão da org.

#### Scenario: Workflow declara permissions explícitas

- **GIVEN** o arquivo `.github/workflows/release.yml`
- **WHEN** lido por um humano ou ferramenta de auditoria
- **THEN** o bloco `permissions:` no nível do workflow lista exatamente `contents: write`
- **AND** nenhuma outra permission (`packages`, `id-token`, etc.) é concedida

