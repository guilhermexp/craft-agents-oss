## ADDED Requirements

### Requirement: OAuth discovery for MCP sources is SSRF-guarded

O discovery de metadata OAuth de sources MCP (`discoverOAuthMetadata`) SHALL validar o `mcpUrl` com o guard SSRF (`isUrlSafeToFetch` — bloqueia HTTP não
seguro, localhost, IPs privados e link-local incluindo `169.254.169.254`)
antes de qualquer fetch, e SHALL validar cada candidate do fallback RFC 8414
antes de buscá-lo. URLs internas SHALL ser rejeitadas sem nenhum request de
rede.

#### Scenario: mcpUrl apontando para metadata endpoint link-local é bloqueado

- **GIVEN** um source MCP configurado com URL `https://169.254.169.254/mcp`
- **WHEN** o discovery OAuth roda para esse source
- **THEN** o discovery retorna null sem realizar nenhum fetch

#### Scenario: mcpUrl apontando para localhost ou IP privado é bloqueado

- **GIVEN** um source MCP configurado com URL `https://localhost/mcp` ou `https://10.0.0.5/mcp`
- **WHEN** o discovery OAuth roda para esse source
- **THEN** o discovery retorna null sem realizar nenhum fetch

#### Scenario: mcpUrl público segue o discovery normal

- **GIVEN** um source MCP configurado com URL pública HTTPS
- **WHEN** o discovery OAuth roda para esse source
- **THEN** o probe RFC 9728 e o fallback RFC 8414 executam normalmente
