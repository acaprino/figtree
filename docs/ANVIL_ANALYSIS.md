# Anvil -- Competitive Intelligence Report

**App**: Anvil -- AI Code Session Launcher
**Platform**: Windows (Tauri 2 desktop application)
**Version**: Development build
**Analysis Date**: 2026-03-18
**Analysis Method**: Static source code analysis (full codebase)

---

## 1. Executive Summary

Anvil is a Windows-only Tauri 2 desktop application that provides a tabbed interface for launching and managing Claude Code Agent SDK sessions. It serves as a local project manager and AI coding assistant launcher, similar to an IDE's project picker merged with a terminal-based AI chat interface.

**Key differentiators**:
- Native desktop performance via Rust + Tauri 2 (not Electron)
- Dual view modes: Terminal (xterm) and Chat (React markdown)
- 14-theme design system with retro/cyberpunk aesthetics
- Keyboard-first design with 40+ shortcuts
- Session resume/fork capabilities
- Plugin marketplace via bundled skills

---

## 2. Visual Design

### 2.1 Color System

The app uses a **12-token semantic color system** applied via CSS custom properties:

| Token | Default (Catppuccin-inspired) | Purpose |
|-------|------|---------|
| `--bg` | `#1e1e2e` | Base background |
| `--surface` | `#313244` | Elevated surfaces, cards |
| `--mantle` | `#181825` | Slightly darker than bg |
| `--crust` | `#11111b` | Deepest level (code blocks, bottom bar) |
| `--text` | `#cdd6f4` | Primary text |
| `--text-dim` | `#6c7086` | Secondary/muted text |
| `--overlay0` | `#6c7086` | Borders, dividers |
| `--overlay1` | `#7f849c` | Hover states |
| `--accent` | `#89b4fa` | Primary action color |
| `--red` | `#f38ba8` | Error, destructive |
| `--green` | `#a6e3a1` | Success, allowed |
| `--yellow` | `#f9e2af` | Warning, pending |

**Opacity variants** use `color-mix(in srgb, var(--token) N%, transparent)` exclusively -- no hardcoded rgba values. This is a notable CSS architecture decision that ensures all colors adapt automatically to any theme.

### 2.2 Typography

**Dual-font system**:
- **Terminal font** (`--font-mono`): Cascadia Code, JetBrains Mono, Fira Code, Consolas, monospace
- **Chat/UI font** (`--font-chat`): Segoe UI, Inter, system-ui, sans-serif
- Both are user-configurable via Settings with live preview

**Type scale** (derived from base 14px):
| Token | Size | Usage |
|-------|------|-------|
| `--text-2xs` | 11px | Smallest UI labels |
| `--text-xs` | 12px | Tool status, code blocks |
| `--text-sm` | 13px | Secondary labels, tool names |
| `--text-base` | 14px | Body text (configurable) |
| `--text-md` | 15px | Slightly emphasized |
| `--text-lg` | 16px | Modal titles |
| `--text-xl` | 18px | Page headers |

### 2.3 Spacing System

4px-based spacing scale with named tokens:
- `--space-0`: 2px
- `--space-1`: 4px
- `--space-2`: 8px
- `--space-3`: 12px
- `--space-4`: 16px
- `--space-6`: 24px
- `--space-8`: 32px
- `--space-12`: 48px

### 2.4 Component Styling

**Border radius**: `--radius-sm` (4px), `--radius-md` (6px) -- minimal rounding
**Retro mode**: Both radii set to 0px, all transitions disabled, 2px borders
**Shadows**: Single `--shadow-modal` token: `0 8px 32px color-mix(in srgb, var(--crust) 80%, transparent)`
**Hover states**: `--hover-overlay` (10% text color), `--hover-overlay-subtle` (5%)
**Active states**: `transform: scale(0.97)` pressed effect on buttons
**Focus states**: `outline: 2px solid var(--accent); outline-offset: 2px`

### 2.5 Themes (14 total)

