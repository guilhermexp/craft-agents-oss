## ADDED Requirements

### Requirement: One PreToolUse orchestration shared by every backend

A orquestração PreToolUse SHALL viver em um único módulo, incluindo montagem
do input, tradução dos arms de resultado, mapa de permissões pendentes e retry
pós-ativação de source. Cada backend SHALL fornecer apenas o encoder de
resposta do seu SDK. Diferenças de comportamento entre backends SHALL ser
configuração explícita desse módulo, não código duplicado.

#### Scenario: comportamento pós-ativação é configuração, não duplicação

- **GIVEN** um source ativado no meio de um turno
- **WHEN** o backend declara `rerunAfterActivation: true`
- **THEN** o pipeline é reexecutado e a tool prossegue
- **AND** com `rerunAfterActivation: false` o turno bloqueia pedindo reenvio

#### Scenario: um backend novo não reescreve a orquestração

- **GIVEN** um quarto backend
- **WHEN** ele é integrado
- **THEN** só precisa fornecer o encoder de resposta do próprio SDK

### Requirement: A permission prompt without a handler blocks

Uma tool que exija aprovação do usuário SHALL ser bloqueada quando não houver
handler de permissão registrado. Nenhum backend SHALL auto-permitir nesse
caso, porque a aprovação não pode ser obtida.

#### Scenario: ausência de handler bloqueia em vez de permitir

- **GIVEN** uma sessão em modo que exige aprovação
- **WHEN** uma tool exige prompt e nenhum handler está registrado
- **THEN** a chamada é bloqueada com motivo explícito

### Requirement: Pending permissions live in one place

O estado de permissões pendentes e a resposta a elas SHALL ser mantidos uma
única vez, compartilhados pelos backends, do mesmo modo que as perguntas
pendentes ao usuário já são.

#### Scenario: abortar um turno resolve as permissões pendentes

- **GIVEN** uma permissão pendente em qualquer backend
- **WHEN** o turno é abortado
- **THEN** a pendência é liberada por um único caminho de limpeza

#### Scenario: "always allow" whitelists em qualquer backend

- **GIVEN** uma permissão pendente aprovada com "always allow"
- **WHEN** o backend é Claude ou Pi
- **THEN** o mesmo caminho grava a whitelist a partir do mapa de pendências
  compartilhado — domínio de destino para curl/wget, comando-base para o resto
- **AND** isso resolve a quinta divergência: o Pi antigo ignorava a flag por
  construção (sua entrada pendente não carregava command/baseCommand), então
  "always allow" não fazia nada nele — a unificação é deliberada e permissiva
