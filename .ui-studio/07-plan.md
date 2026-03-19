# Phase 7: Implementation Plan

## Task Overview
6 tasks, 4 files to modify, 2 files to create. No tests (manual testing only per project conventions).

---

## Task 1: Add settings fields (Rust + TypeScript)

### Files to modify:
- `app/src-tauri/src/projects.rs` — Add `vertical_tabs` and `sidebar_width` to Settings struct
- `app/src/types.ts` — Add `vertical_tabs` and `sidebar_width` to Settings interface

### Steps:
1. In `projects.rs`, add to Settings struct:
   ```rust
   #[serde(default)]
   pub vertical_tabs: bool,
   #[serde(default = "default_sidebar_width")]
   pub sidebar_width: u32,
   ```
2. Add `fn default_sidebar_width() -> u32 { 200 }`
3. Add to `Default` impl: `vertical_tabs: false, sidebar_width: default_sidebar_width()`
4. In `types.ts`, add to Settings interface:
   ```typescript
   vertical_tabs?: boolean;
   sidebar_width?: number;
   ```

---

## Task 2: Create TitleBar component

### Files to create:
- `app/src/components/TitleBar.tsx`
- `app/src/components/TitleBar.css`

### Steps:
1. Create `TitleBar.tsx` with:
   - Drag region (`data-tauri-drag-region`)
   - Window controls (minimize, maximize, close) — same SVGs as TabBar
   - Wrapped in `React.memo`
2. Create `TitleBar.css` with:
   - `.title-bar`: flex, height 32px, bg crust, border-bottom surface
   - `.title-bar` hidden by default, shown via `.app.vertical-tabs .title-bar`
   - Window controls reuse existing `.win-btn` styles
   - Retro override: 2px border with overlay0

---

## Task 3: Create TabSidebar component

### Files to create:
- `app/src/components/TabSidebar.tsx`
- `app/src/components/TabSidebar.css`

### Steps:
1. Create `TabSidebar.tsx` with:
   - Props: same as TabBar (tabs, activeTabId, onActivate, onClose, onAdd, onSaveToProjects, onToggleAbout, onToggleUsage) + onResizeWidth
   - Three sections: header (+ button), scrollable tab list, footer (Usage/About buttons)
   - Tab items: reuse same markup pattern as TabBar (label, exit code, close button)
   - Close animation: same `closingIds` + `closingTimersRef` pattern as TabBar
   - Context menu: same pattern as TabBar
   - Resize handle: mousedown handler that:
     - Adds `resizing` class to `.app`
     - Tracks mouse movement, clamps width between 140-360px
     - Calls `onResizeWidth` on mouseup
     - Cleans up on mouseup
   - `React.memo` wrapper

2. Create `TabSidebar.css` with:
   - `.tab-sidebar`: flex column, bg crust, border-right surface, position relative
   - `.tab-sidebar__header`: flex, 40px, border-bottom, contains + button
   - `.tab-sidebar__list`: flex-1, overflow-y auto, scrollbar-width thin, gap 2px
   - `.tab-sidebar__footer`: flex, 36px, border-top, contains action buttons
   - `.tab-sidebar__resize`: absolute, right 0, width 4px, cursor col-resize, accent on hover
   - `.tab-sidebar .tab`: vertical tab item overrides (height 36px, full width)
   - `.tab-sidebar .tab::after`: left accent bar (3px wide, scaleY animation)
   - `.tab-sidebar .tab .tab-close`: opacity 0, visible on hover/active
   - `@keyframes vtab-enter/vtab-exit`: max-height based animations
   - Retro overrides for all new selectors

---

## Task 4: Add CSS tokens and layout rules to App.css

### Files to modify:
- `app/src/App.css`

### Steps:
1. Add new CSS custom properties to `:root`:
   ```css
   --title-bar-height: 32px;
   --sidebar-width: 200px;
   --sidebar-min-width: 140px;
   --sidebar-max-width: 360px;
   --sidebar-handle-width: 4px;
   ```
2. Add `.app.vertical-tabs` grid layout:
   ```css
   .app.vertical-tabs {
     display: grid;
     grid-template-rows: var(--title-bar-height) 1fr var(--info-strip-height);
     grid-template-columns: var(--sidebar-width) 1fr;
   }
   .app.vertical-tabs .tab-bar { display: none; }
   .app.vertical-tabs .tab-content { min-width: 0; min-height: 0; }
   ```
3. Add `.app.vertical-tabs.resizing` styles (cursor, pointer-events)
4. Adjust resize handles for vertical mode:
   ```css
   .app.vertical-tabs .resize-handle.left { top: var(--title-bar-height); }
   ```
5. Add `.tab-sidebar` and `.title-bar` to theme crossfade transition list
6. Add retro mode overrides for title-bar and resizing class

---

## Task 5: Integrate in App.tsx

### Files to modify:
- `app/src/App.tsx`

### Steps:
1. Import TitleBar and TabSidebar
2. Read `vertical_tabs` and `sidebar_width` from settings
3. Add `handleResizeWidth` callback that calls `updateSettings({ sidebar_width: width })`
4. Add `isResizing` state for the resizing class
5. Apply classes to `.app`: `vertical-tabs` when enabled, `resizing` during drag
6. Set `--sidebar-width` as inline style when vertical mode is on
7. Conditionally render:
   - Vertical mode: `<TitleBar />` + `<TabSidebar ... />`
   - Horizontal mode: `<TabBar ... />` (existing)

---

## Task 6: Add toggle to SettingsModal

### Files to modify:
- `app/src/components/modals/SettingsModal.tsx`

### Steps:
1. Add a toggle row in the Behavior section:
   ```tsx
   <div className="settings-toggle-row">
     <span>Tab layout</span>
     <SegmentedControl
       options={[{ label: "Horizontal", value: "horizontal" }, { label: "Vertical", value: "vertical" }]}
       value={settings.vertical_tabs ? "vertical" : "horizontal"}
       onChange={(idx) => onUpdate({ vertical_tabs: idx === 1 })}
       title="Tab layout"
     />
   </div>
   ```
2. Place it as the first item in the Behavior section (before sort order)

---

## Execution Order
Tasks 1 → 4 → 2 → 3 → 5 → 6

Task 1 and 4 are foundation (types + CSS tokens).
Tasks 2 and 3 are new components.
Task 5 wires everything together.
Task 6 adds the settings UI.
