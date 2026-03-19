# Phase 4: UX Patterns

## Mode Toggle
- **Location**: Settings modal → Behavior section, as a toggle button
- **Label**: "Tab layout" with segmented control: "Horizontal" | "Vertical"
- **Effect**: Immediate (no save button needed), persisted to settings
- **No animation** between modes — instantaneous switch

## Sidebar Interactions

### Tab Selection
- Click to activate (same as horizontal)
- Active tab gets left accent bar + subtle background highlight
- Keyboard: Arrow Up/Down to navigate, Enter to activate

### Tab Closing
- Close button (×) visible on hover or when tab is active
- Same closing animation as horizontal (collapse + fade)
- If closing active tab, adjacent tab activates (same logic as horizontal)

### New Tab
- "+" button at top of sidebar
- Same behavior as horizontal new tab button

### Scrolling
- Vertical scroll when tabs exceed sidebar height
- Thin scrollbar (scrollbar-width: thin)
- Active tab auto-scrolled into view on activation

### Context Menu
- Right-click on tab shows same context menu as horizontal mode
- Menu positioned relative to cursor, clamped to viewport

## Resize Handle
- **Cursor**: `col-resize` on hover
- **Feedback**: Accent-tinted strip appears on hover (40% opacity), intensifies on drag (60%)
- **During drag**: Body gets `cursor: col-resize`, content area gets `pointer-events: none` to prevent terminal interaction
- **Release**: Width persisted to settings
- **Double-click**: Could reset to default width (nice-to-have)

## State Management
- `vertical_tabs: boolean` in Settings (default: false)
- `sidebar_width: number` in Settings (default: 200)
- Class `.vertical-tabs` toggled on `.app` container
- `--sidebar-width` CSS custom property updated inline

## Accessibility
- `role="tablist"` with `aria-orientation="vertical"` on sidebar tab list
- `role="tab"`, `aria-selected`, `tabIndex` on each tab (same as horizontal)
- Focus-visible: `2px solid var(--accent)` outline (same as horizontal)
- All content remains keyboard-accessible

## Empty/Loading/Error States
- No new states needed — sidebar renders whatever tabs exist
- If zero tabs: sidebar shows only "+" button (same as horizontal with no tabs)

## Retro Mode
- All retro overrides apply automatically via `.retro` class
- Thicker borders, zero radii, no transitions/animations
- Same patterns as established retro rules
