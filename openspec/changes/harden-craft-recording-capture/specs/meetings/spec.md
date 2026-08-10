## ADDED Requirements

### Requirement: Gravação craft é referenciada desde o primeiro byte

O `MeetingService` SHALL referenciar o arquivo `.webm` de uma gravação craft no
record da reunião desde o primeiro byte gravado, via
`MeetingService.attachRecordingTarget`, marcando `MeetingRecordingMetadata.partial`
como verdadeiro enquanto a gravação não for selada. Um parcial referenciado MUST
sobreviver ao sweep de órfãos (`reconcileOrphanRecordings`) e a um restart do app.
Uma gravação craft interrompida por crash, quit ou destroy do pane MUST terminar
`stopped` com `recording.partial` verdadeiro e o arquivo preservado no disco.

#### Scenario: Parcial sobrevive ao sweep de órfãos num restart

- **GIVEN** uma gravação craft cujo `.webm` foi referenciado por `attachRecordingTarget` com `partial` verdadeiro
- **WHEN** o app reinicia e `reconcileOrphanRecordings` roda
- **THEN** o arquivo parcial MUST permanecer no disco por estar referenciado no record
- **AND** `recording.partial` MUST continuar verdadeiro
Test: `apps/electron/src/main/meetings/meeting-service.test.ts`

#### Scenario: Boot marca gravação craft sem pane como interrompida

- **GIVEN** um record craft `running` cujo pane não existe mais após um restart
- **WHEN** o boot reconcilia os live statuses
- **THEN** o record MUST terminar `stopped` com `recording.partial` verdadeiro
- **AND** o `.webm` parcial MUST permanecer no disco
Test: `apps/electron/src/main/meetings/meeting-service.test.ts`

### Requirement: Start craft reutiliza o record vivo no mesmo pane

O start craft SHALL devolver o record vivo existente em vez de criar um segundo
quando o chamador informa `browserInstanceId` e já existe um record craft vivo
(`starting`/`running`) para a mesma reunião no mesmo pane. Duas superfícies
iniciam reunião craft pelo mesmo `MeetingService.start`: a página (que cria o
pane) e o botão da toolbar desse pane (que prepara a gravação). Sem essa dedupe,
cada sessão de gravação gera dois records — um "fantasma", sem gravação, preso
em `running` até o pane fechar, e um real com o `.webm`.

#### Scenario: Página e toolbar não criam records gêmeos

- **GIVEN** um record craft vivo para uma reunião num pane
- **WHEN** `start` é chamado de novo com o mesmo `browserInstanceId` e o mesmo código de reunião
- **THEN** o sistema MUST devolver o record existente sem criar outro
- **AND** o pane MUST NOT ser recriado
Test: `apps/electron/src/main/meetings/meeting-service.test.ts`

#### Scenario: Reunião diferente no mesmo pane cria record novo

- **GIVEN** um record craft vivo para uma reunião num pane
- **WHEN** `start` é chamado com o mesmo pane mas outro código de reunião
- **THEN** o sistema MUST criar um record novo
Test: `apps/electron/src/main/meetings/meeting-service.test.ts`

#### Scenario: Record parado não é reutilizado

- **GIVEN** um record craft `stopped` para uma reunião num pane
- **WHEN** `start` é chamado de novo para a mesma reunião no mesmo pane
- **THEN** o sistema MUST criar um record novo
Test: `apps/electron/src/main/meetings/meeting-service.test.ts`

### Requirement: Selar a gravação limpa a marca de parcial

O `MeetingService` SHALL limpar `MeetingRecordingMetadata.partial` ao concluir uma
gravação craft por `completeRecording`, de modo que um record selado nunca
permaneça marcado como parcial.

#### Scenario: Gravação concluída pelo usuário

- **GIVEN** uma gravação craft com `recording.partial` verdadeiro
- **WHEN** `completeRecording` persiste a gravação selada
- **THEN** `recording.partial` MUST ser falsy no record resultante
Test: `apps/electron/src/main/meetings/meeting-service.test.ts`

