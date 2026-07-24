# Upgrade Pi computer-use to upstream v0.5.0

## Why

O Craft vendora `pi-computer-use` v0.1.6, mas o upstream atualizou a integração macOS para um helper estável e uma API consolidada, baseada em descoberta, observação stateful e ações validadas. A cópia atual também não é distribuída integralmente por `copyPiAgentServer()`, portanto o recurso pode funcionar no checkout e desaparecer no aplicativo Electron empacotado.

## What Changes

- Atualizar a cópia vendorizada para `injaneity/pi-computer-use@8e1772f317dedd3a77d34835c970d92cd5b887ae` (`package.json` 0.5.0).
- Trocar a allowlist legada pela API pública v0.5: `find_roots`, `observe_ui`, `search_ui`, `expand_ui`, `inspect_ui`, `act_ui`, `read_text`, `wait_for`, `launch_browser`, `navigate_browser` e `evaluate_browser`.
- Preservar a ativação somente no backend Pi desktop em macOS.
- Manter uma skill `computer-use` específica do Craft, adaptada ao novo protocolo stateful.
- Tornar o pacote vendorizado e suas dependências runtime autossuficientes no recurso Electron final.
- Instalar o helper macOS v0.5 e validar observação não preta e ação segura no aplicativo real.

## Decisions

- **D-01 — Pin imutável:** a origem SHALL ser registrada pelo SHA completo `8e1772f317dedd3a77d34835c970d92cd5b887ae`; o build não acompanhará `main` implicitamente.
- **D-02 — Pi/macOS only:** esta change SHALL preservar `enableComputerUse && process.platform === 'darwin'`; Windows, Claude e Hermes não recebem a extensão.
- **D-03 — Sem compatibilidade pública legada:** o Craft SHALL anunciar somente os nomes v0.5; aliases dos tools v0.1.6 não serão mantidos.
- **D-04 — Skill como overlay Craft:** a skill removida do upstream será mantida no vendorizado como documentação operacional própria do Craft e só poderá citar a API v0.5.
- **D-05 — Artefato autossuficiente:** o recurso empacotado SHALL iniciar sem resolver módulos no `node_modules` do checkout do monorepo.
- **D-06 — Compatibilidade com extensões vendorizadas:** o loader e o copy de recursos SHALL preservar `pi-better-subagents`; uma extensão não pode substituir ou ocultar a outra.
- **D-07 — Evidência real obrigatória:** testes e typecheck não encerram a change; o helper autorizado deve observar uma janela real e realizar uma ação temporária confirmada.

## Capabilities

### Modified Capabilities

- `native-agent-runtime`: detalha a API computer-use exposta pelo Pi, o contrato macOS, a distribuição no app e a validação real.

## Impact

- `packages/pi-agent-server/src/pi-computer-use/**`
- `packages/pi-agent-server/src/computer-use-tools.ts`
- `packages/pi-agent-server/src/index.ts`
- `packages/pi-agent-server/package.json`
- `packages/pi-agent-server/tsconfig.typecheck.json`
- `scripts/build/common.ts`
- testes focados do Pi server e do packaging Electron.

## Non-goals

- Habilitar ou validar o helper Windows.
- Expor computer-use a Claude ou Hermes.
- Manter aliases para `screenshot`, `click`, `set_text`, `computer_actions` ou outros tools legados.
- Alterar a implementação de `pi-better-subagents`, overflow recovery ou UI do renderer.
- Fazer deploy, push ou release do Craft.
