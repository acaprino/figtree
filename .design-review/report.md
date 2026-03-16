# Design & Performance Review -- 2026-03-16

Diff mode audit - 8 files - ChatView, ChatInput, CommandMenu, SettingsModal, App.tsx, types.ts, MessageBubble

## Product Brief Context

Windows-only Tauri 2 desktop app for Claude Code Agent SDK sessions. Terminal-style dark aesthetic (Catppuccin Mocha default). Target: developers using Claude Code.

## Scores

| Category | Score |
|----------|-------|
| UX Quality | 7/10 |
| Layout System | 8/10 |
| CSS Architecture | 8/10 |
| Visual Polish & Motion | 6/10 |
| Accessibility | 4/10 |
| Typography | 6/10 |
| React Performance | 6/10 |
| **Overall** | **6.5/10** |

Critical: 3 | High: 8 | Medium: 14 | Low: 10

## Files Audited

- `ChatView.tsx`, `ChatView.css`, `ChatInput.tsx`, `ChatInput.css`
- `CommandMenu.tsx`, `SettingsModal.tsx`, `App.tsx`, `types.ts`
- `MessageBubble.tsx`, `RightSidebar.css`

---

## Critical Issues

### React Performance

#### `ChatView.tsx:129-138` -- Streaming chunks trigger O(n) scan + full re-render
- **Severity**: Critical
- **Issue**: Every streaming chunk calls setMessages with `prev.findIndex(m => m.id === id)` (O(n) scan) then spreads the entire array. During long conversations with hundreds of messages, each chunk arriving every 50-100ms does O(n) work AND triggers a full re-render of every message.
- **Fix**: Use an accumulation ref for streaming text and only commit to React state on a throttled basis (requestAnimationFrame or 100ms debounce). The streaming message is always the last element -- maintain an index ref to eliminate findIndex.
- [ ] Fixed

#### `ChatView.tsx:170-184` -- toolResult creates reversed array copy
- **Severity**: Critical
- **Issue**: `[...prev].reverse().findIndex()` copies the entire messages array on every tool result event. Always returns a new array reference, causing a re-render of all children.
- **Fix**: Iterate backward with a simple for-loop: `for (let i = prev.length - 1; i >= 0; i--)`. Also guard the result handler's `prev.map()` against unnecessary iteration when no thinking messages need updating.
- [ ] Fixed

#### `ChatView.tsx:470,496,509,527` -- Inline closures break React.memo
- **Severity**: Critical
- **Issue**: Four ChatInput instances each receive `onDroppedFilesConsumed={() => setDroppedFiles([])}` -- a new closure on every render. Since ChatInput is memo'd, this breaks memoization. PermissionCard also gets an inline closure per permission message.
- **Fix**: Hoist to `useCallback`: `const handleDroppedFilesConsumed = useCallback(() => setDroppedFiles([]), [])`. For PermissionCard, pass msg.id as a prop and let it call a stable callback.
- [ ] Fixed

---

## High Issues

### Accessibility

#### `ChatView.tsx` -- Missing ARIA landmarks and live regions
- **Severity**: High
- **Issue**: Chat message area has no `role="log"` or `aria-live`. Screen readers won't announce new messages. User, assistant, tool, and error messages are undifferentiated divs.
- **Fix**: Add `role="log" aria-live="polite" aria-label="Conversation"` to `.chat-messages`. Add `role="status"` to error messages.
- [ ] Fixed

#### `ChatView.tsx` -- Permission buttons lack accessible labels
- **Severity**: High
- **Issue**: The Y/session/n buttons have no aria-label. Hit target well under 24px (WCAG 2.5.8 violation). Padding `0 6px` with font-size 10px.
- **Fix**: Add aria-labels: "Allow tool execution", "Allow for session", "Deny tool execution". Add `min-height: 24px` to `.perm-btn`.
- [ ] Fixed

#### `CommandMenu.tsx` -- Missing combobox ARIA pattern
- **Severity**: High (accessibility)
- **Issue**: No `role="listbox"`, no `aria-activedescendant`, no `aria-selected` on items. Uses document-level keydown listeners that can conflict.
- **Fix**: Add `role="listbox"` to menu, `role="option"` + `aria-selected` to items. Connect textarea with `aria-controls` and `aria-activedescendant`.
- [ ] Fixed

### UX

#### `ChatView.tsx` -- "Starting agent..." near-invisible, no error recovery
- **Severity**: High
- **Issue**: Idle state shows a dim status message (opacity 0.35, 10px) that is near-invisible. No progress indicator, no timeout, no error recovery if spawn fails silently. Violates Doherty threshold.
- **Fix**: Use a visible pulsing indicator. Add 10s timeout with retry/diagnostic message. Increase to text-sm and opacity 0.6+.
- [ ] Fixed

