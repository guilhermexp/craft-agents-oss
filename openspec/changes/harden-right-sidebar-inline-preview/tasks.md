## 1. Contrato

- [x] 1.1 Registrar proposta, escopo e delta da capability.
- [x] 1.2 Validar o change com `openspec validate --strict`.

## 2. Regressões automatizadas

- [x] 2.1 Cobrir largura mínima do split e reclamp após viewport menor.
- [x] 2.2 Cobrir roteamento inline apenas para tipos implementados.
- [x] 2.3 Cobrir reset de loading e invalidação do preview por sessão.
- [x] 2.4 Cobrir handlers de links Markdown e paridade i18n.

## 3. Implementação

- [x] 3.1 Corrigir layout, resize e estado do preview na sidebar.
- [x] 3.2 Corrigir roteamento de arquivos e ciclo de loading.
- [x] 3.3 Substituir barrel import e strings hardcoded.

## 4. Validação

- [x] 4.1 Testes focados e typecheck do Electron verdes.
- [x] 4.2 Lint e `validate:ci` verdes.
- [x] 4.3 Smoke real no Electron confirma split, troca de arquivo e resize.
- [x] 4.4 DOX pass confirma que não há documentação local stale.