### Requirement: Quit e relaunch selam gravações craft sem o renderer

O main process SHALL selar todas as gravações craft ativas ao encerrar
(`shutdownCraftRecordings`) e antes de relançar, sem depender do renderer. Para
isso o `mimeType` SHALL viajar no prepare da gravação e ficar armazenado em
`RecordingService`, de modo que `RecordingService.finalizeAll` e
`RecordingService.finalizeForInstance` possam finalizar cada `.webm` e
`sealRecording` persistir o resultado. Uma stream com erro MUST NOT bloquear a
selagem das demais. A operação assume a limitação de perder no máximo o último
timeslice (~1s), porque o renderer não tem como dar flush no quit.

#### Scenario: prepare guarda o mime e finalize o reutiliza

- **GIVEN** uma gravação preparada com `mimeType` informado no prepare
- **WHEN** a gravação é finalizada sem `mimeType` explícito
- **THEN** a finalização MUST reutilizar o mime armazenado no prepare
Test: `apps/electron/src/main/meetings/recording-service.test.ts`

#### Scenario: Uma stream ruim não bloqueia as outras

- **GIVEN** várias gravações craft ativas, uma delas com stream em erro
- **WHEN** `finalizeAll` roda no shutdown
- **THEN** a gravação com erro MUST ser logada e pulada
- **AND** as demais MUST ser seladas por `sealRecording`
Test: `apps/electron/src/main/meetings/recording-service.test.ts`

#### Scenario: finalizeForInstance filtra por instância

- **GIVEN** gravações craft ativas em instâncias de pane distintas
- **WHEN** `finalizeForInstance` é chamado para uma instância
- **THEN** somente as gravações daquela instância MUST ser finalizadas
Test: `apps/electron/src/main/meetings/recording-service.test.ts`

#### Scenario: Quit bounded sela e aceita perder o último timeslice

- **GIVEN** uma gravação craft ativa quando o app recebe o quit
- **WHEN** `shutdownCraftRecordings` roda dentro do bloco bounded de shutdown
- **THEN** a gravação MUST ser selada e o arquivo preservado no disco
- **AND** no máximo o último timeslice (~1s) MAY ser perdido, sem outra perda
Test: validação em Google Meet real da F1

#### Scenario: Relaunch sela antes de relançar

- **GIVEN** uma gravação craft ativa
- **WHEN** o app é relançado
- **THEN** `shutdownCraftRecordings` MUST concluir antes do relaunch
- **AND** o `.webm` MUST ficar selado e preservado no disco
Test: validação em Google Meet real da F1

### Requirement: Destroy ou troca de perfil de pane em gravação passa pelo release hook

O `browser-pane-manager` SHALL disparar o release hook (`setCaptureReleaseHook`)
no topo de `destroyInstance` e em `switchProfile` quando a instância tiver
`captureLock`, e o hook SHALL selar a gravação da instância por
`sealCraftRecordingsForInstance`. Um pane em gravação que é destruído ou tem o
perfil trocado MUST NOT deixar o record `running`.

#### Scenario: Destroy de pane em gravação dispara o hook

- **GIVEN** uma instância de pane com `captureLock` e gravação craft ativa
- **WHEN** `destroyInstance` roda
- **THEN** o release hook MUST ser disparado para a instância
Test: `apps/electron/src/main/__tests__/browser-pane-manager.test.ts`

#### Scenario: Gravação da instância é selada e o record não fica running

- **GIVEN** um pane em gravação que é destruído ou tem o perfil trocado
- **WHEN** `sealCraftRecordingsForInstance` roda pelo hook
- **THEN** a gravação MUST ser selada e o arquivo preservado
- **AND** o record MUST terminar `stopped`, nunca `running`
Test: `apps/electron/src/main/meetings/meeting-service.test.ts`

### Requirement: Pane em gravação não é adotado por sessão de agente

