## Why

Documentar retroativamente a capability `agent-backends` para que mudanças futuras tenham um contrato escrito sobre como cada backend de agente é instanciado, autenticado e isolado. O código já possui uma factory comum e três backends distintos (Claude, Pi e Hermes), mas esse comportamento ainda não estava descrito como especificação OpenSpec.

## What Changes

- Adiciona a nova capability `agent-backends`.
- Registra o contrato de seleção de backend por configuração de sessão.
- Registra os contratos de autenticação e isolamento para Claude, Pi e Hermes.
- Registra que `computer-use` pertence ao backend Pi e não deve ser exposto aos demais backends.

## Capabilities

### New Capabilities

- `agent-backends`: cobre a factory de backends, os backends Claude/Pi/Hermes, autenticação, isolamento de estado, seleção de modelo por sessão e exposição de ferramentas específicas por backend.

### Modified Capabilities

Nenhuma.

## Impact

- `packages/shared/src/agent/*`
- `packages/shared/src/auth/*`
- `packages/pi-agent-server`
