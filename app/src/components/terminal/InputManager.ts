/**
 * InputManager — handles all keyboard input in xterm.js.
 * Operates in 4 modes: normal, processing, permission, ask.
 */

import type { Terminal } from "@xterm/xterm";
import type { TerminalPalette } from "./themes";
import type { PermissionSuggestion, AskQuestionItem } from "../../types";
import { fg, BOLD, DIM, RESET, ICON, ERASE_LINE, ERASE_BELOW, ERASE_TO_END, cursorColumn, cursorUp, cursorDown, cursorBack, CURSOR_SAVE, CURSOR_RESTORE } from "./AnsiUtils";

export type InputMode = "normal" | "processing" | "ask" | "permission";

export interface InputManagerCallbacks {
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
  onPermissionRespond: (toolUseId: string, allow: boolean, suggestions?: PermissionSuggestion[]) => void;
  onAskRespond: (answers: Record<string, string>) => void;
  onAutocomplete: (input: string) => Promise<string[]>;
}

export class InputManager {
  private mode: InputMode = "processing"; // start as processing until inputRequired
  private buffer = "";
  private cursorPos = 0;
  private history: string[] = [];
  private historyIdx = -1;
  private historyStash = ""; // stash current buffer when browsing history

  // Permission state
  private permToolUseId = "";
  private permSuggestions?: PermissionSuggestion[];

  // Ask state
  private askQuestions: AskQuestionItem[] = [];
  private askStep = 0;
  private askAnswers: Record<string, string> = {};
  private askSelected = 0; // currently highlighted option

  // Spinner state
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private spinnerStartTime = 0;

  // Autocomplete state
  private completionInFlight = false;

  // Two-line spinner layout: spinner on line N, cursor on line N+1
  private spinnerOnScreen = false;

  // Output tracking — pauses spinner when output is happening
  private spinnerPauseTimer: ReturnType<typeof setTimeout> | null = null;
  private streamingActive = false;
  private thinkingActive = false;

  // Input line tracking — true when user's prompt line is rendered on screen during processing
  private inputLineOnScreen = false;

  // Wrapped-input tracking — how many physical terminal rows the input occupies
  private inputRows = 1;
  private inputCursorRow = 0; // which physical row (0-indexed) the terminal cursor is on

  // Disposables
  private disposables: { dispose(): void }[] = [];

  constructor(
    private terminal: Terminal,
    private palette: TerminalPalette,
    private callbacks: InputManagerCallbacks,
  ) {
    // Capture keyboard input
    this.disposables.push(
      terminal.onData((data) => this.handleData(data)),
      terminal.onKey(({ domEvent }) => this.handleKeyEvent(domEvent)),
    );
  }

  // ── Public API ──────────────────────────────────────────────────

  setMode(mode: InputMode): void {
    this.stopSpinner();
    // Clear any pending restart timer
    if (this.spinnerPauseTimer) {
      clearTimeout(this.spinnerPauseTimer);
      this.spinnerPauseTimer = null;
    }
    this.thinkingActive = false;
    this.inputLineOnScreen = false;
    this.inputRows = 1;
    this.inputCursorRow = 0;
    this.mode = mode;
    if (mode === "normal") {
      this.renderPrompt();
    } else if (mode === "processing") {
      this.startSpinner();
    }
  }

  getMode(): InputMode {
    return this.mode;
  }

  /** Set up permission mode with the tool/suggestions context */
  enterPermissionMode(toolUseId: string, suggestions?: PermissionSuggestion[]): void {
    this.permToolUseId = toolUseId;
    this.permSuggestions = suggestions;
    this.setMode("permission");
  }

  /** Set up ask mode with the questions */
  enterAskMode(questions: AskQuestionItem[]): void {
    this.askQuestions = questions;
    this.askStep = 0;
    this.askAnswers = {};
    this.askSelected = 0;
    this.buffer = "";
    this.cursorPos = 0;
    this.setMode("ask");
    this.renderAskHint();
  }

  /** Reset input tracking state after terminal clear (fullRedraw/resize) */
  resetInputTracking(): void {
    this.inputLineOnScreen = false;
    this.inputRows = 1;
    this.inputCursorRow = 0;
  }

  /** Whether user-typed input is currently visible on screen */
  hasInputOnScreen(): boolean {
    return this.inputLineOnScreen && this.buffer.length > 0;
  }

