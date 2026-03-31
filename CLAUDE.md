# Claude Code GUI

A Windows-only Tauri 2 desktop app for selecting and launching Claude Code Agent SDK sessions in a tabbed interface.

## Quick Start

- Development: `cargo tauri dev` (or `dev.bat`)
- Build: `cargo tauri build`
- DevTools: `cargo tauri dev --features devtools`
- Frontend dir: `cd app && npm install`
- Tests: `cd app && npm test` (vitest + testing-library)

## Tech Stack

- **Frontend**: React 19 + TypeScript 5 + Vite 6 + React Compiler (in `app/`)
- **Backend**: Rust + Tauri 2 (in `app/src-tauri/`)
- **Sidecar**: Node.js process running Agent SDK, bridged via JSON-RPC (in `sidecar/`)
- **Terminal**: xterm.js (`@xterm/xterm`) with WebGL, search, unicode11, and fit addons — renders agent output via a virtual document model in `InputManager` + `TerminalRenderer`
- **Chat UI**: React chat interface with react-markdown, react-syntax-highlighter, remark-gfm for rendering structured agent messages
- **Themes**: 30 themes (dark + light variants, Catppuccin Mocha default), selectable via Ctrl+, settings

## Key Paths

- `app/src/components/` - TabBar, TabSidebar, TitleBar, AgentView, ProjectList, InfoStrip, SessionConfig, NewTabPage, AboutPage, UsagePage, SystemPromptPage, SettingsPage, SessionBrowser, SessionPanel, TranscriptView, Modal, ErrorBoundary, AsciiLogo, FolderTree, SegmentedControl, ShortcutsOverlay, OnboardingOverlay, Icons, GsdPrimitives, XTermView
- `app/src/components/chat/` - ChatInput, MessageBubble, ToolCard, PermissionCard, ErrorCard, AskQuestionCard, ThinkingBlock, ThinkingPanel, ResultBar, RightSidebar, MinimapPanel, BookmarkPanel, TodoPanel, AgentTreePanel, ToolGroup, DiffView, AttachmentChip, CommandMenu, MentionMenu
- `app/src/components/modals/` - CreateProjectModal, LabelProjectModal, QuickLaunchModal
- `app/src/components/terminal/` - TerminalDocument, TerminalRenderer, InputManager, AnsiUtils, TermToolLine, blocks/, themes
- `app/src/hooks/` - useTabManager, useProjects, useAgentSession, useSessionController, useBufferedText, useAgentTasks
- `app/src/utils/sanitizeInput.ts` - Input sanitization
- `app/src/contexts/ProjectsContext.tsx` - Shared project state
- `app/src/contexts/ThemesContext.tsx` - Runtime theme loading
- `app/src/themes.ts` - Theme application to CSS variables
- `app/src/types.ts` - Type definitions, model/effort/sort/theme constants, AgentEvent types
- `app/src-tauri/src/` - Rust backend: main.rs, sidecar.rs, projects.rs, commands.rs, prompts.rs, usage_stats.rs, marketplace.rs, autocomplete.rs, logging.rs, watcher.rs, paths.rs, themes.rs
- `sidecar/sidecar.js` - Node.js process running Agent SDK, communicates with Rust via JSON-lines

For detailed architecture, IPC protocol, and development guide, see `docs/TECHNICAL.md`.

## Tool

- Claude Code (Agent SDK via Node.js sidecar process)

## Models (Tab to cycle)

sonnet / opus / haiku / sonnet [1M] / opus [1M]

## Keyboard Shortcuts

### Global (App.tsx)
- **Ctrl+T**: New tab
- **Ctrl+F4**: Close tab
- **Ctrl+Tab / Ctrl+Shift+Tab**: Next/previous tab
- **Ctrl+1-9**: Switch to tab by number
- **Ctrl+,**: Open settings (themes, font, directories, behavior)
- **F1**: Toggle keyboard shortcuts overlay
- **F12**: Toggle about tab
- **Ctrl+U**: Toggle usage/stats tab
- **Ctrl+Shift+P**: Toggle system prompts tab
- **Ctrl+Shift+H**: Toggle sessions browser tab
- **Ctrl+Shift+S**: Toggle session panel

### Project Picker (NewTabPage active, no modal open)
- **Tab**: Cycle permission mode (plan/accept edits/skip all)
- **F2**: Cycle effort level (high/medium/low/max)
- **F3**: Cycle sort order (alpha/last used/most used)
- **F4**: Cycle model
- **F5**: Create new project
- **F6**: Open project in Explorer
- **F8**: Label selected project
- **F10**: Quick launch (arbitrary directory)
- **Enter**: Launch selected project
- **Esc**: Clear filter / close tab
- **Backspace**: Delete last filter character
- **Type to filter**: Case-insensitive project search
- **Arrow keys / PageUp / PageDown / Home / End**: Navigate project list

