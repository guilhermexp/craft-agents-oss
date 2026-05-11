# audio-preview-and-markdown Specification

## Purpose
Renderizar conteúdo rich no chat: overlay de áudio com transcript sincronizado, overlay HTML com sanitização (sem `<script>`/inline JS), markdown via Shiki com linkify de URLs e file paths em code blocks resolvidos contra o workspace, e classificação de arquivo para rotear cada anexo ao overlay correto.
## Requirements
### Requirement: Audio preview renders player with synchronized transcript
The system SHALL render audio previews with an audio player, play/pause control, scrub bar, and transcript view synchronized to the current audio position.

#### Scenario: Audio preview opens
- **WHEN** a previewable audio file is opened in the audio preview overlay
- **THEN** the system renders the audio player controls and transcript viewer for that file

#### Scenario: Audio time changes
- **WHEN** the current audio time changes during playback or scrubbing
- **THEN** the transcript viewer highlights the segment whose timestamp contains the current time

### Requirement: HTML preview sanitizes before rendering
The system SHALL sanitize HTML preview content before rendering it in the preview iframe, and MUST prevent script execution and inline JavaScript execution in the preview surface.

#### Scenario: HTML contains script tags
- **WHEN** HTML preview content includes `<script>` tags
- **THEN** the system removes those tags before assigning the content to the iframe `srcDoc`

#### Scenario: HTML preview renders
- **WHEN** sanitized HTML content is rendered
- **THEN** the iframe is sandboxed without script execution permissions

### Requirement: Markdown linkifies URLs and file paths in code blocks
The system SHALL convert detected URLs and file paths inside Markdown code blocks into clickable links when URL or file callbacks are available.

#### Scenario: Code block contains URL
- **WHEN** a Markdown code block contains a URL
- **THEN** the rendered code block exposes that URL as a clickable link that calls the URL handler

#### Scenario: Code block contains file path
- **WHEN** a Markdown code block contains a recognized file path
- **THEN** the rendered code block exposes that path as a clickable link that calls the file handler

### Requirement: File paths resolve against workspace context
The system SHALL resolve agent-emitted relative file names against the active folder or workspace context before Markdown linkification when a folder context marker is present.

#### Scenario: Folder marker precedes basename list
- **WHEN** Markdown contains an absolute `Pasta:`, `Folder:`, `Directory:`, or `Diretório:` marker followed by bullet-list file basenames
- **THEN** the system rewrites those basenames into Markdown links targeting the corresponding absolute paths

#### Scenario: File item is already linked or inside code fence
- **WHEN** a basename is already a Markdown link or appears inside a fenced code block
- **THEN** the system leaves that item unchanged

### Requirement: Code blocks use Shiki theme
The system SHALL render Markdown code blocks with Shiki syntax highlighting using the current app Shiki theme when no linkified code fallback is required.

#### Scenario: Highlightable code block renders
- **WHEN** a Markdown code block uses a supported language and does not require linkified fallback rendering
- **THEN** the system highlights the code with Shiki using the app theme

#### Scenario: Highlighting fails or language is unsupported
- **WHEN** Shiki cannot highlight the code block
- **THEN** the system falls back to readable plain monospace code rendering

### Requirement: Transcript viewer seeks by segment click
The transcript viewer SHALL allow the user to click a transcript segment to seek the audio to that segment timestamp.

#### Scenario: User clicks transcript segment
- **WHEN** the user clicks a transcript word or segment
- **THEN** the audio current time changes to that segment start timestamp

### Requirement: File classification routes previews
The system SHALL classify file paths by extension into preview types such as audio, image, code, markdown, JSON, text, PDF, and Excalidraw, and SHALL use that classification to route recognized files to the correct in-app preview surface.

#### Scenario: Audio file is classified
- **WHEN** a file path has a supported audio extension
- **THEN** the system classifies it as `audio` and marks it previewable

#### Scenario: Unsupported file is classified
- **WHEN** a file path has no supported preview extension
- **THEN** the system returns no preview type and marks it not previewable

### Requirement: HTML sanitizer is covered by tests
The HTML preview sanitizer MUST be covered by tests that verify script removal and base target injection for preview rendering.

#### Scenario: Sanitizer test runs
- **WHEN** the sanitizer test processes HTML containing scripts
- **THEN** the result contains no script tags and includes the preview base target

