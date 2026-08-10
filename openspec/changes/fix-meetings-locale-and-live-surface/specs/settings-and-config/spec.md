## ADDED Requirements

### Requirement: Idioma da UI é persistido e hidratado no processo main

O app SHALL persistir o código de idioma escolhido em Appearance → Language e
SHALL hidratar o i18n do processo main a partir dessa preferência no boot.

O handler IPC `i18n:changeLanguage` MUST gravar o código via
`setPersistedUiLanguage` além de chamar `i18n.changeLanguage`. O bootstrap do
main MUST chamar `i18n.changeLanguage(getPersistedUiLanguage())` quando houver
preferência persistida, antes de qualquer consumidor de idioma rodar.

Sem essa hidratação o i18n do main permanece em `fallbackLng: 'en'` — não há
`LanguageDetector` no main — e toda saída derivada dele sai em inglês após um
restart.

#### Scenario: Trocar o idioma persiste a escolha

- **GIVEN** o app com idioma inglês
- **WHEN** o usuário seleciona Português (Brasil) em Appearance → Language
- **THEN** `getPersistedUiLanguage()` MUST devolver `pt-BR`
- **AND** `i18n.resolvedLanguage` no processo main MUST ser `pt-BR`
Test: `apps/electron/src/main/__tests__/i18n-bootstrap.test.ts`

#### Scenario: Restart preserva o idioma no processo main

- **GIVEN** `preferences.json` com `uiLanguage: 'pt-BR'`
- **WHEN** o app reinicia e o bootstrap do main roda
- **THEN** `i18n.resolvedLanguage` no processo main MUST ser `pt-BR` sem nenhuma
  interação do usuário
Test: `apps/electron/src/main/__tests__/i18n-bootstrap.test.ts`

#### Scenario: Sem preferência persistida o main segue no fallback

- **GIVEN** `preferences.json` sem `uiLanguage`
- **WHEN** o bootstrap do main roda
- **THEN** o bootstrap MUST NOT chamar `changeLanguage`
- **AND** `i18n.resolvedLanguage` MUST permanecer `en`
Test: `apps/electron/src/main/__tests__/i18n-bootstrap.test.ts`
