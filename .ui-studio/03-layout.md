# Phase 3: Layout System

## Dual-Mode App Container

### Horizontal mode (unchanged)
```css
.app { display: flex; flex-direction: column; height: 100%; min-width: 480px; min-height: 320px; }
.tab-content { flex: 1; overflow: hidden; position: relative; }
```

### Vertical mode (new)
```css
.app.vertical-tabs {
  display: grid;
  grid-template-rows: var(--title-bar-height) 1fr var(--info-strip-height);
  grid-template-columns: var(--sidebar-width) 1fr;
  min-width: 560px;
}

.app.vertical-tabs .tab-bar { display: none; }
.title-bar { display: none; }
.app.vertical-tabs .title-bar { display: flex; }
```

## New Tokens
```css
:root {
  --title-bar-height: 32px;
  --sidebar-width: 200px;
  --sidebar-min-width: 140px;
  --sidebar-max-width: 360px;
  --sidebar-handle-width: 4px;
}
```

## Title Bar
- 32px tall, full width, `background: var(--crust)`, drag region
- Window controls (min/max/close) at right edge, identical styling to current

## Sidebar Internal Layout
- **Header**: New tab button (40px fixed)
- **Tab list**: Scrollable, `flex: 1`, thin scrollbar
- **Footer**: Usage/About action buttons (36px fixed)

## Sidebar Container
```css
.tab-sidebar {
  display: flex;
  flex-direction: column;
  background: var(--crust);
  border-right: 1px solid var(--surface);
  position: relative;
  overflow: hidden;
}
```

## Resize Handle
- 4px invisible strip on right edge, accent tint on hover
- Clamp between 140px and 360px
- Dynamic max: `min(var(--sidebar-max-width), calc(100% - 320px))` to ensure 320px content minimum
- During drag: `pointer-events: none` on content, `cursor: col-resize` on body

## Content Area in Vertical Mode
```css
.app.vertical-tabs .tab-content {
  overflow: hidden;
  position: relative;
  min-width: 0;
  min-height: 0;
}
```

## Window Resize Handles
Left resize handle uses `--title-bar-height` instead of `--tab-height` for top offset:
```css
.app.vertical-tabs .resize-handle.left { top: var(--title-bar-height); }
.app.vertical-tabs .resize-handle.top { height: 3px; }
```

## Minimum Window Size
560px width (140px sidebar + 420px content) × 320px height. Since Tauri minWidth is static, use 560px for both modes.
