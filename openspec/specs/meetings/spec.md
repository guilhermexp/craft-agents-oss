# meetings Specification

## Purpose
Permitir convite do agente Hermes para reuniões Google Meet a partir do BrowserView interno do Electron, usando um runtime de bot vendorizado em `apps/electron/resources/vendor/hermes` e auth Google OAuth (tokens não logados). O bot recebe contexto da reunião ao entrar, é encerrado limpamente ao fim, e em build empacotado sem runtime o convite falha fechado.
## Requirements
### Requirement: Hermes pode ser convidado pelo BrowserView
O sistema SHALL permitir que o usuário convide Hermes para um Google Meet detectado na toolbar do BrowserView interno.

#### Scenario: Convidar a partir da toolbar
- **WHEN** a toolbar do BrowserView detecta uma URL válida de Google Meet e o usuário aciona "Convidar Hermes"
- **THEN** o sistema inicia o fluxo de reunião usando a URL detectada, o perfil do navegador e a instância BrowserView existente.

#### Scenario: Rejeitar URL que não é Google Meet
- **WHEN** o convite recebe uma URL que não pertence a `meet.google.com` ou não contém código de reunião válido
- **THEN** o sistema MUST rejeitar o início da reunião com erro claro.

### Requirement: Runtime do Meet bot é vendorizado
O sistema MUST executar o Google Meet bot a partir do runtime Hermes vendorizado em `apps/electron/resources/vendor/hermes` no checkout de desenvolvimento ou do caminho equivalente empacotado.

#### Scenario: Bot inicia pelo runtime vendorizado
- **WHEN** uma reunião é iniciada com transcrição habilitada
- **THEN** o sistema executa o plugin `google_meet` usando o Python, venv e source mirror do Hermes vendorizado.

#### Scenario: Dependências do Meet bot estão no bundle
- **WHEN** o bundle Hermes é produzido
- **THEN** o runtime vendorizado contém as dependências necessárias do Google Meet bot, incluindo Playwright/Chromium quando aplicável.

### Requirement: Autenticação Google é protegida
O sistema MUST usar autenticação Google baseada em OAuth para APIs de Calendar/Meet/Drive e MUST NOT registrar tokens, cookies ou bearer secrets em logs.

#### Scenario: OAuth Google concede acesso a APIs
- **WHEN** o usuário autentica uma source Google vinculada ao workspace
- **THEN** o sistema usa OAuth com escopos explícitos para acessar Calendar, Meet ou Drive conforme a source configurada.

#### Scenario: Logs não expõem secrets
- **WHEN** handlers, bot ou runtime registram eventos de autenticação Google
- **THEN** os logs MUST NOT conter access tokens, refresh tokens, cookies, authorization codes ou bearer tokens.

### Requirement: Workspace files tab lista arquivos vinculados
O sistema SHALL listar arquivos do Drive/Workspace vinculados ao workspace do usuário para que Hermes possa consumi-los como contexto autorizado.

#### Scenario: Listar arquivos autenticados do workspace
- **WHEN** o usuário abre a workspace files tab com uma source Google Drive autenticada
- **THEN** o sistema lista os arquivos disponíveis para aquele workspace sem expor credenciais ao renderer.

#### Scenario: Workspace sem autenticação
- **WHEN** a source Google Drive exige autenticação e o workspace ainda não possui OAuth válido
- **THEN** o sistema solicita autenticação em vez de retornar arquivos protegidos.

### Requirement: Bot recebe contexto da reunião

O sistema SHALL entregar contexto da reunião ao entrar, nos dois lados que existem hoje: o **bot** recebe no payload de start o link normalizado do Google Meet, a identidade de convidado (guest name), o modo de captura e o caminho do auth state do bot dedicado; o **registro Craft** da reunião recebe link e título (quando disponível) no record e no summary inicial. Participantes e agenda não são coletados pelo sistema hoje: campos ausentes MUST ser tratados como desconhecidos sem bloquear o convite, e o sistema MUST NOT inventá-los.

#### Scenario: Bot recebe payload de start ao entrar

- **WHEN** o bot Hermes é iniciado para uma reunião (`captureMode: hermes` com transcrição habilitada)
- **THEN** o comando `start` do plugin `google_meet` recebe a URL normalizada `meet.google.com`, o guest name do bot, o modo de captura e o auth state do bot dedicado
- **AND** o start falha com erro claro se o auth state do bot não existir

