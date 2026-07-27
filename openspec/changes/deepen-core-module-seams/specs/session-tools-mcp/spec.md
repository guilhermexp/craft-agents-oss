## ADDED Requirements

### Requirement: Backend-mode tools derive their contract from the canonical catalog

Todo adapter de backend SHALL derivar descrição e schema de entrada de cada
session tool a partir da entrada `defineTool(...)` em
`packages/session-tools-core/src/tool-defs.ts`. Isso vale para o adapter do
Claude SDK, o proxy Pi, o bridge Hermes e o servidor stdio. Nenhum adapter
SHALL redeclarar descrição ou schema de um tool. O corpo de execução
específico do runtime permanece no adapter.

#### Scenario: adapter Claude reflete o contrato canônico

- **GIVEN** um tool backend-mode declarado via `defineTool`
- **WHEN** o adapter Claude constrói o wrapper do SDK
- **THEN** descrição e schema apresentados ao modelo são os do catálogo canônico

#### Scenario: divergência de schema entre adapters é impossível

- **GIVEN** os quatro consumidores do catálogo
- **WHEN** o catálogo declara um campo de entrada
- **THEN** os quatro apresentam esse campo, sem que nenhum precise de edição própria

### Requirement: A canonical-registration bypass fails the contract gate

O checker de contratos SHALL partir do conjunto de coisas ainda NÃO
registradas: todo handler exportado de `handlers/index.ts` SHALL mapear para
exatamente um nome `defineTool`, e todo nome alcançável pela listagem de cada
backend SHALL existir no catálogo canônico, nas duas direções. Um tool que
contorne `defineTool` SHALL falhar `bun run lint:tool-contracts` com uma
mensagem de bypass.

#### Scenario: handler sem entrada canônica falha o gate

- **GIVEN** um handler exportado de `handlers/index.ts`
- **WHEN** não existe entrada `defineTool` correspondente
- **THEN** `bun run lint:tool-contracts` falha indicando que o tool precisa ser registrado

#### Scenario: tool exposto só via MCP continua coberto

- **GIVEN** um tool com `exposure: 'mcp-only'` (`automation_tool`, `meeting_tool`)
- **WHEN** o gate roda
- **THEN** ele é validado pelo catálogo canônico, sem escape hatch por servidor

### Requirement: Every consumer path validates tool input and output

`executeSessionTool` SHALL resolver o tool por nome, validar a entrada contra
`inputSchema` e a saída contra `outputSchema`. O `handler` NÃO SHALL ser
alcançável fora do módulo que o declara, de modo que nenhum consumidor consiga
executar um tool sem validação.

#### Scenario: caminho Pi valida entrada e saída

- **GIVEN** uma sessão Pi executando um registry tool
- **WHEN** o tool é chamado com entrada que viola o `inputSchema`
- **THEN** a chamada falha na validação em vez de alcançar o handler

#### Scenario: handler não é alcançável de fora

- **GIVEN** um `SessionToolDef` obtido do registry
- **WHEN** um consumidor tenta invocar o handler diretamente
- **THEN** o tipo exportado não expõe o handler