Um pane com `captureLock` MUST NOT ser adotado por uma sessão de agente.
`findReusableUnboundInstance` SHALL excluir instâncias com `captureLock`. Quando
`createForSession` encontrar uma instância vinculada porém travada, o sistema
SHALL desvinculá-la e criar uma janela nova para a sessão, preservando a gravação
em curso. O `captureLock` (`BrowserPaneCaptureLock`), definido por
`setCaptureLock` e lido por `getCaptureLock`, SHALL aparecer no DTO da instância.

#### Scenario: Pane travado não é reusado

- **GIVEN** um pane manual desvinculado com `captureLock`
- **WHEN** `findReusableUnboundInstance` procura um pane reusável
- **THEN** o pane travado MUST NOT ser escolhido
Test: `apps/electron/src/main/__tests__/browser-pane-manager.test.ts`

#### Scenario: Pane vinculado e travado recebe janela nova

- **GIVEN** um pane já vinculado a uma sessão e com `captureLock`
- **WHEN** `createForSession` roda para essa sessão
- **THEN** o pane MUST ser desvinculado e a sessão MUST receber uma janela nova
- **AND** a gravação em curso MUST continuar
Test: `apps/electron/src/main/__tests__/browser-pane-manager.test.ts`

#### Scenario: captureLock exposto no DTO

- **GIVEN** uma instância com `captureLock` definido por `setCaptureLock`
- **WHEN** a instância é serializada para DTO e para snapshot
- **THEN** `captureLock` MUST aparecer em `BrowserInstanceInfo` e no snapshot
Test: `apps/electron/src/main/__tests__/browser-pane-manager.test.ts`

### Requirement: Seam do agente recusa operações em pane travado

O seam por `ownerKey` do `browser-pane-manager` SHALL recusar `navigate` e
`destroyInstance` quando o pane tiver `captureLock`, sinalizando erro codificado.
Essa defesa em profundidade MUST NOT afetar a navegação do usuário sobre o
próprio pane.

#### Scenario: Operação remota é recusada em pane travado

- **GIVEN** um pane com `captureLock`
- **WHEN** o seam do agente tenta `navigate` ou `destroyInstance` nesse pane
- **THEN** a operação MUST ser recusada com erro codificado
- **AND** a navegação do usuário sobre o pane MUST permanecer permitida
Test: validação em Google Meet real da F2

### Requirement: Transcrição usa o idioma ativo do app

O `TranscriptionService` SHALL enviar o idioma do locale ativo do app ao
Deepgram. Sem `language`, o Deepgram assume inglês e fonetiza áudio em outro
idioma como palavras inglesas — foi o que produziu uma transcrição sem sentido
de uma call em português. Locale sem código mapeado SHALL cair em
`detect_language=true` em vez de impor um idioma errado.

#### Scenario: Call em português é transcrita em português

- **GIVEN** o app com locale `pt-BR` e uma gravação em português
- **WHEN** `transcribe` é chamado
- **THEN** o request MUST incluir `language=pt-BR`
- **AND** MUST NOT incluir `detect_language`
Test: `apps/electron/src/main/meetings/transcription-service.isolated.ts`

#### Scenario: Locale sem código mapeado pede detecção

- **GIVEN** um locale sem código Deepgram mapeado
- **WHEN** `transcribe` é chamado
- **THEN** o request MUST incluir `detect_language=true`
- **AND** MUST NOT incluir `language`
Test: `apps/electron/src/main/meetings/transcription-service.isolated.ts`

### Requirement: Conteúdo gerado por LLM sai no idioma do app

O resumo (`meeting-summary-service`) SHALL escrever o documento inteiro no
idioma ativo do app, cabeçalhos incluídos, e a análise visual
(`meeting-video-analysis-service`) SHALL fazer o mesmo. A língua de saída é a
do usuário do Craft, não a da transcrição — uma transcrição errada não pode
arrastar o resumo para o idioma errado. Fala citada MAY manter o idioma
original.

#### Scenario: Resumo de call estrangeira sai no idioma do usuário

