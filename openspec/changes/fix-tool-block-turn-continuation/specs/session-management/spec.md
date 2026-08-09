## ADDED Requirements

### Requirement: Turno sem resposta do assistente sempre produz mensagem visível
O `SessionManager` SHALL sempre acrescentar uma mensagem de erro visível à sessão e emitir o erro
tipado correspondente quando um turno completa e a última mensagem do usuário é mais nova que
qualquer resposta do assistente, em vez de apenas registrar um warning no log.

#### Scenario: Erro 400 capturado mantém o diagnóstico específico
- **WHEN** o turno termina sem resposta do assistente e existe um erro de API capturado com status 400
- **THEN** a sessão recebe a mensagem `image_too_large` ou `invalid_request` já existente, sem retry

#### Scenario: Turno encerrado sem resposta e sem erro de API
- **WHEN** o turno termina sem resposta do assistente e não há erro de API 400 capturado
- **THEN** a sessão recebe uma mensagem de erro genérica informando que o turno terminou sem
  resposta, com retry habilitado
