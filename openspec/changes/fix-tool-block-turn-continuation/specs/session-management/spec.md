## ADDED Requirements

### Requirement: Turno sem resposta do assistente sempre produz mensagem visível
O `SessionManager` SHALL sempre acrescentar uma mensagem de erro visível à sessão e emitir o erro
tipado correspondente quando um turno completa sem resposta do assistente **e o turno não foi de
fato interrompido**, em vez de apenas registrar um warning no log. O `SessionManager` SHALL NOT
produzir essa mensagem quando o turno foi cortado de propósito — Stop do usuário ou abort real
(`forceAbort`, incluindo o redirect que não conseguiu steer).

Uma mensagem apenas **enfileirada** SHALL NOT suprimir a mensagem: em `midStreamBehavior: 'queue'`
(padrão das conexões `anthropic`) nada é abortado e o turno corrente segue até completar
naturalmente, então um turno que morre calado nesse cenário é exatamente a falha que este
requisito existe para tornar visível.

A avaliação "este turno respondeu?" SHALL usar o baseline factual do turno
(`turnStartFinalMessageId` comparado com a última mensagem final do assistente), não a comparação
de timestamps entre a última mensagem do usuário e a última do assistente — uma mensagem enviada
no meio do turno é mais nova que o texto que aquele mesmo turno já produziu.

#### Scenario: Erro 400 capturado mantém o diagnóstico específico
- **WHEN** o turno termina sem resposta do assistente e existe um erro de API capturado com status 400
- **THEN** a sessão recebe a mensagem `image_too_large` ou `invalid_request` já existente, sem retry

#### Scenario: Turno encerrado sem resposta e sem erro de API
- **WHEN** o turno termina sem resposta do assistente, não há erro de API 400 capturado e o turno
  não foi interrompido
- **THEN** a sessão recebe uma mensagem de erro genérica informando que o turno terminou sem
  resposta, com retry habilitado

#### Scenario: Stop do usuário não vira card de erro
- **WHEN** o usuário aperta Stop antes de qualquer texto do assistente e o evento `complete` chega
  com `stopRequested`/`wasInterrupted` marcados
- **THEN** a sessão mostra apenas o info "Response interrupted", sem mensagem de erro nem retry

#### Scenario: Redirect que abortou o turno não vira card de erro
- **WHEN** um envio mid-stream em modo `steer` não consegue entregar o steer, o backend já chamou
  `forceAbort(AbortReason.Redirect)` e o turno termina sem resposta
- **THEN** nenhuma mensagem de erro é acrescentada, porque o turno foi cortado de propósito

#### Scenario: Mensagem apenas enfileirada continua mostrando o card
- **WHEN** o usuário envia uma mensagem durante um turno em modo `queue`, nada é abortado e o turno
  corrente termina sem resposta do assistente
- **THEN** a sessão recebe a mensagem de erro genérica com retry, mesmo com a mensagem enfileirada
  aguardando replay

#### Scenario: Steer não entregue e re-enfileirado continua mostrando o card
- **WHEN** o turno termina pela negação no prompt de permissão, emite `steer_undelivered` e o
  `SessionManager` re-enfileira a mensagem
- **THEN** o re-enfileiramento SHALL NOT marcar o turno como interrompido, e a sessão recebe a
  mensagem de erro genérica com retry

#### Scenario: Turno que respondeu não vira card de erro por causa da fila
- **WHEN** o turno já produziu uma mensagem final do assistente e o usuário envia outra mensagem
  antes do evento `complete`
- **THEN** nenhuma mensagem de erro é acrescentada, porque o baseline do turno mostra que ele
  respondeu