  updatePalette(palette: TerminalPalette): void {
    this.palette = palette;
  }

  /** Called by TerminalRenderer to track streaming state */
  setStreamingActive(active: boolean): void {
    this.streamingActive = active;
    if (active) {
      // Ensure spinner is stopped during streaming
      this.stopSpinner();
    }
  }

  /** Called by TerminalRenderer when thinking block appears/ends */
  setThinkingActive(active: boolean): void {
    this.thinkingActive = active;
    if (active && this.spinnerInterval) {
      this.stopSpinner();
    }
  }

  /**
   * Call this whenever the renderer is about to write output.
   * Pauses the spinner so it doesn't conflict with streaming text.
   * Spinner auto-resumes after 600ms of silence (only if not streaming/thinking).
   */
  notifyOutput(): void {
    if (this.mode !== "processing") return;
    // Always stop the spinner if it's running — clear the line for incoming output
    if (this.spinnerInterval) {
      this.stopSpinner();
    }
    if (this.spinnerPauseTimer) clearTimeout(this.spinnerPauseTimer);
    this.spinnerPauseTimer = setTimeout(() => {
      this.spinnerPauseTimer = null;
      // Don't restart spinner if streaming/thinking is active or user is typing
      if (this.mode === "processing" && !this.streamingActive && !this.thinkingActive && this.buffer.length === 0) {
        this.startSpinner();
      }
    }, 600);
  }

  /**
   * Temporarily remove the user's input line from the terminal so the renderer
   * can write output without interleaving. Returns true if an input line was cleared.
   */
  suspendInputLine(): boolean {
    if (!this.inputLineOnScreen || this.buffer.length === 0) return false;
    this.eraseInput();
    this.inputLineOnScreen = false;
    return true;
  }

  /**
   * Re-render the user's input line after the renderer wrote output.
   * Only call after suspendInputLine() returned true.
   */
  resumeInputLine(): void {
    if (this.buffer.length === 0 || this.mode !== "processing") return;
    this.writeInputLine();
    this.positionInputCursor();
    this.inputLineOnScreen = true;
  }

