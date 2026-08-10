## ADDED Requirements

### Requirement: Idioma de transcrição e de saída vem da preferência persistida

A transcrição e toda saída de LLM da reunião SHALL derivar o idioma da
preferência de idioma persistida da UI (`getPersistedUiLanguage`), não de
`i18n.resolvedLanguage`.

`getOutputLanguageName()` MUST resolver a partir da preferência persistida e o
código Deepgram MUST ser derivado da mesma fonte. Quando não há preferência
persistida, o Deepgram MUST receber detecção automática de idioma (`null`, que o
chamador traduz em `detect_language`) e o prompt de resumo e de análise visual
MUST instruir o agente a escrever no idioma da transcrição em vez de fixar um
idioma.

Forçar `en` por fallback transcreve áudio em português como fonética inglesa e
produz resumo e análise visual em inglês, o que foi observado numa reunião real.

#### Scenario: Reunião em português com app em pt-BR

- **GIVEN** `uiLanguage: 'pt-BR'` persistido e uma gravação com áudio em português
- **WHEN** o pós-processamento roda
- **THEN** a chamada ao Deepgram MUST usar o código de idioma `pt-BR`
- **AND** o prompt de resumo e o de análise visual MUST pedir o documento em
  Português (Brasil)
Test: `apps/electron/src/main/meetings/output-language.isolated.ts`

#### Scenario: Sem idioma persistido não se força inglês

- **GIVEN** nenhuma preferência de idioma persistida
- **WHEN** o pós-processamento roda
- **THEN** o código de idioma enviado ao Deepgram MUST ser nulo, habilitando
  detecção automática
- **AND** o prompt MUST instruir o agente a escrever no idioma da transcrição
Test: `apps/electron/src/main/meetings/output-language.isolated.ts`

### Requirement: Fase de pós-processamento é visível após encerrar a gravação

O `MeetingRecord` SHALL expor a fase corrente do pós-processamento e a UI de
reuniões SHALL exibi-la enquanto ela durar.

O serviço que executa cada etapa MUST escrever a fase no record: preparação do
arquivo, transcrição, análise/resumo, concluído e falhou. A lista de reuniões e a
página de reuniões MUST exibir a fase corrente em vez de apresentar como
"Finalizada" uma gravação cujo pipeline ainda está rodando, e MUST exibir estado
de falha quando uma etapa falha. O `status` terminal do record MUST permanecer
`stopped`: a fase é campo separado.

#### Scenario: Encerrar gravação mostra progresso em vez de silêncio

- **GIVEN** uma gravação craft com transcrição habilitada
- **WHEN** o usuário para a gravação
- **THEN** o record MUST expor uma fase de pós-processamento não concluída
- **AND** a lista e a página MUST exibir essa fase em vez de "Finalizada"
Test: `apps/electron/src/main/meetings/meeting-service.test.ts`

#### Scenario: Cada etapa atualiza a fase até concluir

- **GIVEN** uma gravação em pós-processamento
- **WHEN** a transcrição termina e a análise começa
- **THEN** a fase MUST refletir a etapa corrente
- **AND** ao fim de todas as etapas a fase MUST ser a de concluído
Test: `apps/electron/src/main/meetings/meeting-service.test.ts`

#### Scenario: Falha no pipeline é visível

- **GIVEN** uma gravação cujo pós-processamento falha
- **WHEN** a etapa reporta erro
- **THEN** a fase MUST ser a de falha
- **AND** a UI MUST exibir o estado de falha em vez de progresso indefinido
Test: `apps/electron/src/main/meetings/meeting-service.test.ts`

### Requirement: Prévia da gravação aparece assim que o arquivo é selado

A prévia do vídeo SHALL ficar disponível assim que o `.webm` é selado, sem
esperar o fim do pós-processamento.

O player MUST recarregar a mídia quando o remux substitui o arquivo, para que a
prévia deixe de reportar duração infinita e passe a permitir seek sem exigir uma
nova seleção da reunião.

#### Scenario: Prévia disponível durante o processamento

- **GIVEN** uma gravação recém-encerrada cujo pós-processamento ainda roda
- **WHEN** a página de reuniões exibe a reunião
- **THEN** a prévia do vídeo MUST estar disponível para reprodução
Test: `apps/electron/src/renderer/pages/__tests__/meetings-recording-preview.test.ts`

#### Scenario: Remux recarrega o player

- **GIVEN** uma prévia carregada a partir do `.webm` cru
- **WHEN** o remux substitui o arquivo com Duration e Cues
- **THEN** o player MUST recarregar a mídia
- **AND** a duração exibida MUST ser finita
Test: `apps/electron/src/renderer/pages/__tests__/meetings-recording-preview.test.ts`

### Requirement: Página de reuniões hospeda a call embutida

A página de Reuniões SHALL hospedar o browser da reunião embutido na própria
página, sem depender de uma sessão de chat selecionada.

O host MUST usar o mesmo contrato do preview do chat — `setDisplayMode`
`'integrated'` seguido de `setEmbeddedBounds` a partir do retângulo medido — e
MUST devolver a instância ao modo flutuante ao desmontar, para que nenhuma
janela fique órfã. A mecânica de medição, conversão de zoom e ocultação sob
overlays MUST ser compartilhada com `BrowserTabContent` em vez de reimplementada.

Hoje o pedido de encaixe é descartado sem sessão selecionada
(`AppShell.tsx:2257`), então na página de Reuniões o botão não produz efeito
algum e a call permanece numa janela flutuante.

#### Scenario: Encaixar a call na página de Reuniões

- **GIVEN** uma reunião aberta numa instância de browser e nenhuma sessão de chat
  selecionada
- **WHEN** o usuário pede para encaixar a janela na página de Reuniões
- **THEN** a instância MUST entrar em modo integrado hospedada pela página
- **AND** as bounds nativas MUST acompanhar o retângulo do host
Test: `apps/electron/src/renderer/pages/__tests__/meetings-browser-host.test.ts`

#### Scenario: Sair da página devolve a janela

- **GIVEN** uma call hospedada na página de Reuniões
- **WHEN** o usuário navega para fora da página
- **THEN** a instância MUST voltar ao modo flutuante visível
Test: `apps/electron/src/renderer/pages/__tests__/meetings-browser-host.test.ts`

### Requirement: Sessão de agente pode ser aberta sobre a reunião hospedada

Com a call hospedada na página de Reuniões, o usuário SHALL poder abrir uma
sessão de agente sobre aquela reunião sem sair da página.

A sessão MUST receber o contexto da reunião hospedada — identidade da reunião e
transcrição disponível até o momento — e MUST funcionar tanto durante a call
quanto após o encerramento.

#### Scenario: Perguntar ao agente durante a call

- **GIVEN** uma reunião ao vivo hospedada na página de Reuniões
- **WHEN** o usuário abre a sessão de agente da reunião
- **THEN** a sessão MUST receber o contexto daquela reunião
- **AND** MUST responder sem que o usuário saia da página
Test: `apps/electron/src/renderer/pages/__tests__/meetings-browser-host.test.ts`
