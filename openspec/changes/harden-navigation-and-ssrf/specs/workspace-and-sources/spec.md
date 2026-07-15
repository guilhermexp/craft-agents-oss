# workspace-and-sources — delta F7 (R2, R3)

## ADDED Requirements

### Requirement: OAuth SSRF guard covers IPv6 address forms

O guard SSRF de descoberta OAuth (`isUrlSafeToFetch`) SHALL normalizar
hostnames IPv6 (removendo os colchetes que a URL WHATWG preserva) e SHALL
rejeitar: loopback `::1`, unspecified `::`, ULA fc00::/7, link-local
fe80::/10, e endereços IPv4-mapped (`::ffff:…`) cujo IPv4 embutido cai em
faixa privada/reservada — em ambas as formas (dotted-quad e hex).
Endereços IPv6 públicos SHALL continuar permitidos.

#### Scenario: IPv6 loopback com colchetes é rejeitado

- **WHEN** o guard avalia `https://[::1]/`
- **THEN** a URL é considerada unsafe

#### Scenario: link-local e ULA IPv6 são rejeitados

- **WHEN** o guard avalia `https://[fe80::1]/` ou `https://[fc00::1]/`
- **THEN** as URLs são consideradas unsafe

#### Scenario: IPv4-mapped para loopback é rejeitado

- **WHEN** o guard avalia `https://[::ffff:127.0.0.1]/` (ou a forma hex `https://[::ffff:7f00:1]/`)
- **THEN** a URL é considerada unsafe

#### Scenario: IPv6 público é permitido

- **WHEN** o guard avalia `https://[2606:4700::1111]/`
- **THEN** a URL é considerada safe

### Requirement: OAuth fetches validate metadata endpoints and redirect targets

Endpoints derivados de metadata OAuth SHALL passar pelo guard SSRF
(`token_endpoint`, `registration_endpoint`) antes de qualquer
fetch. Fetches OAuth SHALL usar redirect manual: cada `Location` de resposta
3xx SHALL ser validado pelo guard SSRF antes de ser seguido, com limite de
redirects; destino unsafe SHALL abortar a requisição. Redirects legítimos
para endpoints públicos SHALL continuar funcionando.

#### Scenario: token_endpoint interno é rejeitado antes do fetch

- **GIVEN** metadata OAuth com `token_endpoint: 'https://127.0.0.1/token'`
- **WHEN** o fluxo tenta trocar código por tokens
- **THEN** a operação falha antes de qualquer requisição ao endpoint interno

#### Scenario: redirect 302 para host interno é bloqueado

- **GIVEN** um fetch OAuth cujo servidor responde 302 com `Location` apontando para IP interno
- **WHEN** o fetch processa o redirect
- **THEN** o redirect não é seguido e a requisição falha

#### Scenario: redirect para destino público é seguido

- **GIVEN** um fetch OAuth cujo servidor responde 302 com `Location` público https
- **WHEN** o fetch processa o redirect
- **THEN** o destino é validado e a requisição segue normalmente
