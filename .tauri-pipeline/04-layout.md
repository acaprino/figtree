# Phase 4: Layout Composition

## Assessment
The layout system is structurally sound with a coherent design token system, proper CSS Grid/Flexbox usage, thoughtful resize behavior, and a comprehensive retro mode override. No critical failures found. Main concerns are content centering in wide viewports, missing virtualization on ProjectList, and potential content area collapse when multiple panels are open.

## What's Done Well
- **Design token system** (App.css:1-46): 8px base grid with 4px fine-grain, color-mix() throughout, centralized layout tokens
- **Dual layout modes** (App.css:89-153): Horizontal and vertical tab layouts cleanly separated
- **Retro mode** (App.css:194-292): Pure CSS overrides, zero JS branching, comprehensive
- **Container queries** for responsive component adaptation (SessionConfig, BookmarkList, Minimap)
- **Chat view layout**: Clean flex split with 680px max-width message column
- **Tab animations**: Smooth enter/exit via max-width/height + opacity at 150ms
- **Modal system**: Proper z-index layering, backdrop blur, enter animation, responsive min-width
- **Window chrome**: Custom frameless with 8-direction resize handles, Windows 11 conventions
- **prefers-reduced-motion** media query for accessibility

## Findings

### Critical
None.

### High

| ID | File | Issue | Fix |
|----|------|-------|-----|
| H1 | ChatView.css:38-41 | Chat messages inner not centered -- hugs left edge, dead zone on right | Add `margin-inline: auto` to `.chat-messages-inner` |
| H2 | ProjectList.tsx:55-83 | No virtualization for project lists (50+ items) | Apply `useVirtualizer` (already a dependency) |
| H3 | App.css:104-112 | Content area can shrink to ~180px when sidebar + session panel open | Add `min-width: 400px` to `.tab-content` or cap sidebar dynamically |

### Medium

| ID | File | Issue | Fix |
|----|------|-------|-----|
| M1 | Multiple files | ~15 raw pixel values instead of spacing tokens | Replace with token equivalents; add `--text-2xs: 9px` if needed |
| M2 | ChatView.css:803-863 | Bottom status bar overflows at narrow widths | Add `flex-wrap: wrap` or container query collapse |
| M3 | SettingsModal.css:1-9 | Compound max-height constraints clip settings content | Use `max-height: calc(80vh - 100px)` |
| M4 | RightSidebar.tsx:34-52 | Right sidebar width not persisted to settings | Accept `onResizeWidth` prop, persist on mouseup |
| M5 | Static pages | No scroll-to-top on tab re-entry | Add useEffect with scrollTo(0,0) on isActive |
| M6 | InfoStrip.css:43-65 | Button touch targets below 28px minimum | Acceptable for desktop; add `@media (pointer: coarse)` if touch needed |

### Low

| ID | File | Issue | Fix |
|----|------|-------|-----|
| L1 | App.css:67-82 | Theme transition selector list manually maintained | Use broader selector or document convention |
| L2 | ShortcutsOverlay.css:37 | Dead media query (600px breakpoint never triggers) | Remove or lower to match app minimum width |
| L3 | FolderTree.css:3 | Hardcoded max-height: 280px | Use `max-height: min(280px, 40vh)` |
| L4 | BookmarkList.css / RightSidebar.css | Duplicate `.bookmark-item` styles with conflicts | Determine authoritative version, remove duplicate |
| L5 | App.css:17 | `--space-0: 2px` semantically misleading (docs say 0) | Rename to `--space-0_5` or add true `--space-0: 0` |
| L6 | SessionPanel.css:13 | No resize/collapse affordance in horizontal mode | Add collapse handle or reduce max-height |
| L7 | App.css:62 | `line-height: 1.4` slightly tight for chat | Override to 1.5 in `.chat-view` if readability prioritized |

## Key Issues for Polish Context
- H1: Message centering is the highest-impact visual improvement
- M1: Spacing token consistency matters for visual polish review
- L7: Line height choice affects readability of long conversations
- Container queries are already in use -- polish phase can leverage them
- Retro mode overrides need to be considered for any animation/transition additions