#### Scenario: Contexto acompanha o convite

- **WHEN** Hermes é convidado para uma reunião com metadados de convite disponíveis
- **THEN** o record Craft da reunião e seu summary inicial recebem link e título da reunião

#### Scenario: Contexto parcial continua válido

- **WHEN** apenas o link do Google Meet está disponível
- **THEN** o sistema inicia a reunião com o link e trata participantes ou agenda como desconhecidos sem bloquear o convite

### Requirement: Encerramento libera recursos do bot
O sistema MUST liberar recursos do Google Meet bot quando a reunião é encerrada.

#### Scenario: Parar reunião ativa
- **WHEN** o usuário ou o sistema encerra uma reunião ativa
- **THEN** o sistema chama o comando de parada do Meet bot, encerra o subprocesso ativo e atualiza o status da reunião.

#### Scenario: Processo já terminou
- **WHEN** a reunião é encerrada mas o subprocesso do bot já não está ativo
- **THEN** o sistema limpa o ponteiro ativo e retorna estado final sem deixar a reunião como `running`.

### Requirement: Build empacotado falha fechado sem runtime
O sistema MUST falhar fechado quando o app empacotado não contém o runtime Hermes necessário para convidar Hermes ao Meet.

#### Scenario: Runtime ausente em build empacotado
- **WHEN** o usuário tenta convidar Hermes para um Meet em um app empacotado sem runtime vendorizado
- **THEN** o comando de convite falha com erro claro e MUST NOT executar um `hermes` global do `PATH`.

#### Scenario: Runtime presente
- **WHEN** o runtime Hermes vendorizado está presente e o bot está autenticado
- **THEN** o comando de convite pode iniciar o subprocesso do Meet bot.

### Requirement: Craft processa gravações nativas de reunião
O sistema SHALL gravar reuniões nativas em vídeo WebM, transcrever o áudio usando Deepgram e, quando solicitado, SHALL produzir Markdown pós-reunião com resumo e follow-up.

#### Scenario: Gravar vídeo da reunião
- **WHEN** uma gravação Craft-native é iniciada a partir do BrowserView de uma reunião
- **THEN** o sistema captura vídeo e áudio da reunião em arquivo WebM
- **AND** rejeita a gravação se o stream capturado não incluir faixa de vídeo.

#### Scenario: Transcrever com Deepgram
- **WHEN** uma gravação Craft-native termina com provedor `deepgram`, modelo e API key configurados
- **THEN** o sistema envia o áudio para a Listen API da Deepgram com utterances, diarization e punctuation habilitados
- **AND** persiste segmentos com speaker, texto e timestamps quando retornados.

#### Scenario: Rejeitar outros provedores de transcrição
- **WHEN** a configuração ou início de reunião recebe um provedor diferente de `deepgram`, incluindo `groq`
- **THEN** o sistema rejeita a operação com erro claro de provedor não suportado.

#### Scenario: Gerar resumo e follow-up
- **WHEN** a transcrição fica pronta e `summarizeOnEnd` ou `followUpOnEnd` está habilitado
- **THEN** o sistema executa o LLM Craft configurado, exceto Hermes, para gerar Markdown pós-reunião
- **AND** quando `followUpOnEnd` está habilitado, o Markdown deve pedir próximos passos, responsáveis e prazos quando mencionados.

### Requirement: Transcrições interrompidas não sobrevivem a um boot em capturing

O `MeetingService` SHALL executar recovery de boot para cada transcript
persistido com `status:'capturing'`: re-disparar `transcribeRecording` quando
o áudio gravado existe no disco e o record tem provider/model de transcrição;
caso contrário, rebaixar o transcript para `unavailable` com mensagem
acionável.
Nenhum transcript SHALL permanecer em `capturing` sem processamento ativo após
o recovery de boot.

#### Scenario: crash durante a transcrição com áudio disponível

- **GIVEN** um transcript persistido em `capturing` cujo record referencia um `.webm` existente e tem provider/model configurados
- **WHEN** o app inicia e o recovery de boot roda
- **THEN** `transcribeRecording` é re-disparado e o transcript sai de `capturing` (para `ready`, ou `unavailable` se key/rede falharem)

