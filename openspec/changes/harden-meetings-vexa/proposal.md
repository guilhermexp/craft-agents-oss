# Harden meetings with durable lifecycle and Vexa-informed capture

## Why

O modo Hermes perde a transcrição quando a reunião termina fora do botão Stop,
pode manter records em `running` indefinidamente e deixa dados de testes no
`~/.craft-agent`. Além disso, o scraping de captions limita a qualidade e a
atribuição de participantes. O plano
`docs/plans/2026-07-28-001-feat-meetings-vexa-hardening-plan.md` define um
programa em três fases para corrigir primeiro a confiabilidade e depois adotar
técnicas portáveis do Vexa, mantendo o escopo desktop single-user do Craft.

## What Changes

- Convergir todos os encerramentos Hermes em uma finalização idempotente que
  busca e persiste a transcrição antes de parar o bot.
- Persistir a transcrição incrementalmente e finalizar reuniões durante quit,
  pane teardown, bot exit e chamadas encerradas sem interação da UI.
- Isolar o config root dos testes de meetings para que a suíte não escreva no
  diretório real do usuário.
- Tornar join/exit determinísticos por locale, outcomes tipados e reconciliação
  periódica com duração máxima.
- Portar, com atribuição Apache-2.0, a captura browser-side de áudio
  per-participant inspirada no Vexa, mantendo captions como fallback.
- Adicionar um cliente STT OpenAI-compatible sem substituir o caminho Deepgram
  default e estabilizar o transcript ao vivo com confirmed/draft + upsert.

## Decisions

- **D-01 — Durabilidade incremental:** transcript capturado MUST chegar ao disco
  durante a reunião; finalizar apenas sela o tail e o estado terminal.
- **D-02 — Finalização única:** todos os sinais terminais MUST passar por uma
  operação idempotente que busca transcript antes de `stop`.
- **D-03 — Config de teste no root:** o config root SHALL aceitar override por
  env lido em runtime; sem override, o comportamento em `homedir()` permanece.
- **D-04 — Áudio primário, captions fallback:** o modo `hermes` ganha áudio
  per-participant sem remover o scraping existente quando não houver media.
- **D-05 — Dialeto, não SDK:** STT alternativo SHALL usar multipart
  `/v1/audio/transcriptions`; Deepgram continua default e sem breaking change.
- **D-06 — Naming honesto:** exatamente um tile ativo permite atribuição;
  nenhum ou múltiplos tiles produz speaker desconhecido, nunca um palpite.
- **D-07 — Validação real por fase:** testes e typecheck não encerram uma fase;
  cada fase MUST ser observada em um Google Meet real antes de promoção.

## Capabilities

### Modified Capabilities

- `meetings`: fortalece lifecycle, durabilidade, isolamento de testes,
  join/exit, captura de áudio, STT e estabilidade do transcript ao vivo.

## Impact

- `apps/electron/src/main/meetings/**`
- `apps/electron/src/main/index.ts`
- `apps/electron/src/renderer/pages/MeetingsPage.tsx`
- `apps/electron/src/renderer/components/app-shell/MeetingsListPanel.tsx`
- `packages/shared/src/workspaces/storage.ts`
- `packages/shared/src/protocol/dto.ts`
- `apps/electron/scripts/hermes-patches/**`
- `apps/electron/resources/vendor/hermes/**` somente como output regenerado
- `THIRD_PARTY_LICENSES.md`

## Non-goals

- Portar gateway, Redis, Postgres, MinIO, Kubernetes ou multi-tenancy do Vexa.
- Adicionar Zoom, Teams ou Jitsi.
- Provisionar o serviço faster-whisper ou alterar upload/storage de vídeo.
- Portar humanização X11 ou o binder energia↔glow nesta change.
- Fazer push, deploy ou release do Craft.

