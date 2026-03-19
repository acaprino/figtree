# Phase 5: UI Polish & Animations

## Assessment
The app demonstrates remarkably mature visual polish: purposeful animations, disciplined token usage, comprehensive retro mode overrides, global prefers-reduced-motion handling, proper focus-visible indicators, and theme crossfade. The findings are refinements -- moving from "well-made" to "wow."

## What's Done Well
- **Global `prefers-reduced-motion`** (App.css:300-306): Single media query kills all durations
- **Retro mode override system** (App.css:193-292): Comprehensive zero-radius, no-animation override
- **Theme crossfade** (App.css:66-82): 150ms ease-out on structural containers
- **CSS custom property architecture**: All colors via `color-mix()`, no hardcoded rgba
- **Tab enter/exit animations** (TabBar.css:62-88, TabSidebar.css:190-216): Correct easing directions
- **Skeleton shimmer** (ProjectList.css:19-34): Theme-aware gradient stops
- **Message entrance via `@starting-style`** (ChatView.css:967-974): Native browser API
- **Focus-visible on all interactive elements**: 2px solid accent, accessibility-correct
- **Active press states everywhere**: Consistent scale(0.95-0.97) on :active
- **Window controls match native Windows**: Close button red on hover

## Findings

### Critical
None.

### High

| ID | File | Issue | Fix |
|----|------|-------|-----|
| H1 | ChatView.css:38-41 | Chat messages not centered in wide viewports | Add `margin: 0 auto` to `.chat-messages-inner` |
| H2 | Modal.css:8-41 | No exit animation for modal (backdrop + content) -- instant disappear | Add `[data-state="closed"]` fade-out + slide-down animations |
| H3 | ShortcutsOverlay.css:1-10 | Full-screen overlay appears/disappears instantly | Add fade-in animation; close state with opacity transition |
| H4 | SessionPanel.css | Session panel appears with no entrance animation -- grid column jump | Use `@starting-style` for slide-in + fade |

### Medium

| ID | File | Issue | Fix |
|----|------|-------|-----|
| M1 | Multiple | Inconsistent transition easing (some missing `ease-out`) | Add `ease-out` to Modal.css:111, SystemPromptPage.css:104 |
| M2 | Multiple | ~15 raw pixel values bypassing spacing tokens | Replace with token equivalents |
| M3 | RightSidebar.css (6 places) | `font-size: 9px` with no token | Add `--text-2xs: 9px` token |
| M4 | ToolCard, ThinkingBlock | Collapsible content has no expand/collapse animation | Add height-reveal via Radix `data-state` attributes |
| M5 | ChatView.css:707-727 | Copy button has no success feedback animation | Add green flash + scale pop on "Copied" state |
| M6 | ChatInput.css:149-167 | Drag-drop overlay appears instantly | Add `animation: fade-in 0.15s ease-out` |
| M7 | SettingsModal.css:95-108 | Switch thumb lacks spring-like motion | Use `cubic-bezier(0.68, -0.1, 0.27, 1.1)` |
| M8 | InfoStrip.css:72-82 | Gear icon dual transform on hover+active (minor inconsistency) | Acceptable as-is |
| M9 | SessionPanel.css:37-49 | Close button missing `:active` and `:focus-visible` states | Add scale(0.9) active + outline focus-visible |
| M10 | RightSidebar.tsx | Tab switching has instant content swap | Add 0.1s opacity crossfade |

### Low

| ID | File | Issue | Fix |
|----|------|-------|-----|
| L1 | App.css:62 | `line-height: 1.4` tight for chat readability | Override to 1.5 in `.chat-view` |
| L2 | ChatView.css:402 | `.perm-btn` border-radius hardcoded to 0 | Use `var(--radius-sm)` |
| L3 | ChatInput.css:25,159 | `.attachment-chip` and `.chat-drop-overlay` border-radius 0 | Use `var(--radius-sm)` |
| L4 | ChatView.css:194,202,751 | Code blocks border-radius 0 | Intentional terminal aesthetic |
| L5 | SessionPanel.tsx:191 | "Loading..." plain text instead of skeleton shimmer | Use skeleton rows |
| L6 | RightSidebar.css:198 | Minimap viewport transition uses `linear` easing | Align to `ease-out` |
| L7 | NewTabPage.css:19, ProjectList.css:48 | `font-size: 32px` without token | Add `--text-3xl: 32px` or leave as decorative |
| L8 | UsagePage.tsx:154-167 | Loading state is static text | Add opacity pulse animation |
| L9 | SettingsModal.tsx:162 | `<select>` elements use native dropdown arrow | Accept native look or add `appearance: none` |
| L10 | ThinkingBlock.tsx:12-14 | Auto-collapse has no height animation | Wrap in Radix Collapsible for animated collapse |
