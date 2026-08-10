## ADDED Requirements

### Requirement: Captura Hermes é durável e termina por um caminho único

O `MeetingService` SHALL persistir incrementalmente o transcript enquanto a
reunião estiver ativa e SHALL encaminhar todo sinal terminal para uma operação
idempotente que busca e persiste o tail antes de parar o plugin. Nenhuma reunião
encerrada SHALL permanecer `running`.

#### Scenario: Pane fecha durante a reunião

- **GIVEN** uma reunião Hermes `running` com transcript disponível no plugin
- **WHEN** o pane do browser fecha antes do usuário pressionar Stop
- **THEN** o serviço MUST buscar e persistir o transcript antes de parar o bot
- **AND** o record MUST terminar como `stopped` com reason `pane_closed`
Test: `apps/electron/src/main/meetings/meeting-service.test.ts`

#### Scenario: Dois sinais terminais concorrem

- **GIVEN** pane close e health check sinalizando término da mesma reunião
- **WHEN** ambos chegam concorrentemente
- **THEN** a finalização MUST executar uma única vez sem perder transcript
Test: `apps/electron/src/main/meetings/meeting-service.test.ts`

#### Scenario: Crash após poll incremental

- **GIVEN** uma reunião ativa que recebeu novas linhas desde o último poll
- **WHEN** o poll incremental conclui e o processo encerra sem finalize
- **THEN** as linhas daquele poll MUST já existir no transcript persistido
Test: `apps/electron/src/main/meetings/meeting-service.test.ts`

#### Scenario: Quit bounded com plugin travado

- **GIVEN** uma reunião ativa cujo plugin não conclui stop dentro do deadline
- **WHEN** o app recebe `before-quit`
- **THEN** o serviço MUST tentar selar a reunião e MUST permitir o quit ao fim do deadline
- **AND** o transcript incremental anterior MUST permanecer no disco
Test: teste focado do hook de shutdown e validação real da F1

### Requirement: Testes de meetings não escrevem no config real

O config root usado pelo storage SHALL aceitar override explícito em runtime, e
a suíte de meetings MUST usar um diretório temporário próprio sem criar entries
sob o `~/.craft-agent` real.

#### Scenario: Config root sobrescrito

- **WHEN** o override de config root está definido para um tmpdir
- **THEN** `getWorkspaceMeetingsPath()` MUST resolver abaixo desse tmpdir
Test: teste focado de `packages/shared/src/workspaces/storage.ts`

#### Scenario: Comportamento default preservado

- **WHEN** nenhum override está definido
- **THEN** o storage MUST continuar resolvendo o config root do usuário
Test: teste focado de `packages/shared/src/workspaces/storage.ts`

### Requirement: Join e encerramento Hermes expõem outcomes determinísticos

O bot Hermes SHALL iniciar o Google Meet com locale inglês e argumentos seguros,
SHALL expor outcomes tipados de admission/removal e o serviço SHALL reconciliar
reuniões ativas periodicamente até um estado terminal.

#### Scenario: Host rejeita admissão

- **WHEN** o host rejeita o bot no lobby
- **THEN** o record MUST terminar com reason `denial`
- **AND** a lista de meetings MUST distinguir denial de `lobby_timeout`
Test: testes focados de plugin, DTO, service e badge da F2

#### Scenario: Call termina sem interação do usuário

- **WHEN** o bot reporta call ended/removed ou a duração máxima expira
- **THEN** a reconciliação periódica MUST finalizar a reunião e preservar o transcript
Test: `apps/electron/src/main/meetings/meeting-service.test.ts` e Meet real da F2

### Requirement: Hermes captura áudio por participante com fallback de captions

O modo Hermes SHALL capturar PCM 16 kHz por media stream participante, SHALL
carregar channel id e speaker quando exatamente um tile estiver falando e MUST
manter captions como fallback quando nenhum stream de áudio puder ser capturado.

#### Scenario: Dois participantes com captions desligadas

- **GIVEN** dois participantes com media streams distintos e captions desligadas
- **WHEN** cada participante fala
- **THEN** o capture MUST produzir dois canais PCM distintos e alimentar o transcript
Test: fixtures browser-side e Meet real da F3

#### Scenario: Fala sobreposta

- **WHEN** zero ou mais de um tile está marcado como speaking para um chunk
- **THEN** o chunk MUST usar speaker desconhecido e MUST NOT adivinhar um nome
Test: teste do glow poll/binding da F3

#### Scenario: Media indisponível

- **WHEN** nenhum media element com stream vivo é encontrado
- **THEN** o modo Hermes MUST continuar por captions fallback sem falhar
Test: fixture browser-side da F3

### Requirement: STT alternativo usa dialeto OpenAI-compatible

O sistema SHALL oferecer um client multipart para
`/v1/audio/transcriptions`, mantendo Deepgram como provider default, e SHALL
filtrar silêncio antes do envio.

#### Scenario: Endpoint configurado sem suffix

- **WHEN** um endpoint compatível é configurado sem o suffix de transcrição
- **THEN** o client MUST acrescentar `/v1/audio/transcriptions` exatamente uma vez
Test: teste focado de `transcription-service.ts`

#### Scenario: Buffer silencioso

- **WHEN** o PCM fica abaixo do RMS gate configurado
- **THEN** nenhuma request STT MUST ser emitida
Test: teste focado de `transcription-service.ts`

#### Scenario: Deepgram permanece default

- **WHEN** nenhuma configuração de provider alternativo é fornecida
- **THEN** a gravação Craft-native MUST continuar usando o caminho Deepgram existente
Test: testes existentes de transcription e meeting service

### Requirement: Transcript ao vivo preserva texto confirmado

O transcript ao vivo SHALL confirmar o longest common word prefix entre
submissões consecutivas e SHALL atualizar o draft tail por um `segment_id`
estável, sem reescrever texto confirmado.

#### Scenario: Whisper resegmenta o tail

- **GIVEN** duas respostas com as mesmas palavras iniciais e limites de segmentos diferentes
- **WHEN** LocalAgreement processa a segunda resposta
- **THEN** o prefixo comum por palavra MUST avançar e o tail divergente MUST permanecer draft
Test: teste puro de LocalAgreement da F3

#### Scenario: Draft é republicado

- **WHEN** uma nova versão do draft usa o mesmo `segment_id`
- **THEN** a UI MUST substituir a linha existente e MUST NOT anexar uma segunda linha
Test: teste focado de upsert da F3 e observação real do transcript

