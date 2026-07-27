## ADDED Requirements

### Requirement: One resolver maps auth type to credential value

`CredentialManager` SHALL expor uma operação que resolve
`(slug, authType, providerType)` para o valor da credencial e o seu tipo,
cobrindo todos os arms de `LlmAuthType`. A verificação de presença
(`hasLlmCredentials`) SHALL derivar dessa operação em vez de reimplementar o
mesmo mapa. Nenhum driver, builder de env var ou backend SHALL redderivar o
mapa `authType → credencial`.

#### Scenario: presença e valor não podem divergir

- **GIVEN** uma connection com `authType: 'environment'` e a env var ausente
- **WHEN** a presença é consultada e o valor é resolvido
- **THEN** as duas respostas concordam

#### Scenario: arms cobertos em todo consumidor

- **GIVEN** uma connection com `authType: 'iam_credentials'` ou `'service_account_file'`
- **WHEN** qualquer consumidor resolve a credencial
- **THEN** o arm é tratado, sem cair em erro genérico de credencial ausente

#### Scenario: placeholder keyless é único

- **GIVEN** uma connection keyless
- **WHEN** dois consumidores diferentes precisam do placeholder de API key
- **THEN** ambos usam a mesma constante, disparada pela mesma condição

### Requirement: Validating a connection never persists a throwaway credential

Testar uma connection SHALL usar uma credencial efêmera em memória. Nenhum
slug descartável SHALL ser escrito no armazenamento de credenciais para
viabilizar o teste.

#### Scenario: teste de connection não deixa resíduo em disco

- **GIVEN** um teste de connection com uma API key fornecida
- **WHEN** o teste roda e termina, com sucesso ou falha
- **THEN** nenhuma credencial nova permanece no armazenamento
