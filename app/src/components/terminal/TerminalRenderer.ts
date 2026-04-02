/**
 * TerminalRenderer — writes Block content to xterm.js.
 * Handles appending new blocks, in-place updates, streaming, and full redraws.
 *
 * Streaming safety: while a streaming block is active, in-place updates are
 * deferred and the spinner is suppressed, because cursor positioning is
 * unreliable (totalLines doesn't track streamed text).
 */

import type { Terminal } from "@xterm/xterm";
import type { Block } from "./blocks/Block";
import type { UserBlock } from "./blocks/UserBlock";
import type { ToolBlock } from "./blocks/ToolBlock";
import type { TerminalDocument, DocumentEvent } from "./TerminalDocument";
import type { TerminalPalette } from "./themes";
import type { InputManager } from "./InputManager";
import { CURSOR_SAVE, CURSOR_RESTORE, cursorUp, ERASE_LINE, sanitizeAgentText } from "./AnsiUtils";

export class TerminalRenderer {
  private cols: number;
  private rows: number;
  private unsubscribe: (() => void) | null = null;
  private inputManager: InputManager | null = null;
  /** True while a streaming assistant block is active */
  private streamingActive = false;
  /** Blocks whose updates were deferred during streaming */
  private deferredUpdates: Block[] = [];
  /** Whether the last streamed chunk ended with a newline */
  private lastStreamedEndedWithNewline = false;
  /** Whether ephemeral content was suspended at streaming start */
  private suspendedForStreaming = false;
  /** Approximate response length for token estimation (responseLength / 4 ≈ tokens) */
  private responseLength = 0;

  constructor(
    private terminal: Terminal,
    private document: TerminalDocument,
    private palette: TerminalPalette,
  ) {
    this.cols = terminal.cols;
    this.rows = terminal.rows;
    this.subscribe();
  }

  // ── InputManager link ─────────────────────────────────────────

  setInputManager(im: InputManager): void {
    this.inputManager = im;
  }

  // ── Palette management ──────────────────────────────────────────

  updatePalette(palette: TerminalPalette): void {
    this.palette = palette;
  }

  // ── Event subscription ──────────────────────────────────────────

  private subscribe(): void {
    this.unsubscribe = this.document.subscribe((event) => {
      this.handleDocumentEvent(event);
    });
  }

  private handleDocumentEvent(event: DocumentEvent): void {
    switch (event.type) {
      case "blockAdded":
        this.onBlockAdded(event.block);
        break;
      case "blockUpdated":
        this.onBlockUpdated(event.block);
        break;
      case "streamAppend":
        this.writeStreaming(event.text);
        break;
      case "streamEnd":
        this.onStreamEnd();
        break;
      case "thinkingAppend":
        // No terminal update — thinking text is shown in the sidebar panel.
        // The spinner verb ("Thinking...") is already set when thinking starts.
        break;
      case "cleared":
        this.terminal.clear();
        this.terminal.write("\x1b[H\x1b[2J");
        break;
    }
  }

  // ── Block rendering ─────────────────────────────────────────────

  private onBlockAdded(block: Block): void {
    // Live user input already echoed by InputManager — just track it, no output written
    if (block.type === "user" && !(block as UserBlock).fromHistory) {
      const content = block.render(this.cols, this.palette);
      const visualLines = (content.match(/\r\n/g) || []).length || 1;
      this.document.commitBlockLines(block, visualLines);
      return;
    }

    // Suspend spinner + input before writing output
    this.inputManager?.suspendAll();
    this.inputManager?.notifyOutput();

    // Update spinner verb based on block type
    if (block.type === "tool" || block.type === "diff") {
      const toolName = (block as ToolBlock).tool;
      const input = (block as ToolBlock).input as Record<string, unknown> | null;
      const filePath = input?.file_path || input?.path || "";
      if (filePath) {
        const basename = String(filePath).split(/[/\\]/).pop() || "";
        this.inputManager?.setSpinnerVerb(`${toolName}: ${basename}`);
      } else {
        this.inputManager?.setSpinnerVerb(toolName);
      }
    }

    // Streaming assistant block: don't render yet, text comes via streamAppend
    if (block.type === "assistant" && (block as { streaming?: boolean }).streaming) {
      this.streamingActive = true;
      this.responseLength = 0;
      this.inputManager?.setStreamingActive(true);
      this.inputManager?.setSpinnerVerb("Responding...");
      this.document.commitBlockLines(block, 0);
      this.suspendedForStreaming = true;
      return;
    }

    this.renderBlock(block);
    this.inputManager?.resumeAll();
  }

