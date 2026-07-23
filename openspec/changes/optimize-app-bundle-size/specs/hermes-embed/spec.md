## MODIFIED Requirements

### Requirement: Runtime Hermes vendorizado

O sistema MUST empacotar o runtime Hermes Python/ACP em
`apps/electron/resources/vendor/hermes` no checkout de desenvolvimento e em
`app/vendor/hermes` no pacote Electron.

O driver do playwright (usado apenas pelo bot do Google Meet) NÃO DEVE ser
embarcado no runtime vendorizado; ele SHALL ser obtido **on-demand** no primeiro
uso do bot do Meet. As demais dependências (Python, `hermes-venv`, source mirror
`hermes-agent`, binários auxiliares) permanecem vendorizadas como hoje.

#### Scenario: Bundle gera runtime

- **WHEN** o bundle Hermes é executado para release ou desenvolvimento
- **THEN** o runtime gerado contém Python, `hermes-venv`, source mirror `hermes-agent` e binários auxiliares sob `apps/electron/resources/vendor/hermes`
- **AND** o driver do playwright NÃO está presente no `hermes-venv` empacotado

#### Scenario: Package inclui runtime sem duplicação

- **WHEN** o pacote Electron é produzido
- **THEN** `electron-builder` inclui o runtime via `extraResources` em `app/vendor/hermes` e `copy-assets.ts` exclui `resources/vendor/hermes` de `dist/resources`

#### Scenario: Bot do Meet baixa playwright no primeiro uso

- **GIVEN** um app empacotado sem o driver do playwright no `vendor/hermes`
- **WHEN** o bot do Google Meet é iniciado pela primeira vez com rede disponível
- **THEN** o playwright (driver + chromium) é baixado on-demand com feedback de progresso
- **AND** usos subsequentes do bot funcionam sem novo download
- **AND** o primeiro uso offline falha com erro claro em vez de crash silencioso
