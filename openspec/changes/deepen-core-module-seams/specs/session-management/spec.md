## ADDED Requirements

### Requirement: Session emission and persistence each have a single owner

A emissão de eventos de sessão SHALL passar exclusivamente pelo publisher de
eventos, e a persistência de sessão e mensagens SHALL passar exclusivamente
pelo store. O agregado `SessionManager` NÃO SHALL emitir eventos nem escrever
estado de sessão diretamente.

#### Scenario: um site de emissão novo não pode contornar o publisher

- **GIVEN** um caminho de lifecycle que precisa notificar o renderer
- **WHEN** ele publica um evento
- **THEN** o faz pelo publisher, preservando ordenação e batching de deltas

#### Scenario: persistência de mensagem passa pelo store

- **GIVEN** uma mutação em mensagens ou metadados de sessão
- **WHEN** ela é persistida
- **THEN** a escrita acontece pelo store, preservando semântica append-only

### Requirement: Metadata changes on a cold session preserve stored messages

Persistir uma sessão cujas mensagens ainda não foram carregadas SHALL hidratar
o conteúdo em disco antes de escrever, preservando as mutações de metadados
feitas pelo chamador. Uma mudança apenas de metadados NÃO SHALL ser descartada
nem sobrescrever o histórico persistido.

#### Scenario: renomear uma sessão fria não perde mensagens

- **GIVEN** uma sessão com mensagens em disco e nada carregado em memória
- **WHEN** apenas o nome, status ou labels mudam e a sessão é persistida
- **THEN** a mudança é gravada e as mensagens em disco permanecem intactas

### Requirement: Session behaviour is reachable through public seams in tests

O comportamento de sessão SHALL ser exercitável pelas interfaces públicas do
agregado e dos seus módulos. Testes NÃO SHALL precisar alcançar estado privado
do `SessionManager` para cobrir lifecycle, persistência ou emissão.

#### Scenario: sequência de chamada é testável, não só o predicado puro

- **GIVEN** um comportamento disparado por um evento de agente
- **WHEN** o teste o exercita
- **THEN** consegue dirigir o evento e observar a emissão sem alcançar campos privados