  private renderBlock(block: Block): void {
    // Add visual spacing before user prompts (start of a new turn)
    const addSpacing = block.type === "user" && this.document.getBlockCount() > 1;
    if (addSpacing) {
      this.terminal.write("\r\n");
    }

    const content = block.render(this.cols, this.palette);
    this.terminal.write(content);
    const lineCount = (content.match(/\r\n/g) || []).length + (addSpacing ? 1 : 0);
    this.document.commitBlockLines(block, lineCount);
  }

  /** Handle block update — defer if streaming is active */
  private onBlockUpdated(block: Block): void {
    // Skip blocks that were never rendered (lineCount stays 0 until first render).
    if (block.frozen || block.lineCount === 0) return;

    if (this.streamingActive) {
      this.inputManager?.notifyOutput();
      if (!this.deferredUpdates.includes(block)) {
        this.deferredUpdates.push(block);
      }
      return;
    }

    // After tool result, reset verb to "Thinking..."
    if ((block.type === "tool" || block.type === "diff") &&
        (block as ToolBlock).status !== "pending") {
      this.inputManager?.setSpinnerVerb("Thinking...");
    }

    this.inputManager?.suspendAll();
    this.inputManager?.notifyOutput();
    this.updateBlock(block);
    this.inputManager?.resumeAll();
  }

  /** In-place update of an existing block (if still in viewport) */
  private updateBlock(block: Block): void {
    if (block.frozen) return;

    const totalLines = this.document.getTotalLines();
    const blockEnd = block.startLine + block.lineCount;
    const linesFromBottom = totalLines - blockEnd;

    if (linesFromBottom > this.rows * 2) {
      block.frozen = true;
      return;
    }

    const oldLineCount = block.lineCount;
    if (oldLineCount === 0) return;

    const newContent = block.render(this.cols, this.palette);
    const newLineCount = (newContent.match(/\r\n/g) || []).length;

    if (newLineCount !== oldLineCount) {
      this.redrawFrom(block);
      return;
    }

    this.terminal.write(CURSOR_SAVE);
    const linesToMoveUp = linesFromBottom + oldLineCount;
    if (linesToMoveUp > 0) {
      this.terminal.write(cursorUp(linesToMoveUp));
    }
    for (let i = 0; i < oldLineCount; i++) {
      this.terminal.write(`${ERASE_LINE}\r\n`);
    }
    if (oldLineCount > 0) {
      this.terminal.write(cursorUp(oldLineCount));
    }
    this.terminal.write(newContent);
    this.document.commitBlockLines(block, newLineCount);
    this.terminal.write(CURSOR_RESTORE);
  }