  dispose(): void {
    this.stopSpinner();
    if (this.spinnerPauseTimer) {
      clearTimeout(this.spinnerPauseTimer);
      this.spinnerPauseTimer = null;
    }
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  // ── Data handler (printable chars, paste, special sequences) ────

  private handleData(data: string): void {
    switch (this.mode) {
      case "normal":
        this.handleNormalData(data);
        break;
      case "processing":
        // Allow typing to queue messages while agent is working
        this.handleNormalData(data);
        break;
      case "permission":
        this.handlePermissionData(data);
        break;
      case "ask":
        this.handleAskData(data);
        break;
    }
  }

  /** Key events for special keys that onData doesn't provide cleanly */
  private handleKeyEvent(e: KeyboardEvent): void {
    // Ctrl+C in any mode
    if (e.ctrlKey && e.key === "c") {
      e.preventDefault();
      if ((this.mode === "normal" || this.mode === "processing") && this.buffer.length > 0) {
        // During streaming, only clear buffer — don't touch terminal
        if (this.streamingActive && this.mode === "processing") {
          this.buffer = "";
          this.cursorPos = 0;
          this.inputLineOnScreen = false;
          this.inputRows = 1;
          this.inputCursorRow = 0;
          return;
        }
        if (this.mode === "processing") {
          // Erase wrapped input, go back to spinner
          this.eraseInput();
          this.buffer = "";
          this.cursorPos = 0;
          this.inputLineOnScreen = false;
          this.startSpinner();
        } else {
          // Normal mode: move to end of wrapped text, then new line + prompt
          const endRow = this.inputRows - 1;
          if (this.inputCursorRow < endRow) {
            this.terminal.write(cursorDown(endRow - this.inputCursorRow));
          }
          this.buffer = "";
          this.cursorPos = 0;
          this.inputRows = 1;
          this.inputCursorRow = 0;
          this.terminal.write("\r\n");
          this.renderPrompt();
        }
      } else if (this.mode === "processing" || (this.mode === "normal" && this.buffer.length === 0)) {
        this.callbacks.onInterrupt();
      }
      return;
    }
  }

  // ── Normal mode ─────────────────────────────────────────────────

  private handleNormalData(data: string): void {
    // Special sequences
    if (data === "\r" || data === "\n") {
      // Enter — submit
      this.submit();
      return;
    }

    if (data === "\x7f" || data === "\b") {
      // Backspace
      this.backspace();
      return;
    }

    if (data === "\x1b[3~") {
      // Delete key
      this.deleteChar();
      return;
    }

    if (data === "\x1b[D") {
      // Left arrow
      this.moveCursor(-1);
      return;
    }

    if (data === "\x1b[C") {
      // Right arrow
      this.moveCursor(1);
      return;
    }

    if (data === "\x1b[A") {
      // Up arrow — history
      this.historyPrev();
      return;
    }

    if (data === "\x1b[B") {
      // Down arrow — history
      this.historyNext();
      return;
    }

    if (data === "\x1b[H" || data === "\x01") {
      // Home or Ctrl+A
      this.moveCursorTo(0);
      return;
    }

    if (data === "\x1b[F" || data === "\x05") {
      // End or Ctrl+E
      this.moveCursorTo(this.buffer.length);
      return;
    }

    if (data === "\x0b") {
      // Ctrl+K — kill to end of line
      this.buffer = this.buffer.slice(0, this.cursorPos);
      if (this.streamingActive && this.mode === "processing") return; // buffer-only during streaming
      if (this.mode === "processing" && this.buffer.length === 0) {
        this.eraseInput();
        this.inputLineOnScreen = false;
        this.startSpinner();
        return;
      }
      // Fast path: single-line — just erase from cursor to end
      if (this.inputRows <= 1) {
        this.terminal.write(ERASE_TO_END);
        return;
      }
      this.redrawLine();
      return;
    }

    if (data === "\x15") {
      // Ctrl+U — clear line
      if (this.streamingActive && this.mode === "processing") {
        this.buffer = "";
        this.cursorPos = 0;
        this.inputRows = 1;
        this.inputCursorRow = 0;
        return; // buffer-only during streaming
      }
      if (this.mode === "processing") {
        this.eraseInput();
        this.buffer = "";
        this.cursorPos = 0;
        this.inputLineOnScreen = false;
        this.startSpinner();
        return;
      }
      this.buffer = "";
      this.cursorPos = 0;
      this.redrawLine();
      return;
    }

    if (data === "\x17") {
      // Ctrl+W — delete word backwards
      this.deleteWordBack();
      return;
    }

    if (data === "\t") {
      // Tab — autocomplete
      this.handleTab();
      return;
    }

    // Filter control characters (Ctrl+C \x03, etc.)
    if (data.charCodeAt(0) < 0x20 && data.length === 1) return;

    // Ignore escape sequences
    if (data.startsWith("\x1b")) return;

    // Strip embedded ANSI escapes from pasted text, flatten multiline to single line
    const clean = data.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[78]|\x1b/g, "")
      .replace(/\r\n|\r|\n/g, " ") // flatten multiline paste (matches native CLI behavior)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""); // strip non-printable control chars
    if (!clean) return;

    this.insertText(clean);
  }

  private submit(): void {
    const text = this.buffer.trim();
    this.buffer = "";
    this.cursorPos = 0;
    this.historyIdx = -1;
    this.inputLineOnScreen = false;
    this.inputRows = 1;
    this.inputCursorRow = 0;

    // During streaming, submit silently — don't write to terminal or start spinner
    if (this.streamingActive && this.mode === "processing") {
      if (text) {
        if (this.history.length === 0 || this.history[this.history.length - 1] !== text) {
          this.history.push(text);
          if (this.history.length > 100) this.history.shift();
        }
        this.callbacks.onSubmit(text);
      }
      return;
    }

    this.terminal.write("\r\n");
    if (text) {
      // Add to history (avoid duplicates at top)
      if (this.history.length === 0 || this.history[this.history.length - 1] !== text) {
        this.history.push(text);
        if (this.history.length > 100) this.history.shift();
      }
      const wasProcessing = this.mode === "processing";
      if (!wasProcessing) {
        this.setMode("processing");
      } else {
        // Queuing while agent is working — restart spinner
        this.startSpinner();
      }
      this.callbacks.onSubmit(text);
    }
  }

