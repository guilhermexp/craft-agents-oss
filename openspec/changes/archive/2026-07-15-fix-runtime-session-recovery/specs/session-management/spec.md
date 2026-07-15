## ADDED Requirements

### Requirement: supportsBranching resolves by provider when the agent is lazy

O server SHALL resolver `supportsBranching` a partir do provider da conexão da
sessão (capability declarativa por backend) quando o agent da sessão é lazy
(null — ex.: sessão restaurada após restart), em vez de assumir `true`.
Sessões Hermes SHALL reportar `supportsBranching=false`; sessões Claude/Pi
continuam `true`.

#### Scenario: sessão Hermes restaurada reporta supportsBranching=false

- **GIVEN** uma sessão Hermes persistida cujo agent ainda não foi instanciado (lazy/null)
- **WHEN** a sessão é serializada para o cliente
- **THEN** `supportsBranching` é `false`

#### Scenario: sessão Claude/Pi lazy segue suportando branch

- **GIVEN** uma sessão Claude ou Pi com agent lazy
- **WHEN** a sessão é serializada para o cliente
- **THEN** `supportsBranching` é `true`

### Requirement: Branch requests are rejected for backends without branching support

O server SHALL rejeitar `branchFromSessionId`/`branchFromMessageId` na criação
de sessão quando o backend alvo resolvido não suporta branching (Hermes), com
erro claro, em vez de criar uma sessão-branch com amnésia silenciosa.

#### Scenario: branch a partir de sessão Hermes é rejeitado

- **GIVEN** uma sessão fonte cujo provider resolvido é Hermes
- **WHEN** o cliente pede `createSession` com `branchFrom*` apontando para ela
- **THEN** a criação falha com erro indicando que o backend não suporta branching
- **AND** nenhuma sessão-branch é criada

#### Scenario: branch Claude/Pi permanece funcional

- **GIVEN** uma sessão fonte Claude ou Pi válida
- **WHEN** o cliente pede `createSession` com `branchFrom*`
- **THEN** a validação de branch existente segue o fluxo normal (sdk-fork)
