## ADDED Requirements

### Requirement: Secure storage supports an injectable OS-backed key protector

O `SecureStorageBackend` SHALL aceitar um `CredentialKeyProtector` opcional
(implementável no Electron main via `electron.safeStorage`). Quando presente e
disponível, o backend SHALL cifrar o payload com uma chave-mestra aleatória
protegida pelo SO em um sidecar `credentials.key`. Quando ausente (default
atual, incluindo o server headless), o backend SHALL manter a derivação de
chave por machine-id sem nenhuma mudança de comportamento ou formato.

#### Scenario: default sem protector permanece o formato atual

- **GIVEN** um `SecureStorageBackend` construído sem key protector
- **WHEN** credenciais são gravadas e lidas
- **THEN** o formato on-disk atual (chave derivada de machine-id) é usado sem mudança

#### Scenario: leitura do formato antigo com protector presente + migração lazy

- **GIVEN** um `credentials.enc` gravado no formato atual (machine-id)
- **WHEN** um backend com key protector disponível carrega o arquivo
- **THEN** as credenciais existentes são lidas com sucesso
- **AND** o store é re-gravado com a chave-mestra protegida (sidecar criado)

#### Scenario: round-trip com protector

- **GIVEN** um backend com key protector disponível e sem arquivo prévio
- **WHEN** credenciais são gravadas e lidas de volta
- **THEN** o round-trip funciona e o sidecar `credentials.key` existe

#### Scenario: sidecar presente e protector indisponível não destrói credenciais

- **GIVEN** um `credentials.enc` cifrado com chave-mestra protegida e um processo sem protector (ex.: server headless)
- **WHEN** o load falha ao decifrar
- **THEN** o load retorna null SEM deletar `credentials.enc` como corrompido
