---
name: Craft Agents Desktop
description: A calm, dense command surface for coordinating agents, context, and long-running work.
colors:
  scenic-canvas: "rgba(17, 19, 24, 0.55)"
  scenic-paper: "rgba(23, 26, 33, 0.62)"
  scenic-navigator: "rgba(12, 14, 18, 0.58)"
  scenic-input: "rgba(0, 0, 0, 0.35)"
  scenic-popover: "rgba(23, 26, 33, 0.82)"
  solid-popover: "#171a21"
  luminous-ink: "rgba(255, 255, 255, 0.95)"
  operational-cyan: "#5ac8f5"
  attention-sky: "#7dd3fc"
  connected-mint: "#5ce0c0"
  failure-red: "#ef4444"
  perf-muted: "#8d8d96"
  perf-warning: "#ffc857"
  perf-success: "#7ddf9a"
  browser-overlay: "rgba(2, 6, 23, 0.82)"
  shadow-indigo: "rgba(34, 33, 81, 0.25)"
  brand-violet: "#9570be"
  palette-red-400: "#f87171"
  palette-amber-400: "#fbbf24"
  palette-amber-500: "#f59e0b"
  palette-yellow-500: "#eab308"
  palette-emerald-400: "#34d399"
  palette-emerald-500: "#10b981"
  palette-green-500: "#22c55e"
  palette-blue-400: "#60a5fa"
  palette-blue-500: "#3b82f6"
  palette-indigo-500: "#6366f1"
  palette-violet-400: "#a78bfa"
  palette-purple-500: "#a855f7"
  palette-violet-500: "#8b5cf6"
  palette-pink-400: "#f472b6"
  palette-pink-500: "#ec4899"
typography:
  headline:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1
  title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.25
  label:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.25
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
  glyph-8:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.5rem"
    fontWeight: 600
    lineHeight: 1
  glyph-9:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.5625rem"
    fontWeight: 600
    lineHeight: 1
  micro:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 500
    lineHeight: 1.25
  micro-relaxed:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.65625rem"
    fontWeight: 500
    lineHeight: 1.25
  caption:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1.25
  callout:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.25
  page-title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "2.125rem"
    fontWeight: 600
    lineHeight: 1.1
  page-title-wide:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "2.625rem"
    fontWeight: 600
    lineHeight: 1.05
  body-inter:
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  2xs: "2px"
  xs: "4px"
  compact: "7px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  2xl: "22px"
  3xl: "32px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  6: "24px"
  8: "32px"
components:
  button-primary:
    backgroundColor: "{colors.luminous-ink}"
    textColor: "{colors.scenic-canvas}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-secondary:
    backgroundColor: "color-mix(in srgb, var(--foreground) 5%, transparent)"
    textColor: "{colors.luminous-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  input-default:
    backgroundColor: "transparent"
    textColor: "{colors.luminous-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "36px"
  badge-default:
    backgroundColor: "{colors.luminous-ink}"
    textColor: "{colors.scenic-canvas}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "2px 10px"
---

# Design System: Craft Agents Desktop

## Overview

**Creative North Star: "Mesa de Comando Silenciosa"**

Craft Agents behaves like a calm command desk for consequential parallel work. The interface is dense without feeling cramped: content stays dominant, chrome recedes, and controls reveal enough state to make agent activity understandable and interruptible. Precision comes from consistent geometry, compact rhythm, and semantic color rather than decoration.

The system is desktop-native in posture and web-based in implementation. It favors quiet neutral planes, small tonal steps, restrained motion, and controls that are contained and precise. It must avoid both generic SaaS-dashboard composition and the cryptic hostility of an expert-only IDE: power remains visible and accessible without turning every surface into a card, metric, icon, or ornament.

**Key Characteristics:**
- Calm, dense, and precise.
- Content-first, with low-chrome operational controls.
- Compact geometry and keyboard-friendly interaction.
- Semantic color used sparingly for state and permission.
- Vision OS scenic glass is the default theme; alternate themes remain supported.
- Custom themes may change atmosphere without changing hierarchy or behavior.

## Colors

The default palette is a dark translucent neutral field with a clear cyan accent. White alpha hierarchy carries structure; sky, mint, and red communicate attention, readiness, and failure.

### Primary
- **Operational Cyan:** The default execution accent. Use for selected emphasis, Auto mode, active controls, and high-value interactive state—not as ambient decoration.

### Secondary
- **Attention Sky:** Ask mode, informational emphasis, and states that require attention without implying failure.
- **Connected Mint:** Successful, connected, ready, and confirmed states.
- **Failure Red:** Destructive actions, errors, failed work, and irreversible-risk feedback.