  private insertText(text: string): void {
    // During streaming, only buffer — don't echo to terminal.
    // The renderer will restore the input line when streaming ends.
    if (this.streamingActive && this.mode === "processing") {
      this.buffer = this.buffer.slice(0, this.cursorPos) + text + this.buffer.slice(this.cursorPos);
      this.cursorPos += text.length;
      return;
    }

    // If typing while processing, pause spinner and show prompt.
    if (this.mode === "processing" && this.buffer.length === 0) {
      this.stopSpinner();
      // After stopSpinner, cursor is always on a blank line (the cleared spinner row,
      // or a line left after stream/block output + \r\n). No extra \r\n needed.
      this.inputRows = 1;
      this.inputCursorRow = 0;
    } else {
      // Fast path: single-line input that stays single-line — no erase/redraw flicker
      // Guard: only for ASCII — CJK/fullwidth chars occupy 2 terminal columns but
      // have .length === 1, so the width check would be wrong and cause display corruption.
      const cols = this.terminal.cols || 80;
      const newLen = 2 + this.buffer.length + text.length; // "❯ " = 2 visible chars
      const asciiOnly = !/[^\x20-\x7e]/.test(text) && !/[^\x20-\x7e]/.test(this.buffer);
      if (asciiOnly && this.inputRows <= 1 && newLen < cols) {
        if (this.cursorPos === this.buffer.length) {
          // Append at end — just write the new chars
          this.buffer += text;
          this.cursorPos += text.length;
          this.terminal.write(text);
        } else {
          // Middle insert — write inserted text + remainder, erase leftover
          const tail = this.buffer.slice(this.cursorPos);
          this.buffer = this.buffer.slice(0, this.cursorPos) + text + tail;
          this.cursorPos += text.length;
          this.terminal.write(text + tail + ERASE_TO_END + (tail.length > 0 ? cursorBack(tail.length) : ""));
        }
        if (this.mode === "processing") this.inputLineOnScreen = true;
        return;
      }
      // Slow path: erase and full redraw (wrapped lines or about to wrap)
      this.eraseInput();
    }

    this.buffer = this.buffer.slice(0, this.cursorPos) + text + this.buffer.slice(this.cursorPos);
    this.cursorPos += text.length;
    this.writeInputLine();
    this.positionInputCursor();
    if (this.mode === "processing") {
      this.inputLineOnScreen = true;
    }
  }

  private backspace(): void {
    if (this.cursorPos <= 0) return;
    const wasAtEnd = this.cursorPos === this.buffer.length;
    this.buffer = this.buffer.slice(0, this.cursorPos - 1) + this.buffer.slice(this.cursorPos);
    this.cursorPos--;
    if (this.streamingActive && this.mode === "processing") return; // buffer-only during streaming
    if (this.mode === "processing" && this.buffer.length === 0) {
      // Cleared all text while processing — erase wrapped input, restart spinner
      this.eraseInput();
      this.inputLineOnScreen = false;
      this.startSpinner();
      return;
    }
    // Fast path: single-line ASCII — wide chars need full redraw for correct cursor math
    if (this.inputRows <= 1 && !/[^\x20-\x7e]/.test(this.buffer)) {
      if (wasAtEnd) {
        // Delete at end — erase last visible char
        this.terminal.write("\b \b");
      } else {
        // Delete in middle — rewrite from cursor, erase trailing char
        const tail = this.buffer.slice(this.cursorPos);
        this.terminal.write("\b" + tail + ERASE_TO_END + (tail.length > 0 ? cursorBack(tail.length) : ""));
      }
      return;
    }
    this.redrawLine();
  }

  private deleteChar(): void {
    if (this.cursorPos >= this.buffer.length) return;
    this.buffer = this.buffer.slice(0, this.cursorPos) + this.buffer.slice(this.cursorPos + 1);
    if (this.streamingActive && this.mode === "processing") return; // buffer-only during streaming
    if (this.mode === "processing" && this.buffer.length === 0) {
      this.eraseInput();
      this.inputLineOnScreen = false;
      this.startSpinner();
      return;
    }
    // Fast path: single-line ASCII — wide chars need full redraw for correct cursor math
    if (this.inputRows <= 1 && !/[^\x20-\x7e]/.test(this.buffer)) {
      const tail = this.buffer.slice(this.cursorPos);
      this.terminal.write(tail + ERASE_TO_END + (tail.length > 0 ? cursorBack(tail.length) : ""));
      return;
    }
    this.redrawLine();
  }

