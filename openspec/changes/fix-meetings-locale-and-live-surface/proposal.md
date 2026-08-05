# Fix meetings output locale and live meeting surface

## Why

Três defeitos observados numa reunião real (Google Meet, 05/08/2026, áudio em
português) degradam o fluxo de reunião de ponta a ponta.

**1. Toda saída de LLM sai em inglês, independente do áudio e do idioma do app.**
`getOutputLanguageName()` (`apps/electron/src/main/meetings/output-language.ts:22`)
lê `i18n.resolvedLanguage`. No processo main, `setupI18n()`
(`apps/electron/src/main/index.ts:12`) roda sem `lng` e sem `LanguageDetector`,
então o i18n do main fica em `fallbackLng: 'en'` — o próprio
`apps/electron/src/main/__tests__/i18n-bootstrap.test.ts:84` documenta isso.
O único caminho que muda o idioma no main é o IPC `i18n:changeLanguage`
(`apps/electron/src/main/index.ts:905`), que só dispara quando o usuário troca o
idioma nas Settings **naquela sessão** e **não persiste** o valor:
`setPersistedUiLanguage()` não tem nenhum chamador de produção. Após qualquer
restart o main volta para `en`.

O impacto vai além do resumo. `meeting-service.ts:882` passa
`toDeepgramLanguage(i18n.resolvedLanguage)` para o Deepgram: uma reunião em
português é transcrita como fonética inglesa ou volta vazia — exatamente o
"Transcript: unavailable/empty" observado. O mesmo `en` contamina o resumo
(`meeting-summary-service.ts:94`), a análise visual
(`meeting-video-analysis-service.ts:229`) e `formatPreferencesForPrompt()`.

**2. Encerrar a gravação não dá nenhum sinal de que há processamento em curso.**
`completeRecording` (`meeting-service.ts:716`) marca o record `stopped` — a lista
exibe "Finalizada" — e dispara remux → transcrição → video-analysis como
fire-and-forget que leva minutos. A UI não expõe fase alguma: o comentário em
`MeetingsPage.tsx:448` ainda cita um `ProcessingPipeline` que não existe mais.
O usuário não sabe se deu certo, falhou, ou se ainda está rodando.

**3. Não há como hospedar o Meet na página de Reuniões.** O painel de preview é
session-scoped: `AppShell.tsx:2257` descarta o pedido de dock quando não há
`rightSidebarSessionId`, e o painel só renderiza com
`rightSidebarPanel?.type === 'session-info'`. Na navegação de Reuniões não existe
sessão, então o botão de encaixar da toolbar do browser não faz nada e a call
fica numa janela flutuante solta, fora da tela onde vivem resumo e prévia.

## What Changes

- Persistir o idioma escolhido e hidratar o i18n do main a partir do disco no
  boot, para que transcrição, resumo e análise visual sigam o idioma do app em
  vez do fallback inglês.
- Derivar o idioma de saída de LLM e o código Deepgram da preferência persistida,
  não de um `i18n.resolvedLanguage` que hidrata tarde.
- Expor a fase de pós-processamento (remux, transcrição, análise) no record e
  refletir isso na lista e na página de Reuniões, com estado de erro visível.
- Mostrar a prévia do vídeo assim que o `.webm` é selado, sem esperar o fim do
  pipeline, e recarregar o player quando o remux troca o arquivo.
- Dar à página de Reuniões seu próprio host de browser, no mesmo padrão
  "frame com buraco" do `BrowserTabContent`, para a call ficar embutida na página.
- Permitir abrir uma sessão de agente ao lado do Meet hospedado, com o contexto
  da reunião ao vivo.

## Decisions

- **D-01 — Disco é a fonte do idioma no main:** a preferência persistida
  (`getPersistedUiLanguage`) SHALL ser a fonte para saída de LLM e STT. O
  `i18n.resolvedLanguage` do main é hidratado no boot, mas não é a fonte —
  ele já provou hidratar tarde (#885) e o `resolveTitleLanguageName` existente
  já segue essa regra.
- **D-02 — Sem preferência não força idioma:** quando nada foi escolhido, o
  Deepgram MUST receber detecção automática de idioma em vez de `en`, e o prompt
  MUST instruir o agente a escrever no idioma da transcrição. Forçar inglês é o
  bug; forçar português seria o mesmo bug com outra cor.
- **D-03 — Fase é dado do record, não inferência da UI:** a fase de
  pós-processamento SHALL viver no `MeetingRecord`, escrita pelo serviço que a
  executa. A UI lê e renderiza; não deduz fase cruzando status de transcript.
- **D-04 — Processamento não reescreve o status terminal:** o record continua
  `stopped` ao selar. A fase é campo separado, para não quebrar consumidores que
  já leem `status`.
- **D-05 — Host próprio, mecânica compartilhada:** a página de Reuniões SHALL
  usar o mesmo contrato `setDisplayMode('integrated')` + `setEmbeddedBounds` do
  `BrowserTabContent`. A mecânica de posicionamento nativo é extraída e
  reutilizada; não se duplica o cálculo de bounds/zoom/overlay.
- **D-06 — Preview de sessão não vira global:** o painel de preview do chat
  continua session-scoped. A página de Reuniões ganha um host próprio; nada em
  `content-tabs-state` deixa de ser escopo de sessão.
- **D-07 — Validação real por fase:** typecheck e testes não encerram fase. Cada
  fase MUST ser observada numa reunião real do Google Meet antes de promoção,
  seguindo a mesma regra de `harden-craft-recording-capture` e
  `harden-meetings-vexa`.

## Capabilities

### Modified Capabilities

- `meetings`: idioma de saída de transcrição/resumo/análise, visibilidade do
  pós-processamento e hospedagem da call na página de Reuniões.
- `settings-and-config`: persistência da preferência de idioma da UI e hidratação
  do i18n no processo main.

## Impact

- `apps/electron/src/main/index.ts`
- `apps/electron/src/main/meetings/output-language.ts`
- `apps/electron/src/main/meetings/meeting-service.ts`
- `apps/electron/src/main/meetings/meeting-summary-service.ts`
- `apps/electron/src/main/meetings/meeting-video-analysis-service.ts`
- `apps/electron/src/renderer/pages/MeetingsPage.tsx`
- `apps/electron/src/renderer/components/app-shell/MeetingsListPanel.tsx`
- `apps/electron/src/renderer/components/browser/BrowserTabContent.tsx`
- `apps/electron/src/renderer/components/app-shell/AppShell.tsx`
- `apps/electron/src/shared/types.ts`
- `packages/shared/src/config/preferences.ts`
- `packages/shared/src/i18n/locales/*.json`

## Non-goals

- Trocar de provedor de STT ou mexer no pipeline Hermes — é `harden-meetings-vexa`.
- Tornar o painel de preview do chat global (fora de escopo de sessão).
- Traduzir a UI para novos idiomas ou revisar as traduções existentes.
- Streaming de transcrição ao vivo durante a call.
- Push, deploy ou release do Craft.
