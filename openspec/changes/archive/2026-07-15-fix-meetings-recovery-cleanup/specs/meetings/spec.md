## ADDED Requirements

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
