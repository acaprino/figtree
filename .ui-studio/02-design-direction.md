# Vertical Tabs -- Design Direction

## Overview

Vertical tabs move the tab list from a horizontal bar at the top of the window into a resizable sidebar on the left edge. The horizontal tab bar is replaced by a thin title bar containing only the window drag region and window controls (minimize, maximize, close). All visual treatments reuse existing design tokens with zero new colors or fonts.

---

## 1. Layout Structure

The `.app` container switches from a single-column layout to a two-region layout when vertical tabs are active.

```
Horizontal mode (current):
+--[TabBar]---------------------[win-ctrls]--+
|                                             |
|                 tab-content                 |
|                                             |
+--[InfoStrip]--------------------------------+

Vertical mode (new):
+--[TitleBar]------------------[win-ctrls]---+
| sidebar  |                                  |
| [+]      |                                  |
| tab      |          tab-content             |
| tab      |                                  |
| tab      |                                  |
| -------- |                                  |
| [U] [i]  |                                  |
+--[InfoStrip]--------------------------------+
```

### App container in vertical mode

```css
.app.vertical-tabs {
  display: grid;
  grid-template-rows: var(--title-bar-height) 1fr var(--info-strip-height);
  grid-template-columns: var(--sidebar-width) 1fr;
  height: 100%;
}

.app.vertical-tabs .title-bar {
  grid-column: 1 / -1;
  grid-row: 1;
}

.app.vertical-tabs .tab-sidebar {
  grid-column: 1;
  grid-row: 2;
}

.app.vertical-tabs .tab-content {
  grid-column: 2;
  grid-row: 2;
}

.app.vertical-tabs .info-strip {
  grid-column: 1 / -1;
  grid-row: 3;
}
```

---

## 2. New CSS Custom Properties

Only layout-dimensional tokens are added. No new colors, fonts, or visual tokens.

```css
:root {
  --title-bar-height: 32px;
  --sidebar-width: 200px;
  --sidebar-min-width: 140px;
  --sidebar-max-width: 360px;
  --sidebar-handle-width: 4px;
}
```

**Rationale:**
- `--title-bar-height: 32px` -- standard Windows frameless title bar height. Smaller than `--tab-height` (42px) because it holds no tab content, just drag region and 3 window buttons.
- `--sidebar-width: 200px` -- default width, matching the existing `--tab-max-width: 200px` so tab labels show the same amount of text by default.
- `--sidebar-min-width: 140px` -- enough for a truncated project name + close button.
- `--sidebar-max-width: 360px` -- prevents the sidebar from consuming more than ~40% of a 900px-wide window.
- `--sidebar-handle-width: 4px` -- matches existing window resize handles (`.resize-handle.left { width: 4px }`).

---

## 3. Title Bar (Vertical Mode Only)

When vertical tabs are active, the horizontal tab bar is replaced by a minimal title bar. It provides only: window drag region and window controls.

### Visual treatment

```css
.title-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  background: var(--crust);
  height: var(--title-bar-height);
  border-bottom: 1px solid var(--surface);
  user-select: none;
  -webkit-app-region: drag;
}
```

- Background: `var(--crust)` -- same as the current horizontal tab bar.
- Border: `1px solid var(--surface)` -- same bottom border as current tab bar.
- Height: `var(--title-bar-height)` (32px) -- 10px shorter than the full tab bar since it holds no tab items.
- Window controls sit at the right edge, identical to their current implementation. No changes to `.window-controls` or `.win-btn` CSS.

### Retro mode

```css
.retro .title-bar {
  border-bottom: 2px solid var(--overlay0);
}
```

Matches the thicker border pattern established by `.retro .tab-bar`.

---

## 4. Sidebar Aesthetics

### Container

```css
.tab-sidebar {
  display: flex;
  flex-direction: column;
  background: var(--crust);
  border-right: 1px solid var(--surface);
  overflow: hidden;
  user-select: none;
  width: var(--sidebar-width);
  min-width: var(--sidebar-min-width);
  max-width: var(--sidebar-max-width);
  transition: background-color 150ms ease-out, border-color 150ms ease-out;
}
```

**Design decisions:**
- Background `var(--crust)` -- the darkest structural surface, same as the current tab bar. This creates a clear visual separation from `var(--bg)` in the content area.
- Right border `1px solid var(--surface)` -- mirrors the current tab bar's `border-bottom`. Structural borders use `--surface`, not `--overlay0`, to stay subtle.
- No box-shadow on the separator. The existing codebase avoids shadows for structural separation ("kill lines, use space" principle). The border + background contrast is sufficient.

### Retro mode

```css
.retro .tab-sidebar {
  border-right: 2px solid var(--overlay0);
  border-radius: 0;
}
```

Follows the established retro pattern of thicker borders using `--overlay0`.

---