#### Scenario: crash durante a transcrição com áudio ausente

- **GIVEN** um transcript persistido em `capturing` cujo áudio gravado não existe mais no disco
- **WHEN** o recovery de boot roda
- **THEN** o transcript é rebaixado para `unavailable` com mensagem explicando a interrupção

### Requirement: Timeout da extração de evidência não deixa ffmpeg órfão

O helper `video_evidence.py` SHALL impor timeout interno em cada invocação de
ffmpeg/ffprobe via `subprocess.run(timeout=...)`, com budgets menores que o
timeout do processo TS que o invoca, de modo que um passo lento seja morto
pelo próprio python (matando o ffmpeg filho) em vez de sobreviver como órfão
quando o TS mata o python.

#### Scenario: contact sheet lento demais

- **GIVEN** um vídeo cuja decodificação do contact sheet excede o budget interno
- **WHEN** o timeout interno dispara
- **THEN** o ffmpeg é morto pelo python, o passo é tratado como falha best-effort e o pipeline continua sem processo órfão

### Requirement: Abort de gravação limpa o parcial e fecha o meeting

`RecordingService.abort()` SHALL remover o `.webm` parcial do disco
(best-effort) e SHALL devolver os identificadores necessários para o handler
fechar o meeting record associado, que não pode permanecer `running`.

#### Scenario: usuário aborta uma gravação em andamento

- **GIVEN** uma gravação ativa com bytes já escritos no `.webm` e um meeting record `running`
- **WHEN** `abort()` é chamado
- **THEN** o arquivo parcial é removido do disco e o meeting record é marcado como `stopped`

### Requirement: Upload Deepgram é streaming e com timeout

O `TranscriptionService` SHALL enviar o áudio gravado ao Deepgram como stream
de arquivo (sem carregar a gravação inteira em memória) e SHALL passar um
`AbortSignal` com timeout explícito ao `fetch`, preservando o tratamento de
erro existente que rebaixa o transcript para `unavailable`.

#### Scenario: gravação longa é transcrita

- **GIVEN** uma gravação de várias horas (~GBs) no disco
- **WHEN** `transcribe` é chamado
- **THEN** o body do request é um stream do arquivo (não um Buffer único em RAM) e o fetch tem um `AbortSignal` que o aborta se exceder o timeout

### Requirement: UI de meetings é traduzida em todos os locales

Todas as keys do namespace `meetings.*` (e `sidebar.meetings`) SHALL ter
tradução própria em cada locale não-EN suportado, exceto valores
legitimamente neutros (nomes próprios como "Hermes" e placeholders técnicos
como URLs de exemplo), que MAY permanecer idênticos ao en.json.

#### Scenario: Locale não-EN sem keys de meetings em inglês

- **GIVEN** um locale suportado diferente de en (de, es, hu, ja, pl, zh-Hans, pt-BR)
- **WHEN** as keys `meetings.*` são comparadas byte a byte com en.json
- **THEN** apenas as neutras legítimas (`meetings.captureModeHermes`, `meetings.inputPlaceholder` e equivalentes) são idênticas

#### Scenario: Paridade de keys preservada

- **GIVEN** os 7 arquivos de locale
- **WHEN** `lint:i18n:parity` roda
- **THEN** todo locale tem o mesmo conjunto de keys que en.json (variantes plurais podem divergir conforme as regras do idioma)

### Requirement: Summary de reunião gerado no idioma ativo

O summary Markdown gerado pelo main process SHALL usar o sistema i18n
compartilhado, sem strings de idioma hardcoded, e SHALL formatar datas com o
locale ativo do app em vez de `'pt-BR'` fixo. Isso cobre
`createMeetingSummaryMarkdown` e as mensagens de transcrição em
`meeting-service.ts`.

#### Scenario: Summary no idioma do app

- **GIVEN** o app com idioma ativo alemão
- **WHEN** uma gravação termina e o summary Markdown é gerado
- **THEN** labels (Origem/Status/Link/Início/Fim), status e corpo saem em alemão e as datas usam formatação `de`

#### Scenario: Fallback consistente

- **GIVEN** um contexto onde o i18n resolve para en (default/fallback)
- **WHEN** o summary é gerado
- **THEN** o documento inteiro sai em inglês — sem mistura EN+PT-BR

