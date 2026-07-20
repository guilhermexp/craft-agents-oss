## 1. Reconciliar contratos do merge

- [x] 1.1 Reconciliar session-tools-core e validação Mermaid sem mudar o contrato público v1
- [x] 1.2 Reconciliar drivers/modelos Claude e Pi preservando isolamento Hermes e computer-use Pi-only
- [x] 1.3 Reconciliar exports RTK, storage, RPC e limites de contexto sem remover hardening local
- [x] 1.4 Eliminar registros RPC duplicados de RTK e cobrir o registro completo de canais
- [x] 1.5 Revalidar e corrigir os 20 findings do review pré-push do renderer sem remover comportamentos locais

## 2. Validar

- [x] 2.1 Rodar testes/typechecks focados para cada lote alterado
- [x] 2.2 `bun run validate:ci` passa
- [x] 2.3 `bun run electron:build` passa
- [x] 2.4 `openspec validate reconcile-upstream-v0-11-1 --strict --no-interactive` passa
- [x] 2.5 React Doctor no diff do renderer passa sem issues
