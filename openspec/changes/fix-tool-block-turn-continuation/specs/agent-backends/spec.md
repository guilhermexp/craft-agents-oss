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