**Dark themes (10)**:
1. Anvil [retro] -- Warm earth tones, Consolas font, retro aesthetic
2. Anvil Forge [retro] -- Similar retro style, different palette
3. Dracula -- Purple accent (#bd93f9), Fira Code
4. Tokyo Night -- Blue-tinted dark, JetBrains Mono at 13px
5. Nord -- Cool blue palette
6. Kanagawa -- Japanese-inspired warm palette
7. Synthwave -- Neon pink/cyan palette
8. Matrix [retro] -- Green-on-black (#00ff41), CRT terminal aesthetic
9. Cyberpunk 2077 -- Neon-futuristic palette
10. Lofi -- Muted, low-contrast dark

**Light themes (4)**:
11. Paper -- Warm beige (#f5f2ed), burnt orange accent
12. Arctic -- Cool blue-white
13. Sakura -- Pink-tinted light
14. Solarized Light -- Classic Solarized adaptation

**Retro mode** (Anvil, Anvil Forge, Matrix): Disables all transitions, removes border-radius, uses 2px borders, forces monospace font everywhere, adds CRT-like text-shadow and blinking cursor effects.

---

## 3. UX Patterns

### 3.1 Navigation Model

**Primary navigation**: Tabbed interface (horizontal or vertical sidebar)
- Tab types: `new-tab` | `agent` | `about` | `usage` | `system-prompt` | `sessions`
- Singleton tabs: About, Usage, System Prompts, Sessions (toggle on/off via shortcuts)
- Agent tabs: Multiple concurrent sessions

**Tab bar elements**:
- Tab list with close buttons, exit status indicators, new-output glow
- `+` New Tab button
- Action icons (Sessions, Usage, About)
- Window controls (Minimize, Maximize, Close) -- frameless window

**Secondary navigation**: Session Panel (slide-in right panel, context-scoped)

### 3.2 Information Architecture

```
App Root
  +-- Tab Bar / Tab Sidebar (persistent)
  |   +-- New Tab (Project Picker) [default]
  |   +-- Agent Session (per project) [multiple]
  |   +-- About [singleton toggle]
  |   +-- Usage [singleton toggle]
  |   +-- System Prompts [singleton toggle]
  |   +-- Sessions Browser [singleton toggle]
  +-- Session Panel (slide-in, optional)
  +-- Shortcuts Overlay (F1, modal)
```

**Depth analysis**: Max 3 clicks to any screen. Average 1.5 clicks. The deepest path is: New Tab -> System Prompts -> Edit Prompt.

### 3.3 Keyboard-First Design

This is the defining UX characteristic. The app has **40+ keyboard shortcuts** organized by context:

- **Global**: Tab management (Ctrl+T/F4/Tab/1-9), singleton toggles (F12, Ctrl+U, Ctrl+Shift+P/H/S)
- **Project Picker**: Cycling settings (Tab/F2/F3/F4), actions (F5/F6/F8/F10), type-to-filter
- **Agent Session**: Input (Enter/Shift+Enter), permissions (Y/N/A), interrupts (Ctrl+C), sidebar (Ctrl+B)
- **Sessions**: Navigate (arrows), Resume (R), Fork (F), View (Enter)

The type-to-filter pattern (no explicit search field -- just start typing) is used in both the project picker and session browser.

### 3.4 Form Design

**Modal pattern** (Radix Dialog):
- Slide-up entrance animation (translateY + scale)
- Backdrop with fade-in
- Focus trap, Esc to close
- Centered, max-width 600px, max-height 80vh

**Input styling**: Surface background, overlay0 border, accent focus ring with 2px box-shadow
**Validation**: Inline error messages below forms (`.modal-error` in red)
**Progressive disclosure**: Settings split into collapsible sections (Appearance, Terminal Font, Chat Font, Directories, Behavior)

### 3.5 Loading States

- **Skeleton loading**: Animated shimmer rows with decreasing opacity (project list)
- **Text loading**: "Loading..." text in data boxes (Usage, Sessions)
- **Activity spinner**: Animated ellipsis sigil with elapsed timer (agent processing)
- **Streaming indicator**: Blinking cursor character after streaming text

### 3.6 Empty States

- **No projects**: Icon (magnifying glass) + title + hint with kbd tags
- **No sessions**: "No sessions found" text
- **No tasks**: "No running agents" / "No tasks yet" text
- **No messages**: "Starting agent..." placeholder

### 3.7 Drag & Drop

Files can be dropped onto agent sessions. The app listens for Tauri's native drag-drop events and shows a "Drop files here" overlay. Dropped files become attachment chips in the chat input.

### 3.8 Context Menus

Radix ContextMenu is used on:
- Tab items: "Save to Projects" (for temp tabs), "Close Tab"
- Session items: Resume, Fork, Resume in New Tab, Fork in New Tab

---

## 4. Design System Extraction

### 4.1 CSS Custom Properties (Design Tokens)

```css
/* Colors */
--bg, --surface, --mantle, --crust
--text, --text-dim
--overlay0, --overlay1
--accent, --red, --green, --yellow

/* Spacing (4px base) */
--space-0 (2px) through --space-12 (48px)

/* Typography */
--text-2xs through --text-xl (11px-18px)
--font-mono, --font-chat
--text-base, --text-chat

/* Layout */
--tab-height: 42px
--info-strip-height: 32px
--title-bar-height: 32px
--sidebar-width: 200px (140-360px range)
--session-panel-width: 260px
--right-sidebar-width: 220px (150-400px range)

/* Radii */
--radius-sm: 4px, --radius-md: 6px

/* Z-index */
--z-resize: 100, --z-modal: 1000

/* Effects */
--hover-overlay: color-mix(in srgb, var(--text) 10%, transparent)
--hover-overlay-subtle: color-mix(in srgb, var(--text) 5%, transparent)
--backdrop: color-mix(in srgb, var(--crust) 85%, transparent)
--shadow-modal: 0 8px 32px color-mix(in srgb, var(--crust) 80%, transparent)
```

### 4.2 Component Library

| Component | Technology | Purpose |
|-----------|------------|---------|
| Modal | Radix Dialog | Centered overlay dialogs |
| ContextMenu | Radix ContextMenu | Right-click menus |
| Switch | Radix Switch | Boolean toggles |
| Collapsible | Radix Collapsible | Tool call expansion |
| ScrollArea | Radix ScrollArea | Styled scrollbar (sidebar) |
| SegmentedControl | Custom | Multi-option pill selector |
| FolderTree | Custom | Directory browser tree |
| MessageBubble | react-markdown + remark-gfm + PrismLight | Markdown rendering |
| ChatInput | Custom | Auto-growing textarea with attachments |
| CommandMenu | Custom (Portal) | Slash command autocomplete |
| MentionMenu | Custom (Portal) | @agent autocomplete |

### 4.3 Animation Patterns

- **Modal entrance**: 0.2s ease-out, translateY(8px) + scale(0.98) -> 0
- **Tab close**: 0.15s closing animation before DOM removal
- **Theme crossfade**: 150ms ease-out on background-color, color, border-color
- **Streaming cursor**: 1s step-end blink
- **Thinking pulse**: 1.2s ease-in-out infinite scale/opacity
- **Message entrance**: @starting-style with 0.2s translateY(6px) fade-in
- **Reduced motion**: Full `prefers-reduced-motion` support, disabling all animations

---

## 5. Psychology & Engagement

### 5.1 Commitment & Consistency

- **Session persistence**: All sessions are saved and can be resumed or forked, creating a sense of ongoing investment
- **Usage tracking**: 7-day token usage stats create awareness of commitment and investment
- **Project labels**: Users can customize project names, increasing personal attachment
- **System prompts**: Users invest time in crafting prompts, deepening platform lock-in

### 5.2 Autonomy & Control

- **Permission modes**: Three levels (plan, accept edits, skip all) give users granular control over AI autonomy
- **Security gate**: Toggle for additional permission checking
- **Hide thinking**: Option to suppress AI reasoning, respecting user preferences
- **Dual view modes**: Terminal or Chat -- user picks their preferred interface

### 5.3 Power User Identity

- **Keyboard-first**: 40+ shortcuts signal "this is for pros"
- **Retro themes**: Matrix, Anvil -- appeal to hacker/developer identity
- **Terminal mode**: Raw, unformatted output for users who prefer it
- **No onboarding**: Zero hand-holding, assumes competent user

### 5.4 Feedback Loops

- **Real-time stats**: Cost ($), tokens, turns, duration in bottom bar
- **Context usage meter**: Visual bar showing how much context window is used
- **Rate limit meter**: Visual quota utilization indicator
- **Tab output indicators**: Glowing tabs when inactive tabs have new output
- **Exit status**: Checkmark/cross on completed agent tabs

### 5.5 Loss Aversion

- **Session preservation**: Sessions never disappear -- always resumable or forkable
- **Fork capability**: Risk-free experimentation (fork a session, try something, original is intact)

---

## 6. Business Model Analysis

### 6.1 Monetization Strategy

Anvil itself is a **free, open-source desktop application**. It acts as a frontend for the Anthropic Claude Code Agent SDK. Revenue flows to Anthropic via:

- **API usage**: All token consumption is billed through the user's Anthropic account
- **Model tiers**: Users can select between sonnet (cheaper), opus (premium), and haiku (budget) models
- **1M context**: Extended context variants available for sonnet and opus

### 6.2 Pricing Transparency

The app provides excellent cost visibility:
- Per-session cost tracking ($X.XXX format)
- Cumulative daily/weekly cost charts
- Per-model and per-project cost breakdowns
- Real-time context window utilization

### 6.3 Platform Lock-in

- **Session data**: All sessions stored in Claude's native format
- **System prompts**: Stored as local .md files (portable)
- **Plugin ecosystem**: Marketplace skills bundled with Anvil
- **OAuth integration**: Uses ~/.claude/.credentials.json

### 6.4 No Paywall

There is no paywall within Anvil. The app is free. Cost is purely API usage through the user's existing Anthropic subscription.

---

## 7. Technical Architecture

### 7.1 Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19 + TypeScript 5 + Vite 6 |
| Backend | Rust + Tauri 2 |
| Sidecar | Node.js (Agent SDK) via JSON-lines IPC |
| Rendering | react-markdown, PrismLight syntax highlighting |
| State | React hooks + ProjectsContext |
| Components | Radix UI primitives (Dialog, ContextMenu, Switch, Collapsible, ScrollArea) |
| Virtualization | @tanstack/react-virtual |

### 7.2 Performance Optimizations

- **React.memo** on all major components
- **Virtualized lists**: Both chat messages and project list use @tanstack/react-virtual
- **Lazy loading**: Singleton pages (About, Usage, SystemPrompt, SessionBrowser, SessionPanel) loaded via React.lazy
- **Ref-based state**: Keyboard handlers use refs to avoid useCallback dependency churn
- **Streaming optimization**: Raw text during streaming, markdown parsing only after completion
- **Theme caching**: Syntax highlighter theme built from CSS vars, cached with MutationObserver invalidation
- **Incremental minimap**: Canvas rendering with cached theme colors
- **hasNewOutput guard**: Tab array only recreated once per output burst

### 7.3 Process Management

- Win32 Job Object ensures sidecar process tree cleanup on app close
- JSON-RPC bridge over stdin/stdout between Rust and Node.js sidecar
- Agent sessions killed on tab close

---

## 8. Competitive Positioning

### 8.1 Strengths

1. **Native performance**: Tauri 2 + Rust, not Electron. Smaller binary, lower memory
2. **Keyboard-first**: Fastest workflow for power users
3. **Dual view modes**: Satisfies both terminal purists and chat-UI enthusiasts
4. **Theme variety**: 14 themes including unique retro/cyberpunk aesthetics
5. **Session management**: Resume, fork, browse history -- no work is lost
6. **Cost transparency**: Real-time per-session cost and context tracking
7. **Plugin system**: Extensible via marketplace skills
8. **Privacy**: Fully local, no telemetry visible in source

### 8.2 Weaknesses

1. **Windows-only**: No macOS or Linux support
2. **No onboarding**: Steep learning curve for new users
3. **No test framework**: Manual testing only
4. **Single AI provider**: Locked to Anthropic Claude only
5. **No collaborative features**: Single-user only
6. **No session transcript viewer**: "View session" action is a TODO

### 8.3 Opportunities

1. Cross-platform support (Tauri 2 supports macOS/Linux)
2. Multi-provider support (OpenAI, Google, local LLMs)
3. Session sharing/export
4. Project templates with pre-configured prompts
5. Inline diff viewer for code changes
6. Git integration (branch-aware sessions, commit from UI)

### 8.4 Threats

1. Claude Code CLI itself improving, reducing need for GUI wrapper
2. VS Code extensions offering similar functionality
3. Cursor and other AI-native IDEs

---

## 9. UX Recommendations

1. **Add onboarding**: A first-run tutorial or wizard showing key shortcuts and workflow
2. **Session transcript viewer**: Implement the TODO -- users want to review past conversations
3. **Search within sessions**: Full-text search across conversation history
4. **Diff viewer**: Show file changes inline when a tool modifies code
5. **Project templates**: Pre-configured system prompt + model combinations per project type
6. **Export sessions**: PDF/markdown export of conversations
7. **Status indicator**: Show connection/auth status in the UI (currently only via /status command)
8. **Undo for destructive actions**: Confirmation dialog for "delete prompt" and similar