### Agent Tab (XTermView.tsx / InputManager.ts)
- **Ctrl+C**: Clear input buffer (or send interrupt if buffer empty)
- **Ctrl+B**: Toggle right sidebar

## Design Tokens

CSS custom properties in `App.css` `:root`:
- Colors: `--bg`, `--surface`, `--mantle`, `--crust`, `--text`, `--text-dim`, `--overlay0`, `--overlay1`, `--accent`, `--red`, `--green`, `--yellow`, `--user-msg-bg`, `--user-msg-border`
- Spacing: `--space-0` (2px) through `--space-12` (48px)
- Typography: `--text-2xs` (11px), `--text-xs` (12px), `--text-sm` (13px), `--text-base` (14px), `--text-md` (16px), `--text-lg` (17px), `--text-xl` (19px)
- Radii: `--radius-sm` (4px), `--radius-md` (6px), `--radius-lg` (6px), `--floating-radius` (10px)
- Overlays: `--hover-overlay`, `--hover-overlay-subtle`, `--backdrop`
- Z-index: `--z-resize`, `--z-modal`
- Layout: `--tab-height`, `--info-strip-height`, `--title-bar-height`, `--sidebar-width`, `--sidebar-min-width`, `--sidebar-max-width`, `--session-panel-width`, `--right-sidebar-width`, `--sidebar-handle-width`, `--padding-container`
- Shadows: `--shadow-modal`
- Font: `--font-mono` (set in `:root`); `--font-chat`, `--text-chat` (set dynamically by themes.ts when theme has uiFont/uiFontSize)

## Architecture Notes

### Rust Backend (sidecar.rs)
- JSON-RPC bridge to Node.js sidecar running @anthropic-ai/claude-agent-sdk. Commands/events flow as JSON-lines over stdin/stdout.
- Win32 Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) ensures the entire sidecar process tree is killed on app close — not just the direct `node.exe`.
- `autocomplete.rs` handles file-path completion. SDK-based autocomplete uses `@anthropic-ai/sdk` directly in `sidecar/sidecar.js` with OAuth fallback from `~/.claude/.credentials.json`.

### React Frontend
- React Compiler (`babel-plugin-react-compiler`) is enabled via Vite — provides automatic memoization.
- Most components also use explicit `React.memo` for re-render control.
- `hasNewOutput` updates are guarded — the tab array is only recreated once per new-output burst, not on every chunk.
- Singleton pages (AboutPage, UsagePage, SystemPromptPage, SettingsPage, SessionBrowser, SessionPanel, TranscriptView) are lazy-loaded via `React.lazy()`.
- MinimapPanel uses DOM-based rendering with `<div>` elements and CSS variable colors.

### CSS Architecture
- All colors use `color-mix()` with CSS variables for theme adaptability — no hardcoded rgba values.
- Font family inherits from `--font-mono` on `html, body`. Component-level declarations removed.
- Modals have enter animations (backdrop fade + slide-up). Buttons have `:active` pressed states.
- `will-change` is never used statically — the browser handles compositing for transitions.

## Constraints

- Windows-only. Do not add cross-platform abstractions unless asked.
- Agent sessions are killed on tab close via the Win32 Job Object and sidecar lifecycle management.
- Hidden directories (starting with `.`) are excluded from project scanning.
- Default project directory is `D:\Projects`, overridable via settings (multiple directories supported).
- Environment variable `CLAUDE_CODE_GUI_PROJECTS_DIR` overrides the default project directory.

## ASCII Logo

- Generated from `icon.png` using https://convertico.com/image-to-ascii/ (30x15)
- Rendered via `AsciiLogo.tsx` component with ANSI RGB color codes
- Displayed on the About page

## Conventions

- Commit messages use conventional commits: `feat:`, `fix:`, `style:`, `perf:`, `docs:`, `refactor:`
- No linter/formatter configured - follow existing code style
- Tests: vitest + @testing-library/react (run `npm test` or `npm run test:watch`)
- CSS: Use `color-mix(in srgb, var(--token) N%, transparent)` for opacity variants, never hardcoded rgba
- CSS: Do not add `will-change` statically — only add dynamically if profiling shows jank
- CSS: Do not add component-level `font-family` — let elements inherit from body