- **GIVEN** o app com locale `pt-BR` e uma transcrição em inglês
- **WHEN** o resumo ou a análise visual são gerados
- **THEN** o documento MUST ser escrito em português, cabeçalhos incluídos
Test: validação em Google Meet real da F5

### Requirement: Documentos de detalhe da reunião no renderer seguem i18n

Os documentos montados no `MeetingsPage` SHALL usar chaves i18n para
rótulos, cabeçalhos, status e falante padrão — sem strings de idioma hardcoded.
O status MUST reutilizar `meetingStatusLabelKey`, para que "Interrompida"
apareça igual na lista e no detalhe.

#### Scenario: Detalhe da reunião em pt-BR

- **GIVEN** o app com locale `pt-BR`
- **WHEN** o usuário abre a aba Resumo ou Transcrição de uma reunião
- **THEN** rótulos (Origem/Status/Link/Captura/Duração), cabeçalhos e o falante padrão MUST sair em português
Test: `bun run lint:i18n:parity`

### Requirement: Gravação craft finaliza quando o pane deixa a reunião

A gravação craft SHALL ser finalizada quando o pane capturado deixar a reunião
em curso, porque navegar o pane não encerra as faixas capturadas: medição em
Electron 43 mostra a gravação seguindo ativa após `loadURL` cross-document, sem
`track-ended` e com o novo conteúdo entrando no mesmo `.webm`. A decisão SHALL
ficar isolada num helper puro `shouldFinalizeOnMeetNavigation(activeRecordingMeetUrl, currentUrl)`,
e o auto-finalize por `track.ended` MUST continuar cobrindo o encerramento do
compartilhamento e o teardown do frame capturado.

#### Scenario: Pane navega para fora da reunião durante a gravação

- **GIVEN** uma gravação craft ativa em um pane exibindo a reunião
- **WHEN** o pane navega para uma URL que não é a reunião em curso
- **THEN** a gravação MUST ser finalizada e selada
- **AND** o `.webm` MUST NOT receber conteúdo posterior à saída da reunião
Test: `apps/electron/src/renderer/lib/__tests__/meet-navigation-finalize.test.ts`

#### Scenario: Navegação dentro da mesma reunião não finaliza

- **GIVEN** uma gravação craft ativa em um pane exibindo a reunião
- **WHEN** a URL muda mas continua sendo a mesma reunião em curso
- **THEN** a gravação MUST continuar ativa
Test: `apps/electron/src/renderer/lib/__tests__/meet-navigation-finalize.test.ts`

### Requirement: Timer de gravação visível na toolbar e na sidebar

Enquanto uma gravação craft estiver ativa, a toolbar SHALL exibir o tempo
decorrido no botão de parar e a sidebar SHALL exibir o tempo decorrido na linha
da reunião ao vivo, ambos formatados por `formatRecordingElapsed` como `m:ss`
abaixo de uma hora e `h:mm:ss` a partir de uma hora. Cada superfície SHALL usar
um único intervalo de tick, nunca um por linha. O timer é indicador do clock do
renderer, não medição autoritativa de duração.

#### Scenario: Formato do tempo decorrido

- **GIVEN** um tempo decorrido em milissegundos
- **WHEN** `formatRecordingElapsed` formata o valor
- **THEN** valores abaixo de uma hora MUST sair como `m:ss` e a partir de uma hora como `h:mm:ss`
- **AND** valores negativos ou `NaN` MUST sair como `0:00`
Test: `apps/electron/src/renderer/lib/__tests__/recording-elapsed.test.ts`

#### Scenario: Toolbar mostra o tempo no botão de parar

- **GIVEN** uma gravação craft ativa
- **WHEN** a toolbar renderiza o botão de parar
- **THEN** o rótulo MUST usar `meetings.recordStopWithElapsed` com o tempo decorrido
- **AND** a superfície MUST manter um único intervalo de tick
Test: validação em Google Meet real da F3

#### Scenario: Sidebar mostra o tempo na linha ao vivo

