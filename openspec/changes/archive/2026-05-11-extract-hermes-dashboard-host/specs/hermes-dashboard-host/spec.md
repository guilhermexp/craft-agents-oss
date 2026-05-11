## ADDED Requirements

### Requirement: Host visual dedicado do dashboard Hermes

O sistema MUST expor o dashboard Hermes por um host Electron nomeado `hermes-dashboard-host`, em vez de deixar o lifecycle visual implícito no browser genérico ou no RPC do runtime.

#### Scenario: Abrir dashboard pelo host

- **WHEN** o usuário solicita abrir o dashboard Hermes
- **THEN** o host garante que o dashboard runtime esteja disponível, cria ou reutiliza a view dedicada e carrega a URL ativa do dashboard

#### Scenario: Fechar dashboard pelo host

- **WHEN** a janela ou view do dashboard é fechada
- **THEN** o host desmonta a superfície visual sem deixar BrowserView órfã nem matar sessões Hermes que ainda pertencem ao runtime

### Requirement: Política de navegação do dashboard

O sistema MUST aplicar uma política de navegação específica para o dashboard Hermes, restrita à origem localhost ativa do dashboard e aos deep-links Craft explicitamente suportados.

#### Scenario: Navegação interna permitida

- **WHEN** o dashboard navega para uma rota da mesma origem localhost ativa
- **THEN** o host permite a navegação dentro da view dedicada

#### Scenario: Navegação externa bloqueada

- **WHEN** o dashboard tenta navegar, abrir popup ou redirecionar para origem externa não permitida
- **THEN** o host bloqueia a navegação na view e só abre externamente se a política declarar esse destino como permitido

#### Scenario: Deep-link Craft tratado pelo host

- **WHEN** o dashboard emite um deep-link Craft suportado
- **THEN** o host cancela a navegação web e encaminha o evento para o handler Craft apropriado

### Requirement: Handoff de auth sem exposição de credenciais

O sistema MUST entregar autenticação necessária ao dashboard Hermes sem expor secrets em URL, preload público, query string, logs ou estado renderer.

#### Scenario: Dashboard recebe credenciais por canal controlado

- **WHEN** o dashboard é iniciado a partir do Craft
- **THEN** credenciais necessárias são entregues apenas por env/processo, store app-scoped ou canal main-process controlado

#### Scenario: Renderer não recebe secret

- **WHEN** o renderer pede para abrir o dashboard Hermes
- **THEN** a resposta ao renderer contém somente status/identificador/URL permitida para navegação, sem tokens OAuth, API keys ou token interno de sessão Hermes

### Requirement: Reload após restart do runtime Hermes

O sistema MUST reconciliar a view do dashboard quando o subprocesso Hermes reiniciar, trocar de porta ou expirar a sessão interna.

#### Scenario: Porta do dashboard muda

- **WHEN** o runtime Hermes reinicia e retorna uma nova URL localhost
- **THEN** o host invalida a navegação antiga e recarrega a view dedicada com a nova URL permitida

#### Scenario: Token interno expira

- **WHEN** chamadas internas do dashboard exigem novo token de sessão
- **THEN** o host ou serviço Hermes renova o token no processo principal sem expor o valor ao renderer

### Requirement: Eventos UI Hermes ↔ Craft

O sistema MUST fornecer um contrato explícito para eventos entre a UI do dashboard Hermes e o Craft.

#### Scenario: Dashboard solicita ação Craft

- **WHEN** uma ação suportada do dashboard solicita toolbar, notificação, abrir arquivo ou reinício
- **THEN** o host transforma a solicitação em evento Craft tipado e auditável

#### Scenario: Craft notifica dashboard

- **WHEN** o Craft detecta atualização, restart, erro de runtime ou mudança de disponibilidade do dashboard
- **THEN** o host propaga o estado para a view dedicada sem duplicar lógica de runtime do `hermes-embed`
