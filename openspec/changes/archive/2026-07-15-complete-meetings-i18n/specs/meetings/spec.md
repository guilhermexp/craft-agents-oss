## ADDED Requirements

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