#### `ChatView.tsx` -- ChatInput rendered 4 times with near-identical props
- **Severity**: High
- **Issue**: 4 separate ChatInput instances with only disabled/processing differences. Prop duplication and divergence risk.
- **Fix**: Extract a single `renderInput()` function or compute props object once. Use CSS (position:sticky for terminal, fixed-bottom for chat) to handle layout.
- [ ] Fixed

### CSS

#### `ChatView.css` -- No targeted prefers-reduced-motion
- **Severity**: High
- **Issue**: The global rule in App.css forces infinite animations to `0.01ms` which makes the blink cursor flash once and die. Each animation needs a sensible static fallback.
- **Fix**: Add targeted overrides: streaming cursor -> static block, pending status -> static yellow, msg-flash -> skip entirely.
- [ ] Fixed

#### `ChatView.css` / `ChatInput.css` -- Missing transitions on state changes
- **Severity**: High
- **Issue**: `.thinking-block.ended` snaps to opacity 0.5 with no transition. `.chat-input-container.processing .chat-input-textarea` snaps from 1.0 to 0.4. Both feel like rendering bugs.
- **Fix**: Add `transition: opacity 0.3s ease-out` to `.thinking-block`. Add `transition: opacity 0.2s ease-out` to `.chat-input-textarea`.
- [ ] Fixed

### React Performance

#### `ChatView.tsx:498,530` -- O(n) scan in render path
- **Severity**: High
- **Issue**: `messages.some(m => m.role === "permission" && !m.resolved)` evaluated on every render (twice). O(n) scan blocking rendering.
- **Fix**: Maintain `unresolvedPermissionCount` state variable, increment on permission events, decrement on resolution. O(1).
- [ ] Fixed

---

## Medium Issues

### React Performance

#### `ChatView.tsx` -- Duplicated streaming finalization (4x)
- **Issue**: Identical 7-line block in toolUse, inputRequired, thinking, result handlers.
- **Fix**: Extract `finalizeStreaming()` closure inside the useEffect.
- [ ] Fixed

#### `ChatView.tsx` -- Component complexity (11 useState + 10 useRef)
- **Issue**: God component managing agent lifecycle, messages, drag-drop, sidebar, scroll, rate limits, tokens, commands.
- **Fix**: Extract `useAgentLifecycle()`, `useDragDrop()`, `useAutoScroll()` hooks.
- [ ] Fixed

#### `RightSidebar` -- Re-renders on every streaming chunk
- **Issue**: Receives entire messages array (new reference per chunk). All sidebar panels re-render during streaming.
- **Fix**: Use `useDeferredValue(messages)` before passing to RightSidebar, or memoize derived data.
- [ ] Fixed

#### `MessageBubble.tsx` -- Eager import of react-syntax-highlighter (~200KB)
- **Issue**: Prism + all languages imported at top level even if no code blocks shown.
- **Fix**: Use `PrismLight` with only needed languages, or lazy-load CodeBlock component.
- [ ] Fixed

### Layout

#### `ChatView.tsx:442` -- Inline font-family violates CLAUDE.md constraint
- **Issue**: `style={{ fontFamily: var(--font-chat), fontSize: var(--text-chat) }}` -- component-level font-family declaration.
- **Fix**: Move to CSS rule on `.chat-view` with fallback: `font-size: var(--text-chat, var(--text-base))`. Remove inline style.
- [ ] Fixed

#### `ChatView.css` -- `--space-5` token doesn't exist
- **Issue**: `padding-left: var(--space-5)` on `.msg-bubble ul/ol` references undefined token. Falls back to browser default.
- **Fix**: Replace with `var(--space-4)` (16px).
- [ ] Fixed

#### `ChatView.css` -- Bottom bar font-size hardcoded 9px (3 places)
- **Issue**: Outside design token scale. Below minimum readable size on HiDPI.
- **Fix**: Use `var(--text-xs)` or define `--text-2xs: 9px` token.
- [ ] Fixed

#### `ChatView.css` -- Effort level in bottom bar nearly invisible
- **Issue**: opacity 0.6 on text-dim at 9px. Users who accidentally set low effort may not notice.
- **Fix**: Remove opacity reduction. Consider color coding: green=high, yellow=medium, red=low.
- [ ] Fixed

#### `ChatView.css` -- Inconsistent line-heights (1.4, 1.5, 1.6)
- **Issue**: `.chat-msg` is 1.4, textarea is 1.6, thinking-text is 1.5. Three values in one view.
- **Fix**: Standardize: 1.5 for body text, 1.4 for compact chrome.
- [ ] Fixed

#### `ChatInput.css` -- textarea max-height uses --text-base instead of --text-chat
- **Issue**: Chat view uses `--text-chat` but max-height calc references `--text-base`.
- **Fix**: Use `var(--text-chat, var(--text-base))` in the calc.
- [ ] Fixed

### Visual Polish

