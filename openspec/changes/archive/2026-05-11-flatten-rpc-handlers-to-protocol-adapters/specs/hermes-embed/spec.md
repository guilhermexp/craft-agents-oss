## ADDED Requirements

### Requirement: Runtime Hermes state pertence a serviço dedicado
O sistema SHALL manter estado de lifecycle do Hermes embedded em um manager ou serviço dedicado, não no handler RPC.

#### Scenario: Dashboard Hermes é iniciado
- **WHEN** um client solicita iniciar o dashboard Hermes
- **THEN** o handler RPC delega ao serviço Hermes
- **AND** o serviço controla subprocesso, porta, URL, promise de inicialização e shutdown.

#### Scenario: Auth do Hermes muda
- **WHEN** o `auth.json` no `HERMES_HOME` app-scoped muda
- **THEN** o serviço Hermes aplica debounce, sincroniza tokens autorizados para o store do Craft e evita watchers duplicados.

#### Scenario: Update marker muda
- **WHEN** o dashboard Hermes grava o marker de update
- **THEN** o serviço Hermes detecta a alteração, interpreta o resultado e emite notificação ou evento necessário sem depender de timer local no handler RPC.
