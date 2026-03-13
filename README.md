<p align="center">
  <img src="app/public/icon.png" width="120" alt="Anvil">
</p>

<h1 align="center"><a href="https://github.com/acaprino/anvil-toolset">Anvil</a></h1>

<p align="center">
  <strong>A blazing-fast terminal launcher for Claude Code & Gemini CLI</strong><br>
  <sub>Built with Tauri 2 + React 19 + xterm.js &mdash; Windows native, keyboard-first</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue?style=flat-square" alt="Version">
  <img src="https://img.shields.io/badge/platform-Windows-0078D6?style=flat-square&logo=windows" alt="Platform">
  <img src="https://img.shields.io/badge/tauri-v2-24C8D8?style=flat-square&logo=tauri" alt="Tauri 2">
  <img src="https://img.shields.io/badge/react-19-61DAFB?style=flat-square&logo=react" alt="React 19">
  <img src="https://img.shields.io/badge/rust-2021-000000?style=flat-square&logo=rust" alt="Rust">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License">
</p>

---

## What is Anvil?

Anvil is a native Windows desktop app that gives you a **tabbed terminal interface** for launching and managing [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Gemini CLI](https://github.com/google-gemini/gemini-cli) sessions against your projects. Think of it as a project-aware terminal multiplexer designed specifically for AI coding tools.

**Pick a project. Pick a model. Hit Enter. Code.**

### Why Anvil?

- **Zero friction** &mdash; Scan project directories automatically, filter by typing, launch with Enter
- **Session persistence** &mdash; Close the app, reopen it, your tabs are still there
- **Full keyboard control** &mdash; Every action has a shortcut, mouse optional
- **Native performance** &mdash; Rust backend with WebGL-accelerated terminal rendering
- **10 curated themes** &mdash; From Catppuccin Mocha to retro-styled Anvil Forge

---

## Features

### Multi-Tab Terminal Interface
- Spawn multiple concurrent AI coding sessions
- Tab output indicators show activity at a glance
- Exit code display on session completion
- Custom window chrome with drag region

### Project Discovery & Management
- Auto-scan configured directories for projects
- Git branch and dirty state indicators
- CLAUDE.md presence badges
- Custom project labels
- Sort by: alphabetical, last used, most used
- Real-time type-to-filter search
- Create new projects from the UI
- Quick launch any arbitrary directory (F10)

### AI Tool Integration
| Feature | Claude Code | Gemini CLI |
|---------|:-----------:|:----------:|
| Model selection | sonnet / opus / haiku / 1M variants | &mdash; |
| Effort levels | high / medium / low | &mdash; |
| Skip permissions | toggle | &mdash; |
| Session launch | Enter | Enter |

### Terminal Emulation
- **xterm.js v5.5** with WebGL renderer for GPU-accelerated rendering
- Real-time PTY communication via Tauri Channels
- File drag-and-drop into terminal
- Smart clipboard paste (sanitizes smart quotes, dashes, ellipsis)
- Image paste from clipboard (Ctrl+V &rarr; temp PNG)
- Dynamic font family & size configuration

### Theme Engine

10 built-in dark themes, switchable with F9:

| Theme | Accent | Style |
|-------|--------|-------|
| **Catppuccin Mocha** | `#89b4fa` blue | Default |
| **Dracula** | `#bd93f9` purple | Classic |
| **One Dark** | `#61afef` blue | Atom-inspired |
| **Nord** | `#88c0d0` frost | Arctic |
| **Solarized Dark** | `#268bd2` blue | Precision |
| **Gruvbox Dark** | `#83a598` aqua | Warm retro |
| **Tokyo Night** | `#7aa2f7` blue | Neon |
| **Monokai** | `#66d9ef` cyan | Sublime |
| **Anvil Forge** | `#e8943a` orange | Retro forge |
| **Guybrush** | `#4ac8b0` cyan | Retro adventure |

Themes apply to the entire UI: window chrome, tab bar, project list, status bar, and terminal.

### Session Management
- Sessions persist across app restarts
- Background session reaper cleans up dead processes
- Win32 Job Objects for guaranteed clean termination
- Heartbeat system for session liveness detection

---

## Keyboard Shortcuts

Anvil is designed for keyboard-first workflows. Every feature is reachable without a mouse.

### Navigation
| Key | Action |
|-----|--------|
| `Ctrl+T` | New tab |
| `Ctrl+F4` | Close tab |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+Tab` | Previous tab |
| `F12` | Toggle About page |

### Settings (New Tab Page)
| Key | Action |
|-----|--------|
| `F1` | Cycle tool (Claude / Gemini) |
| `Tab` | Cycle model |
| `F2` | Cycle effort level |
| `F3` | Cycle sort order |
| `F4` | Toggle skip-permissions |

### Actions
| Key | Action |
|-----|--------|
| `F5` | Create new project |
| `F6` | Open project in Explorer |
| `F7` | Manage project directories |
| `F8` | Label selected project |
| `F9` | Theme picker |
| `F10` | Quick launch (any directory) |
| `F11` | Font settings |
| `Enter` | Launch selected project |

### Project List Navigation
| Key | Action |
|-----|--------|
| `↑` `↓` | Navigate projects |
| `Page Up` / `Page Down` | Jump 10 items |
| `Home` / `End` | First / last project |
| Type anything | Filter projects |
| `Backspace` | Delete filter character |
| `Esc` | Clear filter / close tab |

---

## Tech Stack

```
┌─────────────────────────────────────────────┐
│  Frontend                                   │
│  React 19 · TypeScript 5.7 · Vite 6        │
│  xterm.js 5.5 · WebGL Addon                │
├─────────────────────────────────────────────┤
│  IPC Layer                                  │
│  Tauri 2 Commands · Tauri Channels (PTY)    │
├─────────────────────────────────────────────┤
│  Backend                                    │
│  Rust 2021 · Tokio · Win32 APIs             │
│  PTY Management · Session Registry          │
│  Project Scanner · Settings Persistence     │
└─────────────────────────────────────────────┘
```

### Frontend (`app/src/`)
| Module | Purpose |
|--------|---------|
| `App.tsx` | Tab orchestration, global shortcuts, resize handles |
| `Terminal.tsx` | xterm.js wrapper, PTY comms, drag-and-drop |
| `NewTabPage.tsx` | Project picker, settings, modals |
| `TabBar.tsx` | Custom tabs, window controls, output indicators |
| `ProjectList.tsx` | Scrollable project list with metadata |
| `StatusBar.tsx` | Settings display, action buttons |
| `useTabManager` | Tab lifecycle, session save/restore |
| `useProjects` | Project scanning, filtering, sorting |
| `usePty` | PTY spawn/write/resize/kill via Tauri Channel |

### Backend (`app/src-tauri/src/`)
| Module | Purpose |
|--------|---------|
| `main.rs` | App init, Tauri setup, panic handler |
| `commands.rs` | IPC command handlers |
| `pty.rs` | PTY process spawning and lifecycle |
| `session.rs` | Session registry, event streaming, reaper |
| `projects.rs` | Project scanning, settings, usage persistence |
| `tools.rs` | Tool resolution and CLI argument building |
| `logging.rs` | File-based logging |

---

## Getting Started

### Prerequisites

- **Windows 11** (or Windows 10 with WebView2)
- **Rust** toolchain (via [rustup](https://rustup.rs/))
- **Node.js** 18+ and npm
- **Claude Code** (`npm i -g @anthropic-ai/claude-code`) and/or **Gemini CLI** (`npm i -g @google/gemini-cli`)

### Development

```bash
# Clone the repository
git clone https://github.com/user/anvil.git
cd anvil/app

# Install frontend dependencies
npm install

# Run in development mode (hot-reload)
cargo tauri dev
```

### Build

```bash
# Production build (with LTO + strip)
cargo tauri build

# Or use the build scripts
./build_tauri.bat       # with rust-lld linker
./build_msvc.bat        # MSVC fallback
```

The release binary is optimized with:
- `lto = true` &mdash; Link-Time Optimization
- `codegen-units = 1` &mdash; Maximum optimization
- `opt-level = 3` &mdash; Aggressive optimization
- `strip = true` &mdash; Minimal binary size

---

## Architecture Highlights

### Performance
- **WebGL terminal rendering** &mdash; GPU-accelerated text drawing
- **Ref-based callbacks** &mdash; Terminal PTY handlers use refs to avoid stale closures and re-renders
- **React.memo on all components** &mdash; Surgical re-renders only
- **Vendor chunk splitting** &mdash; React and xterm.js in separate bundles
- **Tauri Channels for PTY data** &mdash; Zero-copy streaming, no serialization overhead

### Reliability
- **Win32 Job Objects** &mdash; Child processes are always cleaned up, even on crashes
- **Session Reaper** &mdash; Background thread monitors and cleans dead sessions
- **Panic logging** &mdash; Rust panics are caught and logged to file
- **Error boundaries** &mdash; Terminal crashes don't take down the app
- **Session persistence** &mdash; Tab state survives app restarts

### Security
- **CSP enforced** &mdash; `default-src 'self'; style-src 'self' 'unsafe-inline'`
- **Path validation** &mdash; Dropped file paths checked for safe Windows characters
- **No remote content** &mdash; Fully local application, no external network calls

---

## Project Structure

```
anvil/
├── app/
│   ├── src/
│   │   ├── components/       # React components
│   │   ├── contexts/         # React contexts
│   │   ├── hooks/            # Custom hooks
│   │   ├── App.tsx           # Root component
│   │   ├── App.css           # Design tokens + global styles
│   │   ├── themes.ts         # Theme application
│   │   └── types.ts          # TypeScript definitions
│   ├── src-tauri/
│   │   ├── src/
│   │   │   ├── main.rs       # Tauri setup
│   │   │   ├── commands.rs   # IPC handlers
│   │   │   ├── pty.rs        # PTY management
│   │   │   ├── session.rs    # Session lifecycle
│   │   │   ├── projects.rs   # Project scanning
│   │   │   ├── tools.rs      # CLI tool integration
│   │   │   └── logging.rs    # File logging
│   │   ├── Cargo.toml
│   │   └── tauri.conf.json
│   ├── package.json
│   └── vite.config.ts
├── CLAUDE.md                 # Project instructions
├── build_tauri.bat           # Build script (rust-lld)
├── build_msvc.bat            # Build script (MSVC)
└── README.md
```

---

## Configuration

Settings are persisted automatically to disk via the Rust backend.

| Setting | Default | Description |
|---------|---------|-------------|
| Tool | Claude | Active CLI tool |
| Model | Sonnet | Claude model variant |
| Effort | High | Reasoning effort level |
| Sort | Alpha | Project sort order |
| Theme | Catppuccin Mocha | UI theme |
| Font | Cascadia Code, 14px | Terminal font |
| Skip permissions | Off | Auto-accept tool use |
| Project dirs | `D:\Projects` | Directories to scan |

---

## Models

| Model | ID | Context |
|-------|-----|---------|
| Sonnet | `claude-sonnet-4-6` | Standard |
| Opus | `claude-opus-4-6` | Standard |
| Haiku | `claude-haiku-4-5` | Standard |
| Sonnet 1M | `claude-sonnet-4-6[1m]` | Extended |
| Opus 1M | `claude-opus-4-6[1m]` | Extended |

---

<p align="center">
  <sub>Built with Rust and TypeScript. Forged on Windows.</sub><br>
  <sub>Anvil &mdash; where code meets the hammer.</sub>
</p>