  private deleteWordBack(): void {
    if (this.cursorPos <= 0) return;
    let pos = this.cursorPos - 1;
    // Skip trailing spaces
    while (pos > 0 && this.buffer[pos] === " ") pos--;
    // Skip word chars
    while (pos > 0 && this.buffer[pos - 1] !== " ") pos--;
    this.buffer = this.buffer.slice(0, pos) + this.buffer.slice(this.cursorPos);
    this.cursorPos = pos;
    if (this.streamingActive && this.mode === "processing") return; // buffer-only during streaming
    if (this.mode === "processing" && this.buffer.length === 0) {
      this.eraseInput();
      this.inputLineOnScreen = false;
      this.startSpinner();
      return;
    }
    this.redrawLine();
  }

  private moveCursor(delta: number): void {
    const newPos = Math.max(0, Math.min(this.buffer.length, this.cursorPos + delta));
    if (newPos !== this.cursorPos) {
      this.cursorPos = newPos;
      if (!(this.streamingActive && this.mode === "processing")) {
        if (this.inputRows > 1) {
          // Wrapped input — redraw to reposition cursor across rows
          this.redrawLine();
        } else {
          this.terminal.write(cursorColumn(this.cursorPos + 3)); // +3 for "❯ " prompt (2 chars + 1-based column)
        }
      }
    }
  }

  private moveCursorTo(pos: number): void {
    this.cursorPos = Math.max(0, Math.min(this.buffer.length, pos));
    if (!(this.streamingActive && this.mode === "processing")) {
      if (this.inputRows > 1) {
        this.redrawLine();
      } else {
        this.terminal.write(cursorColumn(this.cursorPos + 3));
      }
    }
  }

