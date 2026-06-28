## MODIFIED Requirements

### Requirement: Bot recebe contexto da reunião
O sistema SHALL entregar ao bot e à sessão Craft o contexto da reunião ao entrar, incluindo link, participantes conhecidos e agenda quando disponíveis.

#### Scenario: Contexto acompanha o convite
- **WHEN** Hermes é convidado para uma reunião com metadados de convite disponíveis
- **THEN** a sessão Craft da reunião recebe link, título, participantes conhecidos e agenda como contexto inicial.

#### Scenario: Contexto parcial continua válido
- **WHEN** apenas o link do Google Meet está disponível
- **THEN** o sistema inicia a reunião com o link e marca participantes ou agenda como desconhecidos sem bloquear o convite.

## ADDED Requirements

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