## 5. Tab Item Layout (Vertical)

Each vertical tab is a horizontal row inside the sidebar. The layout mirrors the current horizontal tab structure but adapted for vertical stacking.

### Dimensions

- **Height:** 36px per tab item. Slightly taller than the horizontal tab's 34px to provide comfortable vertical click targets (Fitts's Law -- taller targets in a vertical list are easier to hit).
- **Padding:** `var(--space-2) var(--space-3)` (8px 12px). Horizontal padding matches current tabs. Vertical padding provides breathing room between stacked items.
- **Gap between tabs:** `var(--space-0)` (2px). Tighter than horizontal mode's `var(--space-1)` (4px) because vertical space is more precious with many tabs.

### Structure

```css
.tab-sidebar .tab {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  height: 36px;
  position: relative;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  max-width: none;           /* override horizontal max-width */
  margin: 0 var(--space-1);  /* inset from sidebar edges */
  transition: background 0.15s ease-out, color 0.15s ease-out;
}
```

### Content arrangement (left to right)

```
[accent bar] [output dot?] [label...............] [exit icon] [x]
```

1. **Active indicator** -- 3px accent bar on the left edge (see section 6).
2. **New output dot** -- 6px pulsing accent dot, same as current `.tab.has-output::before`.
3. **Label** -- `flex: 1; overflow: hidden; text-overflow: ellipsis;` -- fills available space. Font size `var(--text-sm)` (11px), same as current.
4. **Exit code badge** -- checkmark or X, same as current `.tab-exit`.
5. **Close button** -- 24x24px, identical to current `.tab-close`. Only visible on hover or when the tab is active, to reduce visual noise.

### Close button visibility

```css
.tab-sidebar .tab .tab-close {
  opacity: 0;
  transition: opacity 0.1s ease-out, background 0.15s ease-out, color 0.15s ease-out;
}

.tab-sidebar .tab:hover .tab-close,
.tab-sidebar .tab.active .tab-close {
  opacity: 1;
}
```

This progressive disclosure keeps the sidebar clean when scanning many tabs. The close button is always there for screen readers (no `display: none`), only visually hidden.

### Hover and active states

Identical to current horizontal tabs -- no changes needed:

```css
/* These selectors apply to both modes */
.tab:hover            { background: var(--hover-overlay-subtle); }
.tab:active           { background: var(--hover-overlay); }
.tab.active           { background: var(--hover-overlay-subtle); color: var(--text); }
```

### Temporary tab style

Same italic treatment: `.tab.temporary .tab-label { font-style: italic; opacity: 0.8; }`

---

## 6. Active Indicator

The active indicator rotates from a **bottom bar** (horizontal mode) to a **left bar** (vertical mode).

### Horizontal mode (current, unchanged)

```css
.tab::after {
  /* 3px tall accent bar at bottom center */
  bottom: 2px;
  left: 50%;
  transform: translateX(-50%) scaleX(0);
  width: 16px;
  height: 3px;
}
.tab.active::after {
  transform: translateX(-50%) scaleX(1);
}
```

### Vertical mode

```css
.tab-sidebar .tab::after {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%) scaleY(0);
  width: 3px;
  height: 16px;
  border-radius: 0 2px 2px 0;   /* rounded on right side only */
  background: var(--accent);
  transition: transform 0.2s ease-out, height 0.2s ease-out;
  /* Reset horizontal positioning */
  bottom: auto;
  right: auto;
}

.tab-sidebar .tab.active::after {
  transform: translateY(-50%) scaleY(1);
}
```

**Design decisions:**
- Width stays 3px (same thickness as horizontal bar).
- Height 16px (same length as horizontal bar width).
- `scaleY` animation mirrors the `scaleX` animation of horizontal mode.
- Border-radius on the right side only (flat against the left edge, rounded outward). This matches VS Code's sidebar active indicator convention (Jakob's Law).
- The accent bar sits at the left edge of the tab item (inside the margin), creating a clear visual anchor for the selected state.

### Retro mode

```css
.retro .tab-sidebar .tab::after {
  border-radius: 0;
}
```

---

## 7. Sidebar Sections

The sidebar is divided into three sections:

```
+-------------------+
| [+] New Tab       |  <- header (fixed)
+-------------------+
| tab               |
| tab               |  <- scrollable tab list
| tab               |
| ...               |
+-------------------+
| [U] [i]           |  <- footer actions (fixed)
+-------------------+
```

### Header (new tab button)

```css
.tab-sidebar__header {
  display: flex;
  align-items: center;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid color-mix(in srgb, var(--surface) 50%, transparent);
}
```

The new tab button fills the header width:

```css
.tab-sidebar__header .tab-add {
  flex: 1;
  text-align: left;
  height: 28px;
  font-size: var(--text-sm);
  padding: 0 var(--space-2);
}
```