  private historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.streamingActive && this.mode === "processing") return; // no history during streaming
    if (this.historyIdx === -1) {
      this.historyStash = this.buffer;
      this.historyIdx = this.history.length - 1;
    } else if (this.historyIdx > 0) {
      this.historyIdx--;
    } else {
      return;
    }
    this.buffer = this.history[this.historyIdx];
    this.cursorPos = this.buffer.length;
    this.redrawLine();
  }

  private historyNext(): void {
    if (this.historyIdx === -1) return;
    if (this.streamingActive && this.mode === "processing") return; // no history during streaming
    if (this.historyIdx < this.history.length - 1) {
      this.historyIdx++;
      this.buffer = this.history[this.historyIdx];
    } else {
      this.historyIdx = -1;
      this.buffer = this.historyStash;
    }
    this.cursorPos = this.buffer.length;
    this.redrawLine();
  }

  private async handleTab(): Promise<void> {
    if (this.completionInFlight) return;
    const input = this.buffer.slice(0, this.cursorPos);
    if (!input.trim()) return;

    // Extract the last token (after last space)
    const lastSpace = input.lastIndexOf(" ");
    const token = lastSpace >= 0 ? input.slice(lastSpace + 1) : input;
    if (!token) return;

    // Snapshot buffer state to detect changes during async await
    const snapshotBuffer = this.buffer;
    const snapshotCursor = this.cursorPos;

    this.completionInFlight = true;
    try {
      const suggestions = await this.callbacks.onAutocomplete(token);
      // Bail if buffer changed while waiting, or streaming started during await
      if (this.buffer !== snapshotBuffer || this.cursorPos !== snapshotCursor) return;
      if (this.streamingActive && this.mode === "processing") return;
      if (suggestions.length === 0) return;
      if (suggestions.length === 1) {
        // Single match — complete inline
        const completion = suggestions[0].slice(token.length);
        this.insertText(completion);
      } else {
        // Multiple matches — show below prompt, then re-render prompt below suggestions
        // Reset row tracking: old prompt scrolls into history, cursor is on a fresh line
        this.inputRows = 1;
        this.inputCursorRow = 0;
        this.terminal.write("\r\n");
        const cols = this.terminal.cols;
        const maxLen = Math.max(...suggestions.map(s => s.length)) + 2;
        const perRow = Math.max(1, Math.floor(cols / maxLen));
        for (let i = 0; i < suggestions.length; i++) {
          this.terminal.write(`${DIM}${suggestions[i].padEnd(maxLen)}${RESET}`);
          if ((i + 1) % perRow === 0 && i + 1 < suggestions.length) {
            this.terminal.write("\r\n");
          }
        }
        this.terminal.write("\r\n");
        // Find common prefix for partial completion
        const common = commonPrefix(suggestions);
        if (common.length > token.length) {
          this.inputRows = 1;
          this.inputCursorRow = 0;
          this.insertText(common.slice(token.length));
        } else {
          this.renderPrompt();
        }
      }
    } catch {
      // Autocomplete failed silently
    } finally {
      this.completionInFlight = false;
    }
  }

  // ── Prompt rendering ────────────────────────────────────────────

  renderPrompt(): void {
    this.eraseInput();
    this.writeInputLine();
    this.positionInputCursor();
  }

  private redrawLine(): void {
    if (this.streamingActive && this.mode === "processing") return; // suppress during streaming
    this.eraseInput();
    this.writeInputLine();
    this.positionInputCursor();
    if (this.mode === "processing") {
      this.inputLineOnScreen = true;
    }
  }

  /** Erase all physical rows the current input occupies (handles wrapped text) */
  private eraseInput(): void {
    if (this.inputCursorRow > 0) {
      this.terminal.write(cursorUp(this.inputCursorRow));
    }
    this.terminal.write(`\r${ERASE_BELOW}`);
    this.inputRows = 1;
    this.inputCursorRow = 0;
  }

  /** Write prompt + buffer to the terminal and update row tracking */
  private writeInputLine(): void {
    const prompt = `${fg(this.palette.accent)}${BOLD}${ICON.prompt}${RESET} `;
    this.terminal.write(`${prompt}${this.buffer}`);
    const cols = this.terminal.cols || 80;
    const N = 2 + this.buffer.length; // "❯ " = 2 visible chars
    this.inputRows = Math.max(1, Math.ceil(N / cols));
    // After writing N chars, cursor row depends on whether N fills the row exactly
    // When N is an exact multiple of cols, xterm wraps cursor to column 0 of next row
    this.inputCursorRow = N > 0 && N % cols === 0 ? N / cols : Math.floor(N / cols);
    // Ensure inputRows accounts for cursor-wrap row
    if (this.inputCursorRow >= this.inputRows) {
      this.inputRows = this.inputCursorRow + 1;
    }
  }

  /** Position cursor within wrapped input (after writeInputLine) */
  private positionInputCursor(): void {
    if (this.cursorPos >= this.buffer.length) return; // already at end
    const cols = this.terminal.cols || 80;
    const targetRow = Math.floor((2 + this.cursorPos) / cols);
    const rowsUp = this.inputCursorRow - targetRow;
    if (rowsUp > 0) this.terminal.write(cursorUp(rowsUp));
    this.terminal.write(cursorColumn(((2 + this.cursorPos) % cols) + 1));
    this.inputCursorRow = targetRow;
  }

  // ── Processing mode (spinner) ───────────────────────────────────

  private startSpinner(): void {
    // Clear any existing spinner to prevent stacking
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
    this.spinnerOnScreen = false;
    if (this.spinnerPauseTimer) {
      clearTimeout(this.spinnerPauseTimer);
      this.spinnerPauseTimer = null;
    }
    this.spinnerFrame = 0;
    this.spinnerStartTime = Date.now();
    this.renderSpinner();
    this.spinnerInterval = setInterval(() => {
      if (this.spinnerInterval === null) return; // stale callback guard
      this.spinnerFrame = (this.spinnerFrame + 1) % ICON.spinner.length;
      this.renderSpinner();
    }, 100);
  }

  private renderSpinner(): void {
    const elapsed = Math.floor((Date.now() - this.spinnerStartTime) / 1000);
    const frame = ICON.spinner[this.spinnerFrame];
    const spinnerLine = `\r${ERASE_LINE}  ${fg(this.palette.accent)}${frame}${RESET} ${DIM}Working... ${elapsed}s${RESET}`;

    if (this.spinnerOnScreen) {
      // Cursor is on the line BELOW the spinner — go up, update, come back
      this.terminal.write(CURSOR_SAVE + cursorUp(1) + spinnerLine + CURSOR_RESTORE);
    } else {
      // First frame: write spinner, move cursor to line below
      this.terminal.write(spinnerLine + "\r\n");
      this.spinnerOnScreen = true;
    }
  }

  private stopSpinner(): void {
    const wasRunning = this.spinnerInterval !== null;
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
    if (this.spinnerOnScreen) {
      // Cursor is on line below spinner. Move up to spinner line, then erase
      // from there to end of display — clears both spinner and cursor line
      // without leaving empty rows in the terminal buffer.
      this.terminal.write(cursorUp(1) + `\r${ERASE_BELOW}`);
      this.spinnerOnScreen = false;
    } else if (wasRunning) {
      // Spinner was on current line but never moved to two-line layout — just clear
      this.terminal.write(`\r${ERASE_BELOW}`);
    }
  }

  // ── Permission mode ─────────────────────────────────────────────

  private handlePermissionData(data: string): void {
    const key = data.toLowerCase();
    if (key === "y" || data === "\r") {
      this.callbacks.onPermissionRespond(this.permToolUseId, true);
      this.setMode("processing");
    } else if (key === "n" || data === "\x1b") {
      this.callbacks.onPermissionRespond(this.permToolUseId, false);
      this.setMode("processing");
    } else if (key === "a" && this.permSuggestions?.length) {
      this.callbacks.onPermissionRespond(this.permToolUseId, true, this.permSuggestions);
      this.setMode("processing");
    }
  }

  // ── Ask mode ────────────────────────────────────────────────────

  private renderAskHint(): void {
    const q = this.askQuestions[this.askStep];
    if (!q) return;
    if (q.options.length > 0) {
      const maxKey = Math.min(q.options.length, 9);
      const extra = q.options.length > 9 ? ", arrows for more" : "";
      const hint = `  ${DIM}Press 1-${maxKey} to select${extra}, Enter to confirm${RESET}`;
      this.terminal.write(hint);
    } else {
      // Free-text question — show input prompt
      const prompt = `${fg(this.palette.accent)}${BOLD}${ICON.prompt}${RESET} `;
      this.terminal.write(`\r\n${prompt}`);
    }
  }

  private handleAskData(data: string): void {
    const q = this.askQuestions[this.askStep];
    if (!q) return;

    // Free-text question (no options) — allow typing
    if (q.options.length === 0) {
      if (data === "\r" || data === "\n") {
        const text = this.buffer.trim();
        if (!text) return; // Don't submit empty answer
        this.askAnswers[String(this.askStep)] = text;
        this.terminal.write("\r\n");
        this.buffer = "";
        this.cursorPos = 0;
        this.advanceAskStep();
        return;
      }
      if (data === "\x7f" || data === "\b") {
        if (this.cursorPos > 0) {
          this.buffer = this.buffer.slice(0, this.cursorPos - 1) + this.buffer.slice(this.cursorPos);
          this.cursorPos--;
          this.redrawLine();
        }
        return;
      }
      // Filter control chars and escape sequences
      if (data.charCodeAt(0) < 0x20 && data.length === 1) return;
      if (data.startsWith("\x1b")) return;
      const clean = data.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[78]|\x1b/g, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
      if (!clean) return;
      this.insertText(clean);
      return;
    }

    // Number keys select option
    const num = parseInt(data, 10);
    if (num >= 1 && num <= q.options.length) {
      this.askSelected = num - 1;
      this.askAnswers[String(this.askStep)] = q.options[this.askSelected].label;
      this.advanceAskStep();
      return;
    }

    // Enter confirms current selection
    if (data === "\r" || data === "\n") {
      this.askAnswers[String(this.askStep)] = q.options[this.askSelected].label;
      this.advanceAskStep();
      return;
    }

    // Arrow keys navigate options
    if (data === "\x1b[A" && this.askSelected > 0) {
      this.askSelected--;
      return;
    }
    if (data === "\x1b[B" && this.askSelected < q.options.length - 1) {
      this.askSelected++;
      return;
    }
  }

  private advanceAskStep(): void {
    this.askStep++;
    if (this.askStep >= this.askQuestions.length) {
      // All questions answered
      this.callbacks.onAskRespond(this.askAnswers);
      this.setMode("processing");
    } else {
      this.askSelected = 0;
      this.buffer = "";
      this.cursorPos = 0;
      this.renderAskHint();
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function commonPrefix(strings: string[]): string {
  if (strings.length === 0) return "";
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return "";
    }
  }
  return prefix;
}