### Neutral
- **Scenic Canvas:** The translucent default window field over the solid gray scenic background.
- **Scenic Paper:** AI messages, cards, and elevated content.
- **Scenic Navigator:** The darker navigation rail and sidebar material.
- **Scenic Input:** The dark inset well used for fields in scenic mode.
- **Scenic Popover:** Translucent menus and dialogs; use Solid Popover where full opacity is required.
- **Luminous Ink:** Primary text and the source for alpha-based borders, muted text, and hover fills.

The supporting palette is intentionally closed: performance diagnostics use the documented muted, warning, and success colors; user-selectable labels and playground fixtures use the documented red, amber, yellow, green, blue, indigo, violet, and pink swatches. These colors describe data or diagnostics and never replace the product accent hierarchy.

### Named Rules

**The Vision OS Default Rule.** Vision OS scenic gray is the product default. Violet is not the default brand or execution color.

**The Rare Accent Rule.** Operational Cyan identifies meaning; it does not decorate neutral content or compete with semantic status colors.

**The Tonal Structure Rule.** Prefer foreground mixed into the background at small, repeatable steps for hover, borders, muted surfaces, and separators.

## Typography

**Display Font:** System sans, with Inter as an opt-in application preference.
**Body Font:** System sans, with Inter as an opt-in application preference.
**Label/Mono Font:** JetBrains Mono with platform monospace fallbacks for code, commands, identifiers, and fixed-width technical content.

**Character:** Typography is familiar, compact, and unobtrusive. Hierarchy comes primarily from weight, contrast, and spacing; oversized display typography is not part of the operational shell.

### Hierarchy
- **Headline** (600, 18px, 1): Dialog and page-level headings that must remain compact.
- **Title** (600, 16px, 1.25): Section, panel, and prominent item titles.
- **Body** (400, 15px, 1.5): Default conversation, settings, descriptions, and operational content.
- **Label** (500, 12px, 1.25): Controls, metadata, compact chips, and secondary navigation.
- **Mono** (400, 13px, 1.5): Code, paths, commands, logs, and stable technical identifiers.
- **Micro / Caption** (8–11px): Initials, overflow counters, spinner glyphs, dense diagnostics, and secondary metadata only. Meaningful prose and standalone controls must use Label or Body.
- **Callout** (600, 20px, 1.25): A compact empty-state or instructional statement.
- **Page Title** (600, 34–42px): Reserved for the spacious Meetings overview header; never used inside navigation, dialogs, cards, or the conversation shell.

### Named Rules

**The Operational Scale Rule.** Increase weight before size. The app shell must not use marketing-scale headings to manufacture hierarchy.

**The Technical Truth Rule.** Use monospace for content whose fixed-width structure or literal identity matters, not as ambient developer styling.

## Layout

The primary spatial model is a resizable multi-panel desktop shell: navigation, session list, active content, and an optional right sidebar. Panels own their scroll and focus zones. Resize handles remain keyboard-operable, and content must survive narrow containers rather than assuming a full-window viewport.

Spacing follows a 4px base rhythm, with 8px, 12px, 16px, 24px, and 32px as the recurring steps. Default controls are 32–40px high; the canonical button and input are 36px. Compact density is intentional, but adjacent actions need clear grouping and sufficient hit areas.

Responsive behavior is container-led. Panel compact begins at 448px, panel medium at 640px, and the mobile composition at 768px. On narrow surfaces, the interface changes navigation composition rather than simply shrinking the desktop columns. Native title-bar drag regions and non-drag interactive islands are part of the desktop layout contract.

**The Panel Ownership Rule.** Every surface owns its scrolling, focus, and responsive behavior; do not introduce document-level scroll into the application shell.

**The One Workspace Rule.** Related navigation, content, previews, and contextual tools share the same shell rather than opening parallel dashboard surfaces.

## Elevation & Depth

The elevation philosophy is **camadas discretas**. The default Vision OS theme uses a solid gray scenic background beneath translucent dark chrome. Alpha layering does most of the structural work. Minimal shadows add an optical edge and ambient lift; modal and popover shadows expand only when content must separate from the workspace. Glass remains limited to non-scrolling chrome so the default material does not trade scrolling stability for visual effect.

### Shadow Vocabulary
- **Minimal:** A subtle foreground-colored ring plus two short ambient blur layers. Use for compact floating controls and bordered surfaces.
- **Minimal Flat:** The optical one-pixel ring without blur. Use when separation is needed but lift would add noise.
- **Modal Small:** A subtle ring plus progressively wider low-opacity layers. Use for dialogs, menus, and transient surfaces above the workspace.
- **Tinted:** A semantic-colored version of the minimal treatment. Use only when the tint communicates the component's state.