Uses a subtler separator (`--surface` at 50% opacity via `color-mix`) to distinguish from the structural border without adding visual weight.

### Tab list (scrollable)

```css
.tab-sidebar__list {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: var(--space-0);
  padding: var(--space-1) 0;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--overlay0) 40%, transparent) transparent;
}
```

**Scrollbar treatment:** `scrollbar-width: thin` with a semi-transparent scrollbar thumb using `--overlay0`. This is more visible than the horizontal mode's hidden scrollbar because vertical scrolling is a primary interaction in a long tab list, unlike horizontal overflow which is incidental.

### Footer (action buttons)

```css
.tab-sidebar__footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid color-mix(in srgb, var(--surface) 50%, transparent);
}
```

The Usage and About action buttons move here from the tab bar. Same `.tab-bar-action` styles apply (28x28px, `--text-dim`, hover overlay).

---

## 8. Resize Handle

The resize handle sits on the right edge of the sidebar, overlapping the border.

### Visual treatment

```css
.tab-sidebar__resize {
  position: absolute;
  top: 0;
  right: 0;
  width: var(--sidebar-handle-width);
  height: 100%;
  cursor: col-resize;
  z-index: var(--z-resize);
  /* Invisible by default -- the structural border provides the visual */
  background: transparent;
  transition: background 0.15s ease-out;
}

.tab-sidebar__resize:hover,
.tab-sidebar__resize:active {
  background: color-mix(in srgb, var(--accent) 40%, transparent);
}

.tab-sidebar__resize:active {
  background: color-mix(in srgb, var(--accent) 60%, transparent);
}
```

**Design decisions:**
- The handle is invisible at rest. The 1px structural border provides enough visual affordance. On hover, a 4px-wide accent-tinted strip appears, signaling "this is draggable."
- Uses `color-mix` with `--accent` at 40%/60% opacity, consistent with how the codebase creates semi-transparent accent treatments (e.g., `.info-strip__filter` uses accent at 12%).
- The `:active` state is slightly more opaque to confirm the drag is engaged.
- Width `4px` matches existing window resize handles.

### Retro mode

```css
.retro .tab-sidebar__resize:hover,
.retro .tab-sidebar__resize:active {
  background: var(--accent);
  /* Hard edge, no transparency -- matches retro's opaque style */
}
```

### Resize behavior (implementation notes)

- Drag updates `--sidebar-width` on `document.documentElement` in real time.
- Clamp between `--sidebar-min-width` (140px) and `--sidebar-max-width` (360px).
- Persist final width to settings so it survives restart.
- During drag, add `user-select: none` to body and `cursor: col-resize` to prevent text selection and cursor flicker.
- No transition on `width` during drag (would cause lag). Apply `transition: width 0.15s ease-out` only on programmatic width changes (e.g., reset to default).

---

## 9. Motion Design

### Sidebar entry (toggle from horizontal to vertical)

No animated transition between modes. The layout switch is instantaneous. Animating between fundamentally different grid layouts creates visual noise without aiding comprehension. The user explicitly chose to switch modes -- they expect the result, not a show.

### Tab entry animation (vertical)

```css
@keyframes vtab-enter {
  from {
    opacity: 0;
    max-height: 0;
    padding-top: 0;
    padding-bottom: 0;
  }
  to {
    opacity: 1;
    max-height: 36px;
    padding-top: var(--space-2);
    padding-bottom: var(--space-2);
  }
}

.tab-sidebar .tab {
  animation: vtab-enter 0.2s ease-out;
}
```

Mirrors the horizontal `tab-enter` animation but uses `max-height` instead of `max-width`, since vertical tabs grow downward.

### Tab exit animation (vertical)

```css
@keyframes vtab-exit {
  to {
    opacity: 0;
    max-height: 0;
    padding-top: 0;
    padding-bottom: 0;
    margin-top: 0;
    margin-bottom: 0;
    overflow: hidden;
  }
}

.tab-sidebar .tab.closing {
  animation: vtab-exit 0.15s ease-in forwards;
}
```

Same duration and easing as horizontal exit (0.15s ease-in).

### Active indicator transition

The `scaleY` transition on `.tab::after` uses `0.2s ease-out`, identical to the horizontal `scaleX` transition. When switching active tabs, the bar on the old tab scales down while the bar on the new tab scales up simultaneously, creating a smooth visual handoff.

### Reduced motion

Already handled globally in `App.css`:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

No additional overrides needed.

### Retro mode

Already handled globally -- retro kills all transitions and animations:

```css
.retro .tab-sidebar,
.retro .tab-sidebar .tab,
.retro .tab-sidebar .tab.closing,
.retro .tab-sidebar__resize { transition: none; }

.retro .tab-sidebar .tab,
.retro .tab-sidebar .tab.closing { animation: none; }
```

---

