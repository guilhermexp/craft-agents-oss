## Context

O Hermes já tem dashboard web próprio, iniciado pelo runtime Python vendorizado em `apps/electron/resources/vendor/hermes/`. No Craft, o dashboard é exposto ao usuário por uma composição indireta:

- `HermesSettingsPage` chama `window.electronAPI.startHermesDashboard()` e, quando recebe a URL, abre essa URL via `window.electronAPI.browserPane.create({ show: true, url })` ou fallback `openUrl` (`apps/electron/src/renderer/pages/settings/HermesSettingsPage.tsx:126`).
- O BrowserView usado é o `browser-pane` genérico: ele cria `toolbarView`, `pageView` e `nativeOverlayView`, adiciona os BrowserViews na janela e navega com `pageView.webContents.loadURL(...)` (`apps/electron/src/main/browser-pane-manager.ts:454`, `apps/electron/src/main/browser-pane-manager.ts:555`, `apps/electron/src/main/browser-pane-manager.ts:928`).
- A política de navegação atual também é genérica do browser pane: `will-navigate` trata apenas deep-links Craft, e `setWindowOpenHandler` permite `http:`/`https:` depois de negar protocolos inválidos ou não suportados (`apps/electron/src/main/browser-pane-manager.ts:3307`, `apps/electron/src/main/browser-pane-manager.ts:3319`).
- `packages/server-core/src/handlers/rpc/hermes.ts` guarda estado global do dashboard (`dashboardProcess`, URL, porta, token, update marker, watcher de auth) e exporta shutdown/cleanup para o Electron main (`packages/server-core/src/handlers/rpc/hermes.ts:43`, `packages/server-core/src/handlers/rpc/hermes.ts:132`, `packages/server-core/src/handlers/rpc/hermes.ts:171`).
- O mesmo handler monta o comando `dashboard --host 127.0.0.1 --port ... --no-open`, injeta env de runtime embutido/update marker, extrai `window.__HERMES_SESSION_TOKEN__` do HTML e autentica chamadas internas com `X-Hermes-Session-Token` (`packages/server-core/src/handlers/rpc/hermes.ts:325`, `packages/server-core/src/handlers/rpc/hermes.ts:456`, `packages/server-core/src/handlers/rpc/hermes.ts:487`, `packages/server-core/src/handlers/rpc/hermes.ts:1136`).
- Ao iniciar o dashboard, o handler também chama `seedHermesAuthFromCraft(...)`, injeta env de credenciais no subprocesso e faz spawn do processo detached (`packages/server-core/src/handlers/rpc/hermes.ts:1028`, `packages/server-core/src/handlers/rpc/hermes.ts:1055`, `packages/server-core/src/handlers/rpc/hermes.ts:1068`).
- O auth bridge declara que Craft é a fonte de verdade de credenciais, mapeia OAuth/API keys para env/auth.json, e cita explicitamente o subprocesso/dashboard como superfície de injeção (`packages/shared/src/hermes/auth-bridge.ts:1`, `packages/shared/src/hermes/auth-bridge.ts:245`).
- O Electron main resolve runtime, limpa órfãos de dashboard no startup, faz seed de skills e chama `shutdownHermesDashboard()` no quit (`apps/electron/src/main/index.ts:186`, `apps/electron/src/main/index.ts:191`, `apps/electron/src/main/index.ts:424`, `apps/electron/src/main/index.ts:1208`).

Não foi encontrado um módulo nomeado `hermes-dashboard-host`. Também não há BrowserView dedicado ao Hermes hoje; o dashboard entra no host genérico de browser.

## Proposed Shape

Criar `hermes-dashboard-host` como owner único do host visual do dashboard Hermes.

Shape sugerido:

- `apps/electron/src/main/hermes-dashboard-host/`
- API main-process como `openHermesDashboardHost()`, `reloadHermesDashboardHost()`, `closeHermesDashboardHost()`, `attachHermesDashboardEvents()` e `isHermesDashboardUrlAllowed(url)`.
- O host chama a camada RPC/serviço Hermes para garantir runtime/dashboard rodando, mas o RPC não decide mais como expor a URL ao usuário.
- O host usa BrowserView/BrowserWindow dedicado ou um wrapper dedicado sobre `browser-pane`, desde que a política e lifecycle deixem de ser implícitos no browser genérico.

Responsabilidades do `hermes-dashboard-host`:

- mount/unmount da view dedicada ao dashboard Hermes;
- reload/refresh quando o runtime Hermes reiniciar ou quando o dashboard retornar nova porta;
- política de navegação: permitir apenas a origem localhost do dashboard ativo, rotas internas do dashboard e deep-links Craft explicitamente suportados;
- bloquear navegação/popup para URLs externas por padrão e abrir externamente apenas quando a política permitir;
- handoff de auth Craft → Hermes UI sem colocar secrets em query string, preload exposto ou estado renderer;
- eventos UI Hermes ↔ Craft, incluindo toolbar buttons, notificações, update/restart e ações de abrir arquivo/log quando suportadas.

## Boundary With `hermes-embed`

`hermes-embed` continua dono de:

- runtime Python/ACP vendorizado;
- `HERMES_HOME` app-scoped;
- seed de skills;
- patch overlay e bundling;
- configuração ACP e MCPs de sessão;
- auth bridge de processo/subprocesso;
- APIs locais do dashboard usadas pelo Craft.

`hermes-dashboard-host` passa a ser dono de:

- onde e como o dashboard aparece no Electron;
- quais URLs o dashboard pode navegar;
- quando a view recarrega, fecha ou troca para uma nova instância;
- como eventos visuais do dashboard chegam ao Craft;
- como comandos do Craft chegam à UI do dashboard sem vazar credenciais.

## Tests

- Smoke test do mount: abrir dashboard via Settings/host cria a view dedicada, carrega a URL localhost retornada pelo Hermes e foca a janela.
- Policy test de deep-link: navegação interna para a origem do dashboard é permitida; navegação externa e protocolos não permitidos são bloqueados ou enviados para `shell.openExternal` conforme política explícita.
- Auth handoff test: o host não inclui tokens em URL, preload ou eventos renderer; chamadas API internas continuam autenticadas via token de sessão controlado no processo principal.
- Runtime restart test: quando o dashboard processo sai ou a porta muda, o host invalida a view antiga e recarrega usando a nova URL.
- Event bridge test: botões/ações Hermes expostos pelo host disparam eventos Craft esperados e notificações não duplicam as responsabilidades de `hermes-embed`.

## Trade-offs

- O refactor atravessa main, preload, renderer Settings e RPC Hermes; pode ser feito em fases para reduzir risco.
- Usar wrapper dedicado sobre `browser-pane` reaproveita toolbar/perfis, mas mantém acoplamento com política genérica; uma BrowserView dedicada aumenta isolamento, mas exige mais código de lifecycle.
- Separar host visual de runtime deixa a arquitetura mais clara, mas exige contrato explícito entre `hermes-dashboard-host` e `hermes-embed` para reload, auth e update marker.
- A primeira fase pode apenas nomear o módulo e delegar ao browser pane existente; fases seguintes endurecem navegação e eventos sem mudar o runtime.