  /** Redraw from a specific block onwards (when line count changes) */
  private redrawFrom(startBlock: Block): void {
    const blocks = this.document.getBlocks();
    let startIdx = -1;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].id === startBlock.id) { startIdx = i; break; }
    }
    if (startIdx < 0) return;

    const totalLines = this.document.getTotalLines();
    const linesToErase = totalLines - startBlock.startLine;

    if (linesToErase > 0) {
      this.terminal.write(cursorUp(linesToErase));
    }
    for (let i = 0; i < linesToErase; i++) {
      this.terminal.write(`${ERASE_LINE}\r\n`);
    }
    if (linesToErase > 0) {
      this.terminal.write(cursorUp(linesToErase));
    }

    let currentLine = startBlock.startLine;
    for (let i = startIdx; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.type === "user" && i > 0) {
        this.terminal.write("\r\n");
        currentLine++;
      }
      b.startLine = currentLine;
      b.frozen = false;
      const content = b.render(this.cols, this.palette);
      this.terminal.write(content);
      const lineCount = (content.match(/\r\n/g) || []).length;
      this.document.commitBlockLines(b, lineCount);
      currentLine += lineCount;
    }
  }

  /** Write streaming text directly to terminal (sanitized) */
  private writeStreaming(text: string): void {
    this.inputManager?.notifyOutput();
    const sanitized = sanitizeAgentText(text);
    // Trim trailing whitespace per line; strip leading newlines on first chunk
    let trimmed = sanitized.replace(/[ \t]+$/gm, "");
    if (this.responseLength === 0) {
      trimmed = trimmed.replace(/^\n+/, "");
    }
    const xtermText = trimmed.replace(/\n/g, "\r\n");
    this.terminal.write(xtermText);
    this.lastStreamedEndedWithNewline = trimmed.endsWith("\n");
    // Track response length for token estimation (length/4 ≈ tokens)
    this.responseLength += text.length;
    this.inputManager?.setTokenCount(Math.round(this.responseLength / 4));
  }

  /** Called when streaming ends */
  private onStreamEnd(): void {
    this.streamingActive = false;
    this.inputManager?.setStreamingActive(false);
    this.inputManager?.setSpinnerVerb("Thinking...");

    if (!this.lastStreamedEndedWithNewline) {
      this.terminal.write("\r\n");
    }
    this.lastStreamedEndedWithNewline = false;

    // Fix up line count for the streaming block (was committed as 0 at start)
    const blocks = this.document.getBlocks();
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].type === "assistant") {
        const content = blocks[i].render(this.cols, this.palette);
        const lineCount = (content.match(/\r\n/g) || []).length;
        this.document.commitBlockLines(blocks[i], lineCount);
        break;
      }
    }

    // Flush deferred updates
    const deferred = this.deferredUpdates.splice(0);
    for (const block of deferred) {
      this.updateBlock(block);
    }

    // Resume spinner + input
    if (this.suspendedForStreaming) {
      this.suspendedForStreaming = false;
      this.inputManager?.resumeAll();
    }
  }

  // ── Full redraw ─────────────────────────────────────────────────

  fullRedraw(): void {
    if (this.streamingActive) {
      this.document.forceFinalize();
      this.streamingActive = false;
      this.suspendedForStreaming = false;
      this.inputManager?.setStreamingActive(false);
      this.deferredUpdates = [];
    }

    // Stop spinner interval to prevent writes during redraw
    this.inputManager?.suspendAll();
    this.inputManager?.resetInputTracking();
    this.terminal.clear();
    this.terminal.write("\x1b[H\x1b[2J");

    let currentLine = 0;
    const blocks = this.document.getBlocks();
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type === "user" && i > 0) {
        this.terminal.write("\r\n");
        currentLine++;
      }
      block.startLine = currentLine;
      block.frozen = false;
      const content = block.render(this.cols, this.palette);
      this.terminal.write(content);
      const lineCount = (content.match(/\r\n/g) || []).length;
      this.document.commitBlockLines(block, lineCount);
      currentLine += lineCount;
    }

    // Resume spinner + input after redraw
    this.inputManager?.resumeAll();
  }

  // ── Resize handling ─────────────────────────────────────────────

  handleResize(cols: number, rows: number): void {
    const oldCols = this.cols;
    this.cols = cols;
    this.rows = rows;
    if (cols !== oldCols) {
      this.fullRedraw();
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────

  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}
