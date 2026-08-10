## ADDED Requirements

### Requirement: Turno sem resposta do assistente sempre produz mensagem visível
O `SessionManager` SHALL sempre acrescentar uma mensagem de erro visível à sessão e emitir o erro
tipado correspondente quando um turno completa sem resposta do assistente **e nada indica parada
intencional**, em vez de apenas registrar um warning no log. O `SessionManager` SHALL NOT produzir
essa mensagem quando o turno foi interrompido de propósito — Stop do usuário, redirect que
interrompeu o turno, ou mensagem enfileirada aguardando replay.

#### Scenario: Erro 400 capturado mantém o diagnóstico específico
- **WHEN** o turno termina sem resposta do assistente e existe um erro de API capturado com status 400
- **THEN** a sessão recebe a mensagem `image_too_large` ou `invalid_request` já existente, sem retry

#### Scenario: Turno encerrado sem resposta e sem erro de API
- **WHEN** o turno termina sem resposta do assistente, não há erro de API 400 capturado e nenhum
  sinal de parada intencional
- **THEN** a sessão recebe uma mensagem de erro genérica informando que o turno terminou sem
  resposta, com retry habilitado

#### Scenario: Stop do usuário não vira card de erro
- **WHEN** o usuário aperta Stop antes de qualquer texto do assistente e o evento `complete` chega
  com `stopRequested`/`wasInterrupted` marcados
- **THEN** a sessão mostra apenas o info "Response interrupted", sem mensagem de erro nem retry

#### Scenario: Mensagem enfileirada para replay não vira card de erro
- **WHEN** o turno termina sem resposta do assistente e existe mensagem na fila aguardando replay
  (redirect que não conseguiu steer)
- **THEN** nenhuma mensagem de erro é acrescentada, porque a mensagem do usuário será respondida no
  turno seguinte
