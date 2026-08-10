## ADDED Requirements

### Requirement: Tool denial keeps the Claude turn alive
The Claude backend SHALL encode every PreToolUse block as a permission denial that keeps the agent
loop running, so the model receives the reason and can correct course within the same turn. The
backend SHALL end the turn only when the dispatch result explicitly requests it.

#### Scenario: Recoverable error block keeps the turn alive
- **WHEN** the dispatcher returns a block with `isError` set (permission-mode denial, prerequisite
  block, config block) and without `endTurn`
- **THEN** the hook output carries `continue: true` with
  `hookSpecificOutput.permissionDecision === 'deny'` and the reason in `permissionDecisionReason`

#### Scenario: Control-flow block keeps the turn alive
- **WHEN** the dispatcher returns a block without `isError` and without `endTurn` — notably the
  successful mid-turn source activation that asks the user to resend
- **THEN** the hook output carries `continue: true` with
  `hookSpecificOutput.permissionDecision === 'deny'` and the literal reason in
  `permissionDecisionReason`

#### Scenario: Explicit user denial ends the turn with an explanation
- **WHEN** the dispatcher returns a block marked `endTurn` because the user denied the permission
  prompt
- **THEN** the hook output carries `continue: false`, `decision: 'block'`, the reason, and a
  `stopReason` equal to that reason

### Requirement: The [ERROR] marker survives the deny encoding
The Claude backend SHALL keep the `[ERROR] ` prefix on the text delivered to the model for blocks
marked `isError`, and SHALL NOT add it to control-flow blocks.

#### Scenario: Error block is marked for the model
- **WHEN** a block marked `isError` is encoded
- **THEN** the reason text delivered to the model starts with `[ERROR] `

#### Scenario: Successful source activation is not marked as a failure
- **WHEN** the successful mid-turn source-activation block is encoded
- **THEN** the reason text delivered to the model does not start with `[ERROR] `

### Requirement: Only explicit user denial requests turn termination
The shared PreToolUse dispatcher SHALL expose an `endTurn` flag on its `block` result and SHALL set
it only for a permission prompt the user denied.

#### Scenario: User denies the permission prompt
- **WHEN** the user answers a permission prompt with a denial
- **THEN** the dispatcher returns a `block` result with `endTurn` set

#### Scenario: Every other block leaves the turn running
- **WHEN** the dispatcher blocks for a prerequisite, a permission mode, a source activation
  (successful or failed), or a missing permission handler
- **THEN** the returned `block` result does not set `endTurn`

### Requirement: A pending steer message survives a denied tool
The Claude backend SHALL deliver a pending mid-turn user message as
`hookSpecificOutput.additionalContext` on every PreToolUse outcome that keeps the turn alive,
including a denial, and SHALL NOT consume it on the turn-ending denial so the session layer can
re-queue it.

#### Scenario: Denied tool still delivers the user's new message
- **WHEN** a tool is denied without `endTurn` while a steer message is pending
- **THEN** the hook output carries `permissionDecision: 'deny'` and the steer text in
  `hookSpecificOutput.additionalContext`, and the pending steer is consumed

#### Scenario: Turn-ending denial leaves the steer pending
- **WHEN** a tool is denied with `endTurn` while a steer message is pending
- **THEN** the hook output carries no `additionalContext` and the steer stays pending, so the turn
  emits `steer_undelivered` and the message is re-queued for the next turn

### Requirement: The prerequisite deadlock escape is per turn
The shared `PrerequisiteManager` SHALL re-arm its rejection budget at the start of every turn and
SHALL keep read state and pending skill prerequisites across that boundary. A non-strict
prerequisite SHALL NOT be released by repeated calls the model can emit inside a single turn before
the budget is exhausted, and exhausting the budget on a skill prerequisite SHALL release only the
path it was charged to.

#### Scenario: Repeated calls in the same turn do not release the tool
- **WHEN** the model calls the same blocked tool a second time in the same turn without reading the
  required file
- **THEN** the tool is blocked again

#### Scenario: A new turn re-arms the budget
- **WHEN** a turn exhausted the rejection budget for a prerequisite and a new turn starts
- **THEN** the first call of the new turn is blocked again, while files already read stay read and
  pending skill prerequisites stay pending

#### Scenario: Exhausting the skill budget releases only the charged path
- **WHEN** two skill prerequisites are pending and the budget for the charged path is exhausted
- **THEN** only that path is released and the remaining skill prerequisite still blocks the tool
