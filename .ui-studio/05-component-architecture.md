# Phase 5: Component Architecture

## Component Tree

```
App
├── TitleBar (NEW - vertical mode only)
│   └── WindowControls (extracted from TabBar)
├── TabBar (existing - horizontal mode only)
│   └── WindowControls
├── TabSidebar (NEW - vertical mode only)
│   ├── SidebarHeader (+ button)
│   ├── SidebarTabList (scrollable)
│   │   └── Tab items (reuse existing tab markup)
│   ├── SidebarFooter (Usage/About buttons)
│   └── ResizeHandle
├── TabContent (existing)
│   └── ... panels ...
└── InfoStrip (existing)
```

## New Components

### 1. TitleBar (new file: `app/src/components/TitleBar.tsx`)
**Props:**
- None (uses Tauri window API directly, same as current TabBar window controls)

**State:** None

**Responsibilities:**
- Render drag region (`data-tauri-drag-region`)
- Render window controls (minimize, maximize, close)
- Only rendered when `vertical_tabs` is true

**CSS:** Add to `TabBar.css` (or new `TitleBar.css` for separation)

### 2. TabSidebar (new file: `app/src/components/TabSidebar.tsx`)
**Props:**
```typescript
interface TabSidebarProps {
  tabs: Tab[];
  activeTabId: string;
  sidebarWidth: number;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  onSaveToProjects?: (tabId: string) => void;
  onToggleAbout: () => void;
  onToggleUsage: () => void;
  onResizeWidth: (width: number) => void;
}
```

**State:**
- `closingIds: Set<string>` (same pattern as TabBar)
- `contextMenu: ContextMenu | null` (same pattern as TabBar)
- `isResizing: boolean` (for drag handle)

**Responsibilities:**
- Render sidebar with header/list/footer sections
- Handle tab close animations
- Handle resize drag interaction
- Handle context menu
- Emit width changes to parent for persistence

**CSS:** New file `app/src/components/TabSidebar.css`

## Modified Components

### App.tsx Changes
- Read `vertical_tabs` and `sidebar_width` from settings
- Conditionally render `TitleBar` + `TabSidebar` vs `TabBar`
- Apply `.vertical-tabs` class and `--sidebar-width` CSS variable
- Handle `onResizeWidth` callback to persist sidebar width
- Apply `.resizing` class during sidebar resize

### types.ts Changes
```typescript
interface Settings {
  // ... existing fields ...
  vertical_tabs?: boolean;    // NEW
  sidebar_width?: number;     // NEW
}
```

### SettingsModal.tsx Changes
- Add "Tab layout" toggle in Behavior section
- Segmented control or toggle button: Horizontal / Vertical

### App.css Changes
- Add new CSS custom properties to `:root`
- Add `.app.vertical-tabs` grid layout rules
- Add `.title-bar` styles
- Add `.tab-sidebar` to theme crossfade list
- Add retro mode overrides for new elements
- Adjust `.resize-handle.left` top offset in vertical mode

## Files to Create
1. `app/src/components/TitleBar.tsx` — Window title bar component
2. `app/src/components/TitleBar.css` — Title bar styles
3. `app/src/components/TabSidebar.tsx` — Vertical tab sidebar component
4. `app/src/components/TabSidebar.css` — Sidebar styles

## Files to Modify
1. `app/src/types.ts` — Add `vertical_tabs`, `sidebar_width` to Settings
2. `app/src/App.tsx` — Dual-mode layout rendering
3. `app/src/App.css` — New tokens, grid layout, retro overrides
4. `app/src/components/modals/SettingsModal.tsx` — Add tab layout toggle

## State Flow
```
Settings (disk) → ProjectsContext → App.tsx
                                      ├── vertical_tabs? → class on .app
                                      ├── sidebar_width → CSS variable
                                      └── conditional render: TabBar vs TitleBar + TabSidebar
```

## CSS Architecture
- All new styles use existing CSS custom properties
- No new colors or fonts
- `color-mix()` for opacity variants (project convention)
- `.retro` overrides follow established patterns
- Theme crossfade transitions added for new containers
- Vertical tab animations use `max-height` instead of `max-width`

## Keyboard Navigation
- Same shortcuts work in both modes (Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+T, Ctrl+F4)
- Sidebar tab list: `aria-orientation="vertical"`
