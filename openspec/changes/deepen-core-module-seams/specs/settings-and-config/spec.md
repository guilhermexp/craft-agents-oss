## ADDED Requirements

### Requirement: Config migrations are data with runtime identity

As fases de migration SHALL ser declaradas como dados ordenados, cada uma com
um `id` disponível em runtime. Um runner puro sobre a configuração SHALL
devolver a configuração resultante, os ids aplicados e a falha, se houver. A
ordenação SHALL ser legível como uma lista, não inferida de comentários.

#### Scenario: rodar de novo não aplica nada

- **GIVEN** uma configuração já migrada
- **WHEN** o runner roda outra vez
- **THEN** nenhuma fase é aplicada e a configuração fica inalterada

#### Scenario: falha nomeia a fase e bloqueia o boot

- **GIVEN** uma fase de migration que lança
- **WHEN** o runner a alcança
- **THEN** ele para naquela fase, reporta o `id` dela e o boot é bloqueado
- **AND** nenhuma escrita parcial de configuração acontece

### Requirement: One table decides artifact kind to schema

A decisão "que tipo de artefato é este e qual schema se aplica" SHALL existir
uma única vez, como tabela. Detecção e validação SHALL compartilhar essa
tabela, e a interface de validação exposta a consumidores SHALL aceitar o tipo
mais a entrada (conteúdo ou caminho) em vez de um método por artefato.

#### Scenario: um tipo de artefato novo é uma entrada de tabela

- **GIVEN** um tipo novo de arquivo de configuração
- **WHEN** ele passa a ser validado
- **THEN** só a tabela muda, sem novos métodos em cada consumidor

#### Scenario: um artefato tem um schema só

- **GIVEN** um skill em disco
- **WHEN** consumidores diferentes o validam
- **THEN** todos usam o mesmo schema, com uma única declaração no repo