#### `ChatView.css` -- No message entrance animation
- **Issue**: Messages pop into DOM instantly. Biggest missed opportunity for feel.
- **Fix**: Use `@starting-style` (Chromium/Tauri supported): `.chat-msg { transition: opacity 0.2s ease-out, transform 0.2s ease-out; } @starting-style { .chat-msg { opacity: 0; transform: translateY(6px); } }`
- [ ] Fixed

#### `ChatView.css` -- 11 distinct opacity levels with no system
- **Issue**: Values scattered: 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7, 0.8.
- **Fix**: Consolidate to 4-5 tiers: ghost (0.2), muted (0.4), subdued (0.6), soft (0.8), full (1.0).
- [ ] Fixed

#### `ChatView.css` -- `.perm-btn` missing `:focus-visible`
- **Issue**: Permission buttons (critical actions) have no focus indicator for keyboard nav.
- **Fix**: Add `.perm-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }`.
- [ ] Fixed

#### `ChatView.css` -- Error messages lack visual weight
- **Issue**: `.chat-msg--error` is just red text with no background or border treatment. Tool output gets green border, code blocks get overlay0 border.
- **Fix**: Add `border-left: 2px solid color-mix(in srgb, var(--red) 30%, transparent); padding-left: var(--space-2);`
- [ ] Fixed

### UX

#### `ChatView.tsx` -- Input never appears if agent doesn't emit inputRequired
- **Issue**: On resume/fork, if agent is mid-turn, no input shows. User has no way to interact.
- **Fix**: After successful spawn, set inputState to "awaiting_input" as default post-launch state.
- [ ] Fixed

#### `ChatInput.tsx` -- Processing state has no context text
- **Issue**: Dimmed empty textarea with no indication of what's happening or how to interrupt.
- **Fix**: Show placeholder: "Claude is working... (Ctrl+C to interrupt)".
- [ ] Fixed

#### `SettingsModal.tsx` -- Font sections visually identical, confusing
- **Issue**: Terminal Font and Chat Font have same preview text, unclear which controls which.
- **Fix**: Add descriptions: "Used in terminal/xterm sessions" and "Used in chat message views".
- [ ] Fixed

---

## Low Issues

- Command menu appears/disappears instantly -- add slide-up animation
- Drop overlay has no fade entrance animation
- Command-item hover transition (0.05s) inconsistent with rest (0.1s)
- RightSidebar border-radius inconsistent with chat area (var(--radius-sm) vs 0)
- RightSidebar snaps open/closed with no transition
- Status messages (.chat-msg--status) nearly invisible at opacity 0.35
- Bottom bar 2px padding creates 13-14px bar height (below 24px minimum)
- Attach/send buttons 28px, off 8px grid
- msg-highlight outline may be clipped by overflow:hidden
- Ctrl+C kills entire session rather than interrupting current turn

---

## What's Working Well

- **Terminal aesthetic is cohesive**: border-radius: 0 everywhere, color-mix() for all opacity variants, prompt chevron prefix, collapsed tool cards
- **Streaming text accumulation**: Raw text during streaming, markdown only after finalization -- avoids O(n^2) re-parsing
- **StrictMode handling**: Deferred kill with pendingKillRef correctly prevents race conditions
- **Callback refs pattern**: Prevents stale closures in long-lived useEffect
- **color-mix() discipline**: Zero hardcoded rgba values, full theme compatibility
- **Permission card UX**: Clear pending/resolved states with color-coded buttons
- **Auto-scroll with near-bottom detection**: Doesn't force scroll when reading history
- **Drag-drop with counter tracking**: Correctly handles nested element events
- **Syntax highlighter theme caching**: Module-scope cache with MutationObserver invalidation
- **SDK command deduplication**: LOCAL_NAMES set prevents duplicate menu entries
- **Scroll listener passive: true**: Correct performance optimization
- **Functional state updates**: Used consistently, avoiding stale state bugs

---

## Action Plan

1. [ ] **Throttle streaming state updates** via rAF batch (Critical perf)
2. [ ] **Add ARIA landmarks**: `role="log" aria-live="polite"` on messages area (Critical a11y)
3. [ ] **Hoist inline closures** to useCallback for ChatInput memo (Critical perf)
4. [ ] **Extract `finalizeStreaming()` helper** -- eliminates 4x duplication (High)
5. [ ] **Add targeted prefers-reduced-motion** overrides per animation (High)
6. [ ] **Add transitions**: thinking-block collapse, textarea processing dim (High)
7. [ ] **Move font to CSS rule** on `.chat-view` instead of inline style (Medium)
8. [ ] **Fix `--space-5` reference** -- replace with `--space-4` (Medium)
9. [ ] **Extract hooks**: useAgentLifecycle, useDragDrop, useAutoScroll (Medium)
10. [ ] **Add message entrance animation** via @starting-style (Medium)
11. [ ] **Add focus-visible** to permission buttons and interactive elements (Medium)
12. [ ] **Use PrismLight** with selective language imports (Medium)
13. [ ] **Defer RightSidebar** with useDeferredValue (Medium)
