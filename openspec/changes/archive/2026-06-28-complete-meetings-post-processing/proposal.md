## Why

O WIP atual de Meetings deixou lacunas funcionais entre o plano e o codigo:

- O produto deve ser Deepgram-only neste momento; qualquer plano ou contrato citando Groq esta errado.
- `followUpOnEnd` e persistido, mas nao altera o prompt nem gera uma secao de follow-up util.
- O resumo pos-reuniao roda apenas quando ha transcript pronto, mas o contrato ainda nao esta descrito na spec.

## What Changes

- Manter Deepgram como unico provedor aceito e preservar o parsing por utterances/paragraphs.
- Garantir que provedores desconhecidos, incluindo `groq`, falhem nos pontos de entrada de API/config.
- Fazer `summarizeOnEnd` e `followUpOnEnd` influenciarem o processamento pos-reuniao:
  - summary-only gera notas.
  - follow-up solicita tambem a extracao de proximas acoes/tarefas.
- Cobrir o comportamento com testes focados de transcription provider e summary prompt.

## Impact

- Affected specs:
  - `meetings`
- Affected code:
  - `packages/shared/src/protocol/dto.ts`
  - `apps/electron/src/main/meetings/meeting-service.ts`
  - `apps/electron/src/main/meetings/meeting-summary-service.ts`
  - testes focados em Meetings

## Non-goals

- Nao criar tarefas no sistema de sessoes automaticamente; o follow-up entra como secao estruturada no Markdown da reuniao.
- Nao adicionar Groq ou qualquer outro provedor de STT alem de Deepgram.
- Nao migrar dados antigos de Meetings.
- Nao mexer em sync upstream, release workflow ou worktrees de agentes.
