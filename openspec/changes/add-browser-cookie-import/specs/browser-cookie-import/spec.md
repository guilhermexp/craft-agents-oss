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

### Requirement: Sensitive hosts are withheld before decryption
The system SHALL maintain a configurable denylist of sensitive hosts and SHALL drop a matching row
before its value is decrypted. A withheld row SHALL be reported separately from a row that failed
to decrypt. Matching is exact per host, so the default SHALL name every host that carries the same
Google account session — the account, mail, docs, drive, account-settings, API and YouTube hosts,
including their `www` forms — rather than relying on a domain-suffix rule. A caller-supplied
denylist SHALL replace the default, except that an empty list SHALL fall back to the default so the
protection cannot be disabled by omission.

#### Scenario: A denylisted host is never decrypted
- **WHEN** the cookie store contains a row whose host is on the denylist
- **THEN** the row is excluded before decryption is attempted
- **AND** it is reported as withheld rather than as skipped

#### Scenario: The dotted form of a denylisted host is also withheld
- **WHEN** a row's host is the dot-prefixed form of a denylisted host
- **THEN** it is withheld on the same basis as the bare host

#### Scenario: A sibling host carrying the same Google session is withheld
- **WHEN** the cookie store contains account cookies on a Google session host other than the
  account host — such as `.youtube.com`, `www.google.com`, `drive.google.com` or `googleapis.com`
- **THEN** each of those rows is withheld before decryption
- **AND** none of their values is decrypted

#### Scenario: A caller-supplied denylist replaces the default
- **WHEN** a caller provides its own non-empty denylist
- **THEN** only the hosts it names are withheld

#### Scenario: An empty caller denylist does not disable the protection
- **WHEN** a caller provides an empty denylist
- **THEN** the default denylist is applied
- **AND** the default sensitive hosts are still withheld

### Requirement: The import confirmation states what will be imported
The system SHALL count the cookies and distinct hosts an import would carry, and the cookies and
hosts the denylist withholds, before asking the user to confirm. The counting pass SHALL NOT
decrypt any value and SHALL NOT require the Keychain password.

#### Scenario: The user sees counts before confirming
- **WHEN** the user starts "Import from Chrome"
- **THEN** the confirmation states how many cookies and how many distinct hosts will be imported
- **AND** it states how many cookies were withheld by the denylist

#### Scenario: Counting does not touch the Keychain
- **WHEN** the counting pass runs
- **THEN** no cookie value is decrypted
- **AND** no Keychain password is requested

### Requirement: The import runs only on the local machine
The system SHALL classify the cookie import and preview channels as local-only, so they are never
proxied to a remote workspace host.

#### Scenario: Cookie channels are not remote-eligible
- **WHEN** the channel routing table is inspected
- **THEN** the cookie import and preview channels are local-only
- **AND** they are not remote-eligible

### Requirement: A failed import names its reason
The system SHALL report a refused or failed import as a distinct reason code — an unsupported
platform, an invalid profile name, a missing cookie database, a failed Keychain read, an
unreadable cookie database, or a profile that is not user-only — and SHALL log only that code.

#### Scenario: Distinct failures produce distinct messages
- **WHEN** the Keychain read fails and, separately, the target profile is not user-only
- **THEN** each failure surfaces its own message rather than one shared opaque string

#### Scenario: Failure details do not leak
- **WHEN** an import fails
- **THEN** the log line contains the reason code
- **AND** it contains neither the underlying error text nor any host or cookie name

### Requirement: Cookie material does not outlive the read
The system SHALL wipe the derived decryption key once a read completes, and SHALL remove the
temporary copy of the cookie database. Copies stranded by a process that terminated before its
cleanup ran SHALL be removed on the next start.

#### Scenario: The decryption key is zeroed
- **WHEN** a read completes, successfully or not
- **THEN** the derived key buffer is zeroed

#### Scenario: Stranded temporary copies are swept
- **WHEN** the application starts and a previous run left a cookie database copy behind
- **THEN** the stale copy is removed
- **AND** a copy belonging to a read still in flight is left alone

### Requirement: A Chrome profile name cannot escape the browser directory
The system SHALL reject a Chrome profile name that is not a plain directory name, and SHALL
confirm that the database path it derives from that name stays inside the browser's
application-support directory. This control applies to name-derived location only: an explicitly
supplied `cookieDbPath` is a test seam that replaces location altogether, so it is neither
pattern-checked nor confined, and it SHALL NOT be reachable from a user- or agent-facing surface.

#### Scenario: A traversing profile name is refused
- **WHEN** the requested Chrome profile name contains path separators or parent references
- **THEN** the read is refused with an invalid-profile error before any file is opened

#### Scenario: Real Chrome profile names are accepted
- **WHEN** the requested profile is a name Chrome creates, such as `Default` or `Profile 1`
- **THEN** the name check accepts it

#### Scenario: The database-path seam is not exposed
- **WHEN** the cookie import and preview surfaces reachable by a user or an agent are inspected
- **THEN** none of them lets a caller choose the cookie database path
- **AND** the path is always derived from the browser and profile name
