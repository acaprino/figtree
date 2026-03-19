# Phase 1: Product Brief

## Product Brief

```
PRODUCT BRIEF
---
Goal:        Add a toggleable vertical tabs mode that moves tabs from a horizontal bar to a resizable left sidebar
Audience:    Power users of the Anvil terminal manager who prefer vertical tab layouts (VS Code/Firefox style)
Aesthetic:   Consistent with existing dark theme system (Catppuccin default) — same design tokens, hover states, animations
Stack:       React 19 + vanilla CSS custom properties (no new dependencies)
Perf budget: None (desktop Tauri app)
A11y:        Match existing level (keyboard nav, ARIA roles, focus-visible)
Success:     Toggle in Settings switches between horizontal and vertical tabs; layout persists across restarts; drag-to-resize sidebar width; all tab features work in both modes
---
```

## Problem Statement
The current horizontal tab bar works well for a few tabs but becomes cramped with many open sessions. Vertical tabs provide more space for tab labels, better visibility when many tabs are open, and match the workflow preference of power users accustomed to VS Code or Firefox vertical tabs.

## Target Users
Power users running multiple Claude/Gemini sessions simultaneously who want better tab visibility and management.

## Design Decisions
1. **Position**: Left side of window
2. **Window controls**: Keep a thin title bar (24px) at the top spanning full width for window controls (min/max/close) and Tauri drag region
3. **Sidebar width**: Resizable via drag handle, with sensible min/max constraints
4. **Tab content**: Same info as horizontal tabs (label, exit code badge, close button, new-output indicator)
5. **Toggle location**: Settings modal, Behavior section
6. **Persistence**: `vertical_tabs` boolean + `sidebar_width` number in Settings, saved to disk

## Feature Scope
- Must-have:
  - Settings toggle to switch between horizontal and vertical tabs
  - Left sidebar layout with resizable width (drag handle)
  - Thin title bar with window controls in vertical mode
  - All existing tab features working in vertical mode (close, exit code, output indicator, context menu, animations)
  - Sidebar width persisted in settings
  - Retro mode compatibility

- Nice-to-have:
  - Keyboard shortcut to toggle vertical/horizontal
  - Smooth transition animation when switching modes

- Out of scope:
  - Tab reordering via drag-and-drop
  - Collapsible/icon-only mode
  - Right-side positioning