## 10. Theme Adaptability

### Token-only approach

Every visual property in the vertical tabs design references existing CSS custom properties. When `applyTheme()` updates `--crust`, `--surface`, `--accent`, `--text`, `--text-dim`, `--overlay0`, and `--hover-overlay-subtle` on `:root`, the sidebar inherits the new values automatically.

### Theme crossfade

Add `.tab-sidebar` and `.title-bar` to the existing crossfade transition list in `App.css`:

```css
.tab-bar,
.tab-sidebar,      /* new */
.title-bar,         /* new */
.session-config,
.info-strip,
/* ... rest of existing selectors ... */
{
  transition: background-color 150ms ease-out, color 150ms ease-out, border-color 150ms ease-out;
}
```

### Per-theme verification

All 10 themes use the same token names with different values. The sidebar design uses only these tokens:

| Token | Usage in sidebar |
|-------|-----------------|
| `--crust` | Sidebar background, title bar background |
| `--surface` | Border color, separator lines |
| `--text` | Active tab label color |
| `--text-dim` | Inactive tab label, close button, action buttons |
| `--accent` | Active indicator bar, resize handle hover, new-output dot |
| `--overlay0` | Retro border color, scrollbar thumb base |
| `--hover-overlay-subtle` | Tab hover/active background |
| `--hover-overlay` | Close button hover, tab pressed state |
| `--radius-sm` | Tab border-radius, button border-radius |

No theme requires special-case overrides. The retro themes (`Anvil Forge`, `Guybrush`) are handled by the existing `.retro` class which zeroes out radii and kills transitions globally.

### Retro themes specifics

The retro class already handles:
- Zero border-radius on all interactive elements
- 2px solid borders with `--overlay0` on structural containers
- No transitions or animations
- Monospace font override

The only new retro selectors needed are those listed in sections 3, 4, 6, and 8 above.

---

## 11. Resize Handle Interaction with Window Edges

When the sidebar is present, the left window resize handle must account for it:

```css
.app.vertical-tabs .resize-handle.left {
  top: var(--title-bar-height);
  /* Still starts below the top bar, but now below title-bar instead of tab-bar */
}
```

The `--tab-height` reference in `.resize-handle.left { top: var(--tab-height) }` should be updated to use a computed value or the title bar height when in vertical mode.

---

## 12. Keyboard Navigation

### Focus management

- `Ctrl+Shift+B` or a similar shortcut toggles vertical tabs mode.
- Arrow Up / Arrow Down navigate between tabs in the sidebar (matching horizontal mode's implicit left/right via Tab key).
- The sidebar tab list has `role="tablist"` with `aria-orientation="vertical"`.
- Each tab item retains `role="tab"`, `aria-selected`, and `tabIndex` attributes.

### Focus indicator

Same as current: `outline: 2px solid var(--accent); outline-offset: -2px;` on `.tab:focus-visible`.

---

## 13. Settings Integration

The vertical tabs toggle should be added to the existing Settings modal (opened via `Ctrl+,`). It is a boolean preference stored in `Settings`:

```typescript
// In types.ts Settings interface
vertical_tabs?: boolean;
```

Persisted to disk alongside other settings. Default: `false` (horizontal tabs).

---

## 14. Summary of New CSS Selectors

| Selector | Purpose |
|----------|---------|
| `.app.vertical-tabs` | Grid layout override on app container |
| `.title-bar` | Thin title bar with drag region + window controls |
| `.tab-sidebar` | Sidebar container |
| `.tab-sidebar__header` | New tab button area |
| `.tab-sidebar__list` | Scrollable tab list |
| `.tab-sidebar__footer` | Usage/About action buttons |
| `.tab-sidebar__resize` | Drag-to-resize handle |
| `.tab-sidebar .tab` | Vertical tab item overrides |
| `.tab-sidebar .tab::after` | Left-side active indicator |
| `.tab-sidebar .tab .tab-close` | Progressive disclosure on close button |
| `@keyframes vtab-enter` | Vertical tab entry animation |
| `@keyframes vtab-exit` | Vertical tab exit animation |
| `.retro .title-bar` | Retro title bar border |
| `.retro .tab-sidebar` | Retro sidebar border |
| `.retro .tab-sidebar__resize` | Retro resize handle |
| `.retro .tab-sidebar .tab::after` | Retro active indicator (no radius) |

---

## 15. What This Design Does NOT Change

- No new colors, fonts, or visual tokens.
- No changes to tab content area, terminal rendering, or panel switching.
- No changes to InfoStrip.
- No changes to modal, settings, or any other component CSS.
- No changes to the horizontal tab bar CSS (it remains the default mode).
- No new npm dependencies.
- The horizontal and vertical modes are mutually exclusive; both CSS paths coexist but only one is active via the `.vertical-tabs` class on `.app`.
