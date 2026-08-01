## ADDED Requirements

### Requirement: Composio discovery remains subordinate to Craft source security

Quando o catálogo Composio estiver habilitado, o sistema SHALL usá-lo somente
para discovery e delegated connector metadata, SHALL persistir conexões como
Craft sources e MUST manter credentials no
credential storage existente. Catalog records e renderer payloads MUST NOT
conter tokens ou provider secrets.

#### Scenario: Toolkit é conectado

- **WHEN** o usuário conclui uma conexão descoberta pelo catálogo
- **THEN** metadata portátil vira Craft source e credentials ficam no secure store
- **Test:** `integration`

#### Scenario: Catálogo repete item paginado

- **WHEN** pages de catálogo contêm o mesmo toolkit
- **THEN** a lista e source local deduplicam por stable provider identity
- **Test:** `unit`

### Requirement: Gmail and Calendar synchronization use native domain adapters

Gmail e Google Calendar SHALL reutilizar OAuth e credential storage de sources,
mas SHALL executar checkpoint, idempotência, timezone, cancellation e
relationship materialization em adapters nativos do domínio de objetos.

#### Scenario: Sync acessa credencial

- **WHEN** um adapter inicia um ciclo de sync
- **THEN** ele recebe credential pela boundary segura sem serializá-la no object payload ou manifest
- **Test:** `integration`

#### Scenario: Sync falha

- **WHEN** o provider retorna rate limit ou credential inválida
- **THEN** o adapter preserva checkpoint e dados visíveis e publica health state redacted
- **Test:** `integration`
