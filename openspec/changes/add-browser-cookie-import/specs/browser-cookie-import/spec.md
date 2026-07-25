## ADDED Requirements

### Requirement: Local Chrome cookies can be read and decrypted
The system SHALL read cookies from the local Chrome/Chromium cookie store on macOS and decrypt them
using the `Chrome Safe Storage` Keychain password, exposing them through a platform-agnostic
interface that has no Electron dependency. Individual rows that fail to decrypt SHALL be counted as
skipped rather than aborting the read.

#### Scenario: Cookies are decrypted for a requested domain
- **WHEN** the reader is asked for cookies for `example.com`
- **THEN** it returns decrypted cookies whose `host_key` is `example.com` or `.example.com`
- **AND** it does not return cookies belonging to other hosts

#### Scenario: Recent-Chrome domain-hash prefix is stripped
- **WHEN** a decrypted cookie plaintext carries the 32-byte domain-hash prefix written by recent
  Chrome builds
- **THEN** the returned cookie value has the prefix removed and equals the original cookie value

#### Scenario: Chrome timestamps are converted
- **WHEN** a cookie row carries `expires_utc` in microseconds since 1601-01-01
- **THEN** the returned expiration is the equivalent Unix seconds value
- **AND** a row with `expires_utc = 0` is reported as a session cookie

#### Scenario: A corrupt row does not fail the import
- **WHEN** one cookie row among several cannot be decrypted
- **THEN** the reader returns the successfully decrypted cookies and reports the number skipped
- **AND** it does not throw

#### Scenario: Unsupported platform is explicit
- **WHEN** the reader runs on a platform other than macOS
- **THEN** it raises an explicit unsupported-platform error rather than returning an empty result

### Requirement: A browser profile can be marked user-only
The system SHALL support marking a browser profile as user-only, and agent-driven browser
resolution SHALL never obtain a session for a user-only profile. The refusal SHALL be an error; the
system MUST NOT silently fall back to the default profile.

#### Scenario: Agent request to a user-only profile is refused
- **WHEN** an agent-owned browser instance request resolves to a user-only profile
- **THEN** the request is refused with a typed error
- **AND** no browser instance is created for that profile

#### Scenario: Refusal never degrades to the default profile
- **WHEN** an agent-owned request is refused for a user-only profile
- **THEN** the system does not create or return an instance on the default profile in its place

#### Scenario: User-driven access to a user-only profile succeeds
- **WHEN** a user-owned request targets a user-only profile
- **THEN** the instance is created normally

#### Scenario: User-only profiles are partition-isolated
- **WHEN** the partition string is resolved for a user-only profile
- **THEN** it differs from the agent's default `persist:browser-pane` partition

### Requirement: Decrypted cookies can be injected into a browser partition
The system SHALL write decrypted cookies into the Chromium cookie store of the resolved partition,
honoring the user-only capability check before any write. Imported cookies SHALL NOT be routed
through `CredentialManager`, and cookie values SHALL NOT appear in return values, logs, or UI.

#### Scenario: Cookies become active in the target partition
- **WHEN** cookies are imported for a profile
- **THEN** each cookie is written to that profile's partition cookie store with its domain, path,
  secure, httpOnly, expiration, and sameSite attributes preserved
- **AND** the embedded browser for that profile is authenticated for the corresponding sites

#### Scenario: Chrome sameSite values are mapped
- **WHEN** a cookie carries Chrome's integer `samesite` value of `-1`, `0`, `1`, or `2`
- **THEN** it is written with `unspecified`, `no_restriction`, `lax`, or `strict` respectively

#### Scenario: Agent-intent import into a user-only profile writes nothing
- **WHEN** an agent-intent import targets a user-only profile
- **THEN** the import is refused and no cookie is written to any partition

#### Scenario: Import results carry counts, not values
- **WHEN** an import completes
- **THEN** the result reports the number imported and skipped
- **AND** the result contains no cookie names or values

### Requirement: The user can bulk-import Chrome cookies into a user-only profile
The system SHALL provide an explicit user action that imports cookies from the local Chrome profile
into a user-only browser profile, after a confirmation that names what will be read and which
profile will receive the cookies.

#### Scenario: Bulk import populates the user-only profile
- **WHEN** the user confirms "Import from Chrome" for a user-only profile
- **THEN** cookies from the local Chrome profile are imported into that profile's partition
- **AND** the user is shown how many cookies were imported and skipped

#### Scenario: Confirmation states the security posture
- **WHEN** the confirmation is displayed
- **THEN** it states that a macOS Keychain prompt will appear
- **AND** it states that the agent cannot drive the receiving profile

### Requirement: The agent can import a single domain ephemerally
The system SHALL expose an `import_cookies` session tool that imports cookies for exactly one
requested domain into the agent's own session profile. The tool SHALL be registered with
`executionMode: 'backend'` and `safeMode: 'block'`, SHALL NOT accept a target profile from the
model, and its imports SHALL NOT persist beyond the session.

#### Scenario: Agent imports one domain into its own profile
- **WHEN** the agent calls `import_cookies` with a permitted domain
- **THEN** cookies for that domain only are imported into the session's own browser profile
- **AND** the tool result reports counts without any cookie names or values

#### Scenario: The model cannot choose a target profile
- **WHEN** the agent invokes `import_cookies`
- **THEN** the target profile is resolved from the session, and the tool accepts no profile
  parameter from the model

#### Scenario: Denylisted and device-bound domains are refused
- **WHEN** the agent requests a denylisted domain such as `accounts.google.com`
- **THEN** the request is refused before the cookie store is read
- **AND** the refusal names the reason and points to the user-only profile as the alternative

#### Scenario: Agent-imported cookies do not survive the session
- **WHEN** a session that imported cookies ends
- **THEN** the cookies imported by that session are removed from the partition
- **AND** cookies tracked from a previously crashed session are cleared at startup

#### Scenario: Tool posture is enforced at registration
- **WHEN** the session tool registry is inspected
- **THEN** `import_cookies` is registered with `executionMode: 'backend'` and `safeMode: 'block'`
