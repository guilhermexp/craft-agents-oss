## ADDED Requirements

### Requirement: The network interceptor resolves to the workspace-root source

Em runs não empacotados, a resolução do interceptor SHALL devolver o arquivo
canônico na raiz do workspace, independentemente do diretório de trabalho. A
busca ascendente NÃO SHALL casar caminhos sob `apps/electron/packages/`, e os
scripts de empacotamento SHALL montar cópias apenas em diretórios de saída que
não colidam com o padrão de busca do resolver.

#### Scenario: rodar a partir de apps/electron resolve o canônico

- **GIVEN** um run não empacotado com `appRootPath` em `apps/electron`
- **AND** uma cópia stale do interceptor presente sob `apps/electron/packages/`
- **WHEN** o caminho do interceptor é resolvido
- **THEN** o arquivo devolvido é o da raiz do workspace

#### Scenario: manifests de empacotamento leem a fonte canônica da raiz do workspace

- **GIVEN** os manifests de empacotamento de macOS, Windows e Linux
- **WHEN** eles declaram as entradas `extraResources` do interceptor
- **THEN** cada `from:` aponta para a fonte canônica em `packages/shared/src` na raiz do workspace, que sempre existe (inclusive no CI, onde o staging dos scripts não roda)
- **AND** os scripts de build montam cópias apenas sob `dist/`, nunca sob `apps/electron/packages/`