- **GIVEN** ao menos uma reunião com status `running` na lista
- **WHEN** a sidebar renderiza a linha ao vivo
- **THEN** o subtítulo MUST usar `meetings.statusRunningWithElapsed` com o tempo decorrido
- **AND** a sidebar MUST usar um único intervalo por painel
Test: validação em Google Meet real da F3

### Requirement: Sidebar sinaliza gravação interrompida

A sidebar SHALL exibir o status "Interrompida" (`meetings.statusInterrupted`)
para um record `stopped` cujo `recording.partial` seja verdadeiro. A decisão do
rótulo de status SHALL ser derivada por um helper puro testável.

#### Scenario: Record stopped e parcial mostra Interrompida

- **GIVEN** um record `stopped` com `recording.partial` verdadeiro
- **WHEN** a sidebar deriva o rótulo de status
- **THEN** o rótulo MUST ser `meetings.statusInterrupted`
Test: teste do helper de label da sidebar em `apps/electron/src/renderer/lib/__tests__/`

### Requirement: Ações de arquivar e excluir são só-ícone e acessíveis

Os botões de arquivar e excluir na linha da sidebar SHALL ser só-ícone, sem
rótulo de texto, e MUST preservar `aria-label` e `title` derivados de
`meetings.archive` e `meetings.delete`, de modo que a acessibilidade não regrida.

#### Scenario: Botões só-ícone mantêm nome acessível

- **GIVEN** uma linha de reunião na sidebar
- **WHEN** os botões de arquivar e excluir são renderizados só com ícone
- **THEN** cada botão MUST expor `aria-label` e `title` de `meetings.archive` e `meetings.delete`
Test: validação em Google Meet real da F3

### Requirement: Chaves i18n de gravação têm paridade nos oito locales

As novas chaves de gravação SHALL existir e ter tradução própria em cada um dos
oito locales suportados (en, de, es, hu, ja, pl, pt-BR, zh-Hans), sem copiar o
texto em inglês nos locales não-EN: `meetings.recordStopWithElapsed`,
`meetings.statusRunningWithElapsed`, `meetings.statusInterrupted` e
`meetings.recordingNoAudio`.

#### Scenario: Paridade de chaves nos locales

- **GIVEN** os oito arquivos de locale
- **WHEN** `lint:i18n:parity` roda
- **THEN** todos os locales MUST conter as quatro chaves novas
- **AND** os locales não-EN MUST ter tradução própria, não o texto en
Test: `bun run lint:i18n:parity`

### Requirement: Gravação sem faixa de áudio avisa e continua

Quando o stream capturado não incluir nenhuma faixa de áudio, o sistema SHALL
avisar com `meetings.recordingNoAudio` e MUST continuar gravando o vídeo.
Diferente da ausência de faixa de vídeo, a ausência de faixa de áudio MUST NOT
abortar a gravação.

#### Scenario: Stream sem áudio grava só vídeo

- **GIVEN** um stream capturado sem nenhuma faixa de áudio
- **WHEN** a gravação inicia
- **THEN** o sistema MUST avisar com `meetings.recordingNoAudio`
- **AND** a gravação MUST continuar capturando vídeo
Test: validação em Google Meet real da F4

### Requirement: Mixagem do mic local não aborta a gravação quando o mic falha

O sistema SHALL mixar a faixa do mic local (`getUserMedia`) com o áudio de aba
(`getDisplayMedia`) num único stream, e a falha ao obter o mic MUST NOT abortar a
gravação — o sistema SHALL degradar para áudio de aba e avisar. Esta requirement
é condicionada à confirmação, em call real, de que a voz local não entra na
captura de áudio de aba.

#### Scenario: Mic indisponível degrada sem abortar

- **GIVEN** a hipótese confirmada em call real e o mic local indisponível
- **WHEN** a gravação inicia e `getUserMedia` falha
- **THEN** a gravação MUST continuar com o áudio de aba
- **AND** o sistema MUST NOT abortar por causa da falha do mic
Test: validação em Google Meet real da F4
