## ADDED Requirements

### Requirement: Loopback MCP servers reject non-loopback web origins

Os servidores MCP loopback do Craft (`CraftSessionToolsMcpServer` e `McpPoolServer`) SHALL rejeitar com HTTP 403 qualquer request cujo header
`Host` não resolva para loopback (`127.0.0.1`, `localhost`, `::1`) ou cujo
header `Origin`, quando presente, não seja loopback. Requests sem `Origin`
(clientes MCP nativos) SHALL continuar aceitos.

#### Scenario: request com Origin de web externa é rejeitado

- **GIVEN** um servidor MCP loopback do Craft em execução
- **WHEN** chega um request com `Origin: https://evil.example.com`
- **THEN** o servidor responde 403 sem processar o request MCP

#### Scenario: DNS rebinding via Host não-loopback é rejeitado

- **GIVEN** um servidor MCP loopback do Craft em execução
- **WHEN** chega um request com `Host: attacker.example.com`
- **THEN** o servidor responde 403 sem processar o request MCP

#### Scenario: cliente MCP nativo loopback continua funcionando

- **GIVEN** um servidor MCP loopback do Craft em execução
- **WHEN** um cliente MCP conecta em `http://127.0.0.1:<porta>/mcp` sem header `Origin`
- **THEN** o handshake MCP e as tool calls funcionam normalmente

### Requirement: Loopback MCP servers support opt-in bearer authentication

Os servidores MCP loopback SHALL aceitar uma opção `authToken`. Quando
configurada, todo request SHALL apresentar `Authorization: Bearer <token>`
com comparação timing-safe; requests sem token ou com token errado recebem
401. Quando a opção não é configurada (default atual), nenhum bearer é
exigido. Ligar o bearer para o Hermes exige validação runtime prévia do
handshake via ACP `session.mcpServers[].headers`.

#### Scenario: token configurado e request sem Authorization

- **GIVEN** um servidor MCP loopback iniciado com `authToken`
- **WHEN** chega um request sem header `Authorization`
- **THEN** o servidor responde 401

#### Scenario: token configurado e request com token correto

- **GIVEN** um servidor MCP loopback iniciado com `authToken`
- **WHEN** o cliente envia `Authorization: Bearer <token correto>`
- **THEN** o request é processado normalmente

#### Scenario: default sem token exigido

- **GIVEN** um servidor MCP loopback iniciado sem `authToken`
- **WHEN** um cliente MCP conecta sem header `Authorization`
- **THEN** o request é processado normalmente
