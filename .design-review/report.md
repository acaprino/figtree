# Design & Performance Review -- 2026-03-14

Diff mode review - 4 files (2 modified, 2 new) - Minimap feature with bookmarks

## Scores

| Category | Score |
|----------|-------|
| UX Quality | 7/10 |
| Layout System | 7/10 |
| Visual Polish & Motion | 6.5/10 |
| Accessibility | 2/10 |
| Typography | 8/10 |
| React Performance | 5.5/10 |
| **Overall** | **6/10** |

Critical: 2 | High: 5 | Medium: 9 | Low: 10

## Files Audited

- `app/src/components/Terminal.tsx` (modified)
- `app/src/components/Terminal.css` (modified)
- `app/src/components/Minimap.tsx` (new)
- `app/src/components/Minimap.css` (new)

---

## Critical & High Issues

### Performance

#### `Minimap.tsx` -- Full buffer re-render on every frame
- **Severity**: Critical
- **Issue**: `render()` iterates EVERY buffer line (`translateToString` + per-char `fillRect`). At 10K+ lines, ~450K calls/frame. Fires on every rAF during heavy PTY output.
- **Fix**: Virtualize: only draw lines visible in minimap scroll container (~200-300 lines). Separate scroll-only viewport update from content render.
- [ ] Fixed

### Accessibility

#### `Minimap.tsx` -- Zero accessibility support
- **Severity**: Critical
- **Issue**: No ARIA roles, no keyboard navigation, no screen reader support. Mouse-only interactive element in a keyboard-heavy app.
- **Fix**: Add `role="scrollbar"`, `aria-label`, `aria-valuenow/min/max`, `tabIndex={0}`, `onKeyDown` for arrows/page/bookmark-jump. Or `aria-hidden="true"` with keyboard shortcuts for bookmark nav.
- [ ] Fixed

### Performance

#### `Minimap.tsx` -- Canvas height exceeds browser limits
- **Severity**: High
- **Issue**: `totalLines * 3 * dpr` can exceed 16,384-32,768px max canvas dimension. Silently produces blank canvas.
- **Fix**: Clamp to safe max (8192px). Scale line-to-pixel mapping, or virtualize.
- [ ] Fixed

#### `Minimap.tsx` -- Scroll events trigger full buffer re-render
- **Severity**: High
- **Issue**: `onScroll` triggers full canvas re-render. Only viewport indicator position changes on scroll.
- **Fix**: Separate `updateViewport()` from `render()`. `onScroll` calls `updateViewport` only.
- [ ] Fixed

#### `Terminal.tsx` -- setBookmarks triggers Terminal re-render
- **Severity**: High
- **Issue**: React state causes re-render on every Enter. New array reference defeats Minimap `memo`.
- **Fix**: Move bookmarks to ref. Pass `bookmarksRef` to Minimap. Canvas renders already use ref.
- [ ] Fixed

#### `Terminal.tsx` -- Unbounded bookmark array growth
- **Severity**: High
- **Issue**: Array grows without bound. Stale line numbers after buffer wraps.
- **Fix**: Use `Set`. Cap at ~2000. Prune bookmarks outside buffer range.
- [ ] Fixed

### UX

#### `Minimap.tsx` -- themeIdx prop accepted but never used
- **Severity**: High
- **Issue**: Dropped in destructuring. F9 theme change leaves minimap with stale colors.
- **Fix**: Destructure `themeIdx`, add `useEffect` to `scheduleRender`. Cache `getComputedStyle` in ref keyed on `themeIdx`.
- [ ] Fixed

---

## Medium Issues

#### `Minimap.tsx` -- getComputedStyle on every render frame
- **Fix**: Cache colors in ref, update via `useEffect` on `themeIdx`.
- [ ] Fixed

#### `Minimap.tsx` -- Canvas resize/reallocation every frame
- **Fix**: Guard with dimension check. Use fixed-size canvas with virtualization.
- [ ] Fixed

#### `Terminal.tsx` -- "Every Enter = bookmark" false positives
- **Fix**: Check `getLine(line)?.translateToString(true).trim().length > 0` before bookmarking.
- [ ] Fixed

#### `Minimap.tsx` -- No empty/null state handling
- **Fix**: Return `null` when `xterm` is null to hide minimap until terminal ready.
- [ ] Fixed

#### `Minimap.css` -- Viewport indicator opacity too low (0.12)
- **Fix**: Use `color-mix(in srgb, var(--accent) 15%, transparent)` with `opacity: 1`. Hover: 22%. Border stays full opacity.
- [ ] Fixed

#### `Minimap.tsx` -- No bookmark snap feedback
- **Fix**: Flash bookmark marker or pulse viewport on snap.
- [ ] Fixed

#### `Minimap.tsx` -- No cursor change during drag
- **Fix**: Set `cursor: grabbing` on body during drag, reset on mouseup.
- [ ] Fixed

#### `Minimap.tsx` -- Bookmark yellow muddy on some themes
- **Fix**: Raise alpha to 0.95-1.0.
- [ ] Fixed

#### `Minimap.css` -- No responsive collapse at narrow widths
- **Fix**: Container query to hide minimap below 500px.
- [ ] Fixed

---

## Low Issues

- Bookmark snap during drag causes jerky jumps -- disable snap during drag
- Adjacent bookmarks merge visually -- accept as density heatmap or add gap
- memo without custom comparator -- moot if bookmarks move to ref
- No minimap toggle shortcut -- consider adding F-key toggle
- Viewport transition 0.08s lag -- consider removing for instant tracking
- Border-left low contrast (--surface) -- use --crust or --overlay0
- Retro mode has no minimap overrides
- No will-change on viewport indicator
- String.includes in hot loop -- use module-scope Set
- Window drag listeners not cleaned on unmount -- store cleanup in ref

---

## What's Working Well

- Clean component boundary -- 4-prop interface, Terminal owns state
- RAF-based render coalescing prevents redundant paints
- DPR-aware canvas with proper scale/style separation
- Bookmark snap-to (3-line proximity) -- smart Fitts's Law optimization
- Global mousemove/mouseup for drag handles out-of-bounds correctly
- CSS variable consumption for automatic 10-theme compatibility
- Canvas `{ alpha: false }` avoids compositing overhead
- Correct flex layout: `flex:1 + min-width:0` terminal, `flex-shrink:0` minimap
- Structural syntax coloring gives informational value at minimap scale
- Comprehensive cleanup in Terminal useEffect

---

## Action Plan

1. [ ] Virtualize canvas rendering + separate scroll viewport update (Critical + High)
2. [ ] Fix themeIdx: destructure, cache getComputedStyle in ref (High + Medium)
3. [ ] Move bookmarks to ref/Set, cap at 2000, prune stale (High x2)
4. [ ] Clamp canvas height to safe max (High)
5. [ ] Improve bookmark heuristic -- check non-empty content (Medium)
6. [ ] Boost viewport indicator visibility with color-mix (Medium)
7. [ ] Add responsive collapse via container query (Medium)
8. [ ] Add drag cursor feedback (Medium)
