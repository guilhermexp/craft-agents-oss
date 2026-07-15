## Why

A auditoria de segurança de 2026-07-14 (fase F4) apontou quatro pontos de
exposição de credenciais exploráveis por um processo/MCP malicioso rodando
como o mesmo usuário (defense-in-depth — nenhum é RCE por si só):

1. **F4.4** — o discovery OAuth de sources MCP (`discoverOAuthMetadata`) faz
   probe do `mcpUrl` cru e fetch dos candidates RFC 8414 sem o guard SSRF
   `isUrlSafeToFetch`, que só protege o ramo RFC 9728. Um source malicioso
   pode apontar o discovery para `169.254.169.254` (metadata AWS), localhost
   ou IPs privados.
2. **F4.3** — os servidores MCP loopback (`CraftSessionToolsMcpServer`,
   `McpPoolServer`) fazem bind em `127.0.0.1:porta-aleatória` sem nenhuma
   autenticação nem validação de `Origin`/`Host`. Conteúdo web dentro do
   `browser_tool` (ou qualquer página em browser local) pode tentar
   DNS-rebinding para alcançar `call_llm`/`spawn_session`/proxy de sources.
3. **F4.2** — o `SecureStorageBackend` deriva a chave AES do
   IOPlatformUUID/MachineGuid (identificador legível por qualquer processo do
   usuário), sem usar o keychain do SO (`electron.safeStorage`).
4. **F4.1** — `seedHermesAuthFromCraft` grava access+refresh token do Codex em
   cleartext no `auth.json` do Hermes e injeta todas as API keys no env do
   subprocess.

## What Changes

- **F4.4** — `discoverOAuthMetadata` valida o `mcpUrl` com `isUrlSafeToFetch`
  antes de qualquer fetch (probe RFC 9728 incluído) e valida cada candidate do
  fallback RFC 8414 antes de buscá-lo. URLs internas/privadas são rejeitadas
  sem fetch.
- **F4.3a** — todo request aos servidores MCP loopback passa por um guard
  anti-DNS-rebinding: header `Host` deve ser loopback e header `Origin`,
  quando presente, deve ser loopback — caso contrário 403. Clientes MCP
  nativos (Hermes, Codex, Copilot) não enviam `Origin` de web e continuam
  funcionando sem mudança.
- **F4.3b (opt-in, desligado)** — infra de bearer token por servidor: opção
  `authToken` nos dois servidores, validada por request com comparação
  timing-safe. **Não é ligada por default** — ligar exige validar em runtime
  que o cliente MCP do Hermes (subprocess Python) envia o header configurado
  via ACP `session.mcpServers[].headers`, o que não foi validado nesta fase.
- **F4.2 (infra opt-in, default inalterado)** — `SecureStorageBackend` ganha
  um seam injetável `CredentialKeyProtector` (a ser implementado no Electron
  main via `safeStorage`): chave-mestra aleatória protegida pelo SO em sidecar
  `credentials.key`, leitura do formato atual preservada, migração lazy ao
  carregar, e fallback não-destrutivo (sidecar presente + protector ausente →
  não deleta o arquivo como "corrompido"). **O default não muda**: o backend
  continua derivando a chave do machine-id quando nenhum protector é injetado.
  Motivo: `packages/shared` roda no server headless (subprocess sem Electron);
  trocar o default quebraria a leitura de credenciais fora do Electron main.
  Falta (documentado em tasks): distribuição da chave Electron main → server
  subprocess e validação runtime em app empacotado.
- **F4.1 (skipped)** — o `refresh_token` do Codex no `auth.json` é necessário:
  o provider `openai-codex` do Hermes refresha o token sozinho usando esse
  campo, e o watcher em `packages/server-core/src/handlers/rpc/hermes.ts`
  existe justamente para sincronizar o token refreshado de volta ao Craft
  (`readHermesCodexTokens` exige `access_token` **e** `refresh_token`).
  Remover o espelhamento quebraria o refresh do Hermes. O env global de API
  keys é intencional (multi-modelo mid-sessão + sub-agentes). Nenhuma mudança.

- **Não-objetivo**: scoping do env do subprocess Hermes; ligar bearer por
  default; trocar o backend de credenciais default para safeStorage.

## Impact

- Specs afetadas: `session-tools-mcp` (guard loopback + bearer opt-in),
  `workspace-and-sources` (SSRF no discovery OAuth), nova capability
  `credential-storage` (seam de key protector).
- Código: `packages/shared/src/auth/oauth.ts`,
  `packages/shared/src/mcp/{session-tools-server,pool-server,loopback-guard}.ts`,
  `packages/shared/src/credentials/backends/secure-storage.ts`.
- Sem mudança de formato on-disk por default; sem mudança de protocolo
  Hermes↔MCP por default.