### Named Rules

**The Tonal-First Rule.** Surfaces are separated by small tonal shifts before shadows are considered.

**The Stable Glass Rule.** Blur belongs only on non-scrolling chrome proven not to trigger Chromium/Metal recomposition artifacts.

## Shapes

The default Vision OS system uses a broader 6–32px radius scale: 8px controls, 12px navigation, 16px groups, 22px popovers, and 32px major cards or scenic panels. Compact utility surfaces may use the 6px minimum. Borders are low-contrast white alpha strokes and should read as optical highlights rather than outlines.

**The No Accidental Pills Rule.** Reserve fully rounded shapes for avatars, status dots, and controls whose circular or capsule silhouette carries meaning.

## Components

Components are contained and precise: compact at rest, clear in state, and visually subordinate to the work they control.

### Buttons
- **Shape:** Gently curved control (8px radius), normally 36px high.
- **Primary:** Luminous Ink against the dark scenic field for neutral primary actions; Operational Cyan identifies active execution state. Use medium-weight text and 16px horizontal padding.
- **Hover / Focus:** Reduce or increase tonal contrast by one step; use a one-pixel focus ring with no offset. Disabled controls keep their geometry and drop to 50% opacity.
- **Secondary / Ghost / Outline:** Secondary uses a 5% foreground fill; ghost adds a 3% foreground fill only on hover; outline uses a 15% foreground border with a neutral background.

### Chips
- **Style:** Compact 12px labels with 2px vertical and 10px horizontal padding, a 6px radius, and either inverse neutral or 5% tonal fill.
- **State:** Selected or semantic chips may use accent/status tint; neutral metadata should not inherit semantic emphasis.

### Cards / Containers
- **Corner Style:** Mostly 6–12px, chosen by enclosure scale.
- **Background:** Base background, card, or a small derived foreground mix.
- **Shadow Strategy:** Flat or minimal by default; modal shadow only for transient top-level layers.
- **Border:** A 5–15% foreground treatment depending on interaction and contrast needs.
- **Internal Padding:** Usually 12–24px; dense list rows use smaller vertical rhythm.

### Inputs / Fields
- **Style:** Transparent or theme-surface background, 15% foreground border, 6px radius, and 12px horizontal padding at 36px height.
- **Focus:** One-pixel foreground ring at approximately 30% strength with no layout shift.
- **Error / Disabled:** Error uses the destructive semantic role; disabled preserves legibility and geometry at reduced opacity.

### Navigation

Navigation is panel-based, compact, and stateful. Default items rely on text and subdued icons; hover uses a 2–5% foreground fill, while active state adds stronger contrast or restrained accent. Mobile navigation becomes a deliberate page stack with explicit back and close actions rather than a compressed desktop sidebar.

### Dialogs and Popovers

Dialogs sit above a 50% black scrim, use the themed popover material, and animate with a short fade-and-scale transition. Content is centered, bounded to the viewport, padded by 24px, and grouped at 16px. Close controls remain visible to keyboard and assistive technology.

### Agent and Session Surfaces

Session status, permission mode, running state, failures, and background completion use semantic color plus text or icon shape; color alone must not carry the meaning. Tool output and technical payloads use restrained containers so the conversation remains the dominant reading flow.

## Do's and Don'ts

### Do:
- **Do** preserve the 4px spacing rhythm and compact 32–40px control heights.
- **Do** derive neutral surfaces from background and foreground so custom light, dark, and scenic themes remain coherent.
- **Do** use semantic color for permission, health, warning, success, and failure.
- **Do** design panel content against its container width and keyboard focus zone.
- **Do** keep agent state visible, textual, and interruptible.
- **Do** maintain accessible names, focus-visible treatments, reduced-motion behavior, and adequate pointer targets.

### Don't:
- **Don't** turn the shell into a generic SaaS dashboard made of repetitive cards, decorative KPIs, gradient headlines, or promotional chrome.
- **Don't** imitate a hostile IDE through cryptic icon-only navigation, unnecessary monospace text, or density without hierarchy.
- **Don't** introduce one-off colors when a derived neutral or semantic role already communicates the state.
- **Don't** use large shadows, blur, or glass on scrolling content.
- **Don't** use accent color as decoration or as a substitute for hierarchy.
- **Don't** create a second panel or workflow surface when the existing app shell or contextual sidebar owns the task.
