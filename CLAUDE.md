# Anvil

A Windows-only Tauri 2 desktop app for selecting and launching Claude Code Agent SDK sessions in a tabbed interface.

## Quick Start

- Development: `cargo tauri dev` (or `dev.bat`)
- Build: `cargo tauri build`
- DevTools: `cargo tauri dev --features devtools`
- Frontend dir: `cd app && npm install`

## Tech Stack

- **Frontend**: React 19 + TypeScript 5 + Vite 6 (in `app/`)
- **Backend**: Rust + Tauri 2 (in `app/src-tauri/`)
- **Sidecar**: Node.js process running Agent SDK, bridged via JSON-RPC (in `sidecar/`)
- **Display**: xterm.js 5.5 with WebGL renderer + canvas fallback (renders ANSI agent output)
- **Themes**: 10 dark themes (Catppuccin Mocha default), selectable via Ctrl+, settings

## Key Paths

- `app/src/components/` - TabBar, TabSidebar, TitleBar, Terminal, Minimap, BookmarkList, ProjectList, InfoStrip, SessionConfig, NewTabPage, AboutPage, UsagePage, SystemPromptPage, SessionBrowser, Modal, ErrorBoundary, AsciiLogo, FolderTree, SegmentedControl
- `app/src/hooks/` - useTabManager, useProjects, useAgentSession, useAutocomplete
- `app/src/ansiRenderer.ts` - Converts AgentEvent objects to styled ANSI text for xterm display
- `app/src/contexts/ProjectsContext.tsx` - Shared project state
- `app/src/themes.ts` - Theme application to CSS variables and xterm
- `app/src/types.ts` - Type definitions, model/effort/sort/theme constants, AgentEvent types
- `app/src-tauri/src/` - Rust backend: main.rs, sidecar.rs, projects.rs, commands.rs, prompts.rs, usage_stats.rs, marketplace.rs, autocomplete.rs, logging.rs, watcher.rs
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
- **F12**: Toggle about tab
- **Ctrl+U**: Toggle usage/stats tab
- **Ctrl+Shift+P**: Toggle system prompts tab
- **Ctrl+Shift+H**: Toggle sessions browser tab

### Project Picker (NewTabPage active, no modal open)
- **Tab**: Cycle model
- **F2**: Cycle effort level (high/medium/low)
- **F3**: Cycle sort order (alpha/last used/most used)
- **F4**: Toggle skip-permissions
- **F5**: Create new project
- **F6**: Open project in Explorer
- **F8**: Label selected project
- **F10**: Quick launch (arbitrary directory)
- **Ctrl+,**: Open settings (themes, font, directories, behavior)
- **Enter**: Launch selected project
- **Esc**: Clear filter / close tab
- **Backspace**: Delete last filter character
- **Type to filter**: Case-insensitive project search
- **Arrow keys / PageUp / PageDown / Home / End**: Navigate project list

### Agent Tab (Terminal.tsx active)
- **Ctrl+C**: Copy selection (or send interrupt if no selection)
- **Ctrl+V**: Paste (text or image path)

## Design Tokens

CSS custom properties in `App.css` `:root`:
- Colors: `--bg`, `--surface`, `--mantle`, `--crust`, `--text`, `--text-dim`, `--overlay0`, `--overlay1`, `--accent`, `--red`, `--green`, `--yellow`
- Spacing: `--space-1` (4px) through `--space-12` (48px)
- Typography: `--text-xs` (10px) through `--text-xl` (18px)
- Radii: `--radius-sm` (4px), `--radius-md` (6px)
- Overlays: `--hover-overlay`, `--hover-overlay-subtle`, `--backdrop`
- Z-index: `--z-resize`, `--z-modal`
- Layout: `--tab-height`, `--info-strip-height`, `--title-bar-height`, `--sidebar-width`, `--sidebar-min-width`, `--sidebar-max-width`
- Font: `--font-mono`

## Architecture Notes

### Rust Backend (sidecar.rs)
- JSON-RPC bridge to Node.js sidecar running @anthropic-ai/claude-agent-sdk. Commands/events flow as JSON-lines over stdin/stdout.

### React Frontend
- All components use `React.memo` for re-render control.
- Terminal callbacks use refs to avoid stale closures in high-frequency agent events.
- `hasNewOutput` updates are guarded — the tab array is only recreated once per new-output burst, not on every chunk.
- Minimap uses incremental canvas rendering with cached theme colors, separating viewport updates from full redraws.
- `safeRefresh()` preserves scroll position during terminal refreshes to prevent viewport jumping.

### CSS Architecture
- All colors use `color-mix()` with CSS variables for theme adaptability — no hardcoded rgba values.
- Font family inherits from `--font-mono` on `html, body`. Component-level declarations removed.
- Modals have enter animations (backdrop fade + slide-up). Buttons have `:active` pressed states.
- `will-change` is never used statically — the browser handles compositing for transitions.

## Constraints

- Windows-only. Do not add cross-platform abstractions unless asked.
- Agent sessions are killed on tab close via `killAgent()`.
- Hidden directories (starting with `.`) are excluded from project scanning.
- Default project directory is `D:\Projects`, overridable via settings (multiple directories supported).
- Environment variable `ANVIL_PROJECTS_DIR` overrides the default project directory.

## ASCII Logo

- The terminal startup logo is generated from `icon.png` using https://convertico.com/image-to-ascii/ (30x15)
- Hardcoded in `Terminal.tsx` as `ANSI_LOGO` constant with ANSI RGB color codes
- Replaces Claude's built-in block-char banner on startup

## Conventions

- Commit messages use conventional commits: `feat:`, `fix:`, `style:`, `perf:`, `docs:`, `refactor:`
- No linter/formatter configured - follow existing code style
- No test framework - manual testing only
- CSS: Use `color-mix(in srgb, var(--token) N%, transparent)` for opacity variants, never hardcoded rgba
- CSS: Do not add `will-change` statically — only add dynamically if profiling shows jank
- CSS: Do not add component-level `font-family` — let elements inherit from body
