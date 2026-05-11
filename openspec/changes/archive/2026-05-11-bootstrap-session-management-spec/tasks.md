## 1. Tipos e Persistência

- [x] 1.1 Definir tipos Session/Message/Tool* em packages/core e packages/shared/src/sessions
- [x] 1.2 Implementar persistência JSONL de metadados e mensagens de sessão
- [x] 1.3 Persistir diretórios auxiliares de sessão para anexos, planos, dados e downloads

## 2. Runtime e RPC

- [x] 2.1 Implementar SessionManager em packages/server-core/src/sessions
- [x] 2.2 Implementar RPC handlers de sessions
- [x] 2.3 Implementar streaming push events para renderer/CLI
- [x] 2.4 Garantir backend ativo único por sessão

## 3. Operações de Sessão

- [x] 3.1 Implementar branch e rollback
- [x] 3.2 Implementar labels e status
- [x] 3.3 Implementar anexos (audio/images/docs)
- [x] 3.4 Implementar cancel propagation
- [x] 3.5 Implementar transfer (se aplicável)

## 4. Validação

- [x] 4.1 Cobrir SessionManager com testes focados
- [x] 4.2 Validar contrato OpenSpec da capability session-management
