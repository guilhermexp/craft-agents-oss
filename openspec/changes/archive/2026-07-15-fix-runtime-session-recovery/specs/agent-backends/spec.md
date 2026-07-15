## ADDED Requirements

### Requirement: Hermes provider recovers from subprocess death

O backend Hermes SHALL detectar a morte do subprocess ACP (exit do
`agentProcess` ou erro de I/O do pipe durante o streaming) e descartar o
provider stale, de modo que o próximo turno respawne um subprocess limpo sem
reiniciar o app. Erros de negócio (ex.: rate-limit da API) SHALL NOT derrubar
o provider.

#### Scenario: subprocess morre entre turnos

- **GIVEN** uma sessão Hermes com provider ativo e nenhum turno em andamento
- **WHEN** o subprocess Python morre (exit observado)
- **THEN** o provider stale é limpo (`cleanup` provider-level) e zerado
- **AND** o próximo turno cria um provider novo em vez de escrever num pipe morto

#### Scenario: subprocess morre no meio de um turno

- **GIVEN** uma sessão Hermes com um turno em streaming
- **WHEN** o subprocess morre ou o streaming falha com erro de I/O do pipe
- **THEN** o turno termina com evento de erro para o usuário
- **AND** o provider é resetado ao final do turno (`pendingProviderRestart`)
- **AND** o turno seguinte respawna um subprocess limpo

#### Scenario: erro de negócio não reseta o provider

- **GIVEN** uma sessão Hermes com um turno em streaming
- **WHEN** o streaming falha com um erro que não é de I/O do subprocess (ex.: rate-limit)
- **THEN** o provider existente é mantido para o próximo turno
