## Why

`packages/server-core/src/sessions/SessionManager.ts` tem cerca de 7,5 mil linhas e concentra responsabilidades que hoje deveriam falhar de forma independente: lifecycle de sessão, persistência append-only de mensagens, publicação de eventos para renderer/CLI, integração com runtime/processos de agente, watchers de arquivos/configuração e operações de transferência. Na prática, um bug em renderização de Mermaid ou watcher de arquivos pode aumentar o risco de regressão em criação, envio, cancelamento, branch/rollback ou persistência de histórico.

O acoplamento também dificulta entender a fronteira entre sessões nativas e sessões Hermes proxy. Como Hermes é um backend ACP separado, a camada de sessão precisa deixar explícito o que é lifecycle comum, o que é store comum e o que é runtime específico.

## What Changes

- Separar o monolito em módulos por domínio:
  - `SessionLifecycleManager`: create, send, branch, rollback, cancel, delete, transfer e coordenação do backend ativo.
  - `SessionMessageStore`: carregamento lazy, persistência append-only, flush, truncamento/rollback e sidecars de mensagens.
  - `SessionArtifactRenderer`: extração de Mermaid e geração assíncrona/rate-limited de SVGs derivados do histórico.
  - `SessionEventPublisher`: eventos para renderer/CLI, batching de deltas e broadcasts de sessão.
- Manter um aggregate fino `Session`/`SessionManager` que compõe os submódulos, preserva a API pública usada pelos handlers RPC e evita reescrever consumidores de uma vez.
- Reavaliar, durante a extração, se a complexidade justifica uma fronteira explícita entre `NativeSessionRuntime` e `HermesSessionProxy`.
- Migrar o handler `packages/server-core/src/handlers/rpc/sessions.ts` para delegar renderização de artefatos e watcher de arquivos a módulos de sessão, em vez de manter lógica de domínio no adapter RPC.

## Capabilities

### Modified Capabilities

- `session-management`: passa a exigir fronteiras internas claras entre lifecycle, store, renderização de artefatos, publicação de eventos e runtime específico.

## Impact

- `packages/server-core/src/sessions/`: nova organização por submódulos e aggregate fino.
- `packages/server-core/src/handlers/rpc/sessions.ts`: deve virar adapter de transporte, delegando operações de sessão para os módulos.
- Consumers atuais do contrato de sessões, incluindo Electron main/renderer e CLI, devem manter a mesma API observável durante a migração.
- Testes de sessão devem passar a cobrir cada submódulo em isolamento, além dos testes de integração existentes.
