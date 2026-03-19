# Pipeline Context

## Product Goal
Add a settings option to use vertical tabs (sidebar) instead of the default horizontal tab bar.

## Project
- Framework: React 19 + TypeScript 5 + Vite 6 (Tauri 2 desktop app)
- CSS approach: Vanilla CSS with CSS custom properties (design tokens in App.css :root)
- Component library: None (custom components)
- Test framework: None (manual testing only)
- Terminal: xterm.js 5.5 with WebGL renderer

## Key Files
- `app/src/components/TabBar.tsx` - Current horizontal tab bar component
- `app/src/components/TabBar.css` - Tab bar styles
- `app/src/App.tsx` - Main layout (flex column: tab-bar → tab-content)
- `app/src/App.css` - Root layout styles, design tokens
- `app/src/types.ts` - Settings interface
- `app/src/components/modals/SettingsModal.tsx` - Settings UI

## Current Layout
- `.app` is `display: flex; flex-direction: column`
- `TabBar` is at top, `tab-content` fills remaining space
- TabBar has window controls (minimize/maximize/close) and drag region
- Tab bar height is 42px (`--tab-height`)

## Flags
- Skip Brainstorm: no
- Skip Review: no
- Skip Humanize: no
- Strict Mode: no
- Framework: React 19
