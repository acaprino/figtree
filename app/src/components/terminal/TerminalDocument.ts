/**
 * TerminalDocument — the Virtual Document Model.
 * Manages an ordered list of Blocks and translates AgentEvents into block operations.
 * Emits change events for the TerminalRenderer and sidebar panels.
 */

import type { Block } from "./blocks/Block";
import type { ChatMessage, AskQuestionItem, PermissionSuggestion, TodoItem } from "../../types";
import { UserBlock } from "./blocks/UserBlock";
import { AssistantBlock } from "./blocks/AssistantBlock";
import { ToolBlock } from "./blocks/ToolBlock";
import { DiffBlock } from "./blocks/DiffBlock";
import { PermissionBlock } from "./blocks/PermissionBlock";
import { AskBlock } from "./blocks/AskBlock";
import { ThinkingBlock } from "./blocks/ThinkingBlock";
import { ErrorBlock } from "./blocks/ErrorBlock";
import { StatusBlock } from "./blocks/StatusBlock";

// ── Event types emitted by the document ──────────────────────────
export type DocumentEvent =
  | { type: "blockAdded"; block: Block }
  | { type: "blockUpdated"; block: Block }
  | { type: "streamAppend"; text: string }
  | { type: "streamEnd" }
  | { type: "cleared" }
  | { type: "thinkingAppend"; block: ThinkingBlock; text: string };

export type DocumentListener = (event: DocumentEvent) => void;

// ── Edit/Write tool detection for DiffBlock ──────────────────────
const DIFF_TOOLS = new Set(["Edit", "Write"]);

function extractFilePath(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  return (obj.file_path as string) || (obj.path as string) || "";
}

function extractDiffContent(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  // Edit tool has 'old_string' and 'new_string', Write has 'content'
  if (obj.old_string !== undefined && obj.new_string !== undefined) {
    const lines: string[] = [];
    if (obj.old_string) {
      for (const line of String(obj.old_string).split("\n")) {
        lines.push(`-${line}`);
      }
    }
    if (obj.new_string) {
      for (const line of String(obj.new_string).split("\n")) {
        lines.push(`+${line}`);
      }
    }
    return lines.join("\n");
  }
  return "";
}

// ── TerminalDocument ─────────────────────────────────────────────

export class TerminalDocument {
  private blocks: Block[] = [];
  private totalLines = 0;
  private listeners: DocumentListener[] = [];
  private idCounter = 0;

  /** Currently streaming assistant block (if any) */
  private streamingBlock: AssistantBlock | null = null;
  /** Currently streaming thinking block (if any) */
  private thinkingBlock: ThinkingBlock | null = null;
  /** Latest todos (for sidebar) */
  private latestTodos: TodoItem[] = [];
  /** Track toolUseId -> ToolBlock or DiffBlock for matching toolResults */
  private toolUseIdMap = new Map<string, ToolBlock | DiffBlock>();

  private nextId(): string {
    return `blk-${++this.idCounter}`;
  }

  // ── Public API ──────────────────────────────────────────────────

  subscribe(listener: DocumentListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private emit(event: DocumentEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  getBlocks(): readonly Block[] {
    return this.blocks;
  }

  getBlockCount(): number {
    return this.blocks.length;
  }

  getTotalLines(): number {
    return this.totalLines;
  }

  getTodos(): TodoItem[] {
    return this.latestTodos;
  }

  clear(): void {
    this.blocks = [];
    this.totalLines = 0;
    this.streamingBlock = null;
    this.thinkingBlock = null;
    this.toolUseIdMap.clear();
    this.emit({ type: "cleared" });
  }

  // ── Block operations ────────────────────────────────────────────

  private addBlock(block: Block): void {
    block.startLine = this.totalLines;
    this.blocks.push(block);
    this.emit({ type: "blockAdded", block });
  }

  /** Update totalLines after a block has been rendered */
  commitBlockLines(block: Block, lineCount: number): void {
    block.lineCount = lineCount;
    this.totalLines = block.startLine + lineCount;
  }

  private updateBlock(block: Block): void {
    this.emit({ type: "blockUpdated", block });
  }

  // ── Finalization helpers ────────────────────────────────────────

  private finalizeStreaming(): void {
    if (this.streamingBlock) {
      this.streamingBlock.finalize();
      this.streamingBlock = null;
      this.emit({ type: "streamEnd" });
    }
  }

  /** Force-finalize streaming without emitting streamEnd (used by fullRedraw) */
  forceFinalize(): void {
    if (this.streamingBlock) {
      this.streamingBlock.finalize();
      this.streamingBlock = null;
    }
    if (this.thinkingBlock) {
      this.thinkingBlock.end();
      this.thinkingBlock = null;
    }
  }

  private finalizeThinking(): void {
    if (this.thinkingBlock) {
      this.thinkingBlock.end();
      this.updateBlock(this.thinkingBlock);
      this.thinkingBlock = null;
    }
  }

  // ── Event handlers (called by useSessionController) ─────────────

  handleAssistant(text: string, streaming: boolean): void {
    if (streaming) {
      this.finalizeThinking();
      if (!this.streamingBlock) {
        // Start new streaming block
        this.streamingBlock = new AssistantBlock(this.nextId(), "", true);
        this.addBlock(this.streamingBlock);
      }
      this.streamingBlock.append(text);
      this.emit({ type: "streamAppend", text });
    } else {
      // Non-streaming: finalize any current streaming block
      if (this.streamingBlock) {
        this.finalizeStreaming();
      } else {
        const block = new AssistantBlock(this.nextId(), text, false);
        this.addBlock(block);
      }
    }
  }

  private static readonly MAX_VISIBLE_TOOLS = 5;

  handleToolUse(tool: string, input: unknown, toolUseId?: string): void {
    this.finalizeStreaming();
    this.finalizeThinking();

    // Compact older consecutive tool blocks to keep output clean
    this.compactToolBlocks();

    // Decide if this is a diff-rendering tool
    if (DIFF_TOOLS.has(tool)) {
      const filePath = extractFilePath(input);
      const diffContent = extractDiffContent(input);
      if (diffContent) {
        const block = new DiffBlock(this.nextId(), tool, filePath, diffContent);
        this.addBlock(block);
        if (toolUseId) this.toolUseIdMap.set(toolUseId, block);
        return;
      }
    }

    const block = new ToolBlock(this.nextId(), tool, input, toolUseId);
    this.addBlock(block);
    if (toolUseId) this.toolUseIdMap.set(toolUseId, block);
  }

  /** Collapse older consecutive tool/diff blocks when there are too many visible */
  private compactToolBlocks(): void {
    // Count consecutive non-collapsed tool/diff blocks from the end
    let visibleTools = 0;
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if ((b.type === "tool" || b.type === "diff") && !(b as ToolBlock).collapsed) {
        visibleTools++;
      } else {
        break; // stop at first non-tool block
      }
    }

    if (visibleTools < TerminalDocument.MAX_VISIBLE_TOOLS) return;

    // Collapse the oldest ones in this run, keeping only the last (MAX-1) visible
    // (the new block about to be added will be the MAX-th)
    const toCollapse = visibleTools - (TerminalDocument.MAX_VISIBLE_TOOLS - 1);
    let collapsed = 0;
    for (let i = this.blocks.length - 1; i >= 0 && collapsed < visibleTools; i--) {
      const b = this.blocks[i];
      if ((b.type !== "tool" && b.type !== "diff") || (b as ToolBlock).collapsed) break;
      // Collapse from the oldest in the run
      if (collapsed < toCollapse) {
        // This is one of the oldest — find it by scanning from the START of the run
      }
    }

    // Simpler: find the start of the consecutive run, collapse from there
    let runStart = this.blocks.length - 1;
    while (runStart > 0) {
      const prev = this.blocks[runStart - 1];
      if ((prev.type === "tool" || prev.type === "diff") && !(prev as ToolBlock).collapsed) {
        runStart--;
      } else break;
    }

    // Collapse first `toCollapse` blocks in the run
    for (let i = runStart; i < runStart + toCollapse && i < this.blocks.length; i++) {
      const b = this.blocks[i] as ToolBlock;
      if (!b.collapsed) {
        b.collapsed = true;
        this.updateBlock(b); // trigger re-render (will render as "")
      }
    }
  }

  handleToolResult(tool: string, output: string, success: boolean, toolUseId?: string): void {
    // Find matching block by toolUseId or by scanning backwards
    let block: ToolBlock | DiffBlock | undefined;

    if (toolUseId) {
      block = this.toolUseIdMap.get(toolUseId);
    }

    if (!block) {
      // Fallback: find last pending tool block with matching tool name
      for (let i = this.blocks.length - 1; i >= 0; i--) {
        const b = this.blocks[i];
        if ((b.type === "tool" || b.type === "diff") && (b as ToolBlock).status === "pending" && (b as ToolBlock).tool === tool) {
          block = b as ToolBlock | DiffBlock;
          break;
        }
      }
    }

    if (block) {
      if (block.type === "tool") {
        (block as ToolBlock).update({ output, success });
      } else {
        (block as DiffBlock).update({ success });
      }
      // Clean up map entry to prevent unbounded growth
      if (toolUseId) this.toolUseIdMap.delete(toolUseId);
      this.updateBlock(block);
    }
  }

  handleProgress(tool: string, message: string): void {
    // Update the last pending tool block with progress info
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if ((b.type === "tool" || b.type === "diff") && (b as ToolBlock).status === "pending") {
        (b as ToolBlock).setProgress(message);
        this.updateBlock(b);
        return;
      }
    }
  }

  handlePermission(tool: string, description: string, toolUseId: string, suggestions?: PermissionSuggestion[]): void {
    const block = new PermissionBlock(this.nextId(), tool, description, toolUseId, suggestions);
    this.addBlock(block);
  }

  resolvePermission(toolUseId: string, allowed: boolean): void {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b.type === "permission" && (b as PermissionBlock).toolUseId === toolUseId) {
        (b as PermissionBlock).update({ resolved: true, allowed });
        this.updateBlock(b);
        return;
      }
    }
  }

  handleAsk(questions: AskQuestionItem[]): void {
    this.finalizeStreaming();
    this.finalizeThinking();
    const block = new AskBlock(this.nextId(), questions);
    this.addBlock(block);
  }

  resolveAsk(answers: Record<string, string>): void {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b.type === "ask" && !(b as AskBlock).resolved) {
        (b as AskBlock).update({ resolved: true, answers });
        this.updateBlock(b);
        return;
      }
    }
  }

  handleThinking(text: string): void {
    // Thinking is displayed via the spinner verb ("Thinking...") and sidebar panel.
    // No terminal block needed — the spinner handles the visual indicator.
    if (!this.thinkingBlock) {
      this.thinkingBlock = new ThinkingBlock(this.nextId(), "");
    }
    this.thinkingBlock.append(text);
    this.emit({ type: "thinkingAppend", block: this.thinkingBlock, text });
  }

  handleResult(
    _cost: number, _inputTokens: number, _outputTokens: number,
    _cacheReadTokens: number, _cacheWriteTokens: number,
    _turns: number, _durationMs: number, _sessionId: string,
  ): void {
    // Stats already shown in bottom bar — no need for inline result block
    this.finalizeStreaming();
    this.finalizeThinking();
  }

  handleError(code: string, message: string): void {
    this.finalizeStreaming();
    this.finalizeThinking();
    const block = new ErrorBlock(this.nextId(), code, message);
    this.addBlock(block);
  }

  handleStatus(status: string, _model: string): void {
    // Status messages (init, etc.) are noise in xterm — suppress them
    if (status === "Interrupted") {
      const block = new StatusBlock(this.nextId(), "Interrupted", "");
      this.addBlock(block);
    }
  }

  handleInterrupted(): void {
    this.finalizeStreaming();
    this.finalizeThinking();
    const block = new StatusBlock(this.nextId(),"Interrupted", "");
    this.addBlock(block);
  }

  handleUserMessage(text: string, fromHistory = false): void {
    const block = new UserBlock(this.nextId(), text, fromHistory);
    this.addBlock(block);
  }

  handleTodo(todos: TodoItem[]): void {
    this.latestTodos = todos;
    // Todos are displayed in sidebar only, no terminal block needed
  }

  handleHistorySeparator(): void {
    // Simple separator block
    const block = new StatusBlock(this.nextId(),"── previous session ──", "");
    this.addBlock(block);
  }

  // ── Find helpers ────────────────────────────────────────────────

  findLastUnresolvedPermission(): PermissionBlock | null {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b.type === "permission" && !(b as PermissionBlock).resolved) {
        return b as PermissionBlock;
      }
    }
    return null;
  }

  findLastUnresolvedAsk(): AskBlock | null {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b.type === "ask" && !(b as AskBlock).resolved) {
        return b as AskBlock;
      }
    }
    return null;
  }

  // ── ChatMessage bridge (for sidebar compatibility) ──────────────

  toChatMessages(): ChatMessage[] {
    const msgs: ChatMessage[] = [];
    for (const block of this.blocks) {
      const id = block.id;
      const ts = block.timestamp;

      switch (block.type) {
        case "user":
          msgs.push({ id, role: "user", text: (block as UserBlock).text, timestamp: ts });
          break;
        case "assistant":
          msgs.push({ id, role: "assistant", text: (block as AssistantBlock).text, streaming: (block as AssistantBlock).streaming, timestamp: ts });
          break;
        case "tool":
          msgs.push({
            id, role: "tool", tool: (block as ToolBlock).tool,
            input: (block as ToolBlock).input,
            output: (block as ToolBlock).output,
            success: (block as ToolBlock).status === "success" ? true : (block as ToolBlock).status === "fail" ? false : undefined,
            timestamp: ts,
          });
          break;
        case "diff":
          msgs.push({
            id, role: "tool", tool: (block as DiffBlock).tool,
            input: { file_path: (block as DiffBlock).filePath },
            output: (block as DiffBlock).diffContent,
            success: (block as DiffBlock).status === "success" ? true : (block as DiffBlock).status === "fail" ? false : undefined,
            timestamp: ts,
          });
          break;
        case "permission":
          msgs.push({
            id, role: "permission", tool: (block as PermissionBlock).tool,
            description: (block as PermissionBlock).description,
            toolUseId: (block as PermissionBlock).toolUseId,
            suggestions: (block as PermissionBlock).suggestions,
            resolved: (block as PermissionBlock).resolved,
            allowed: (block as PermissionBlock).allowed,
            timestamp: ts,
          });
          break;
        case "ask":
          msgs.push({
            id, role: "ask", questions: (block as AskBlock).questions,
            resolved: (block as AskBlock).resolved,
            answers: (block as AskBlock).answers,
            timestamp: ts,
          });
          break;
        case "error":
          msgs.push({ id, role: "error", code: (block as ErrorBlock).code, message: (block as ErrorBlock).message, timestamp: ts });
          break;
        case "status":
          msgs.push({ id, role: "status", status: (block as StatusBlock).status, model: (block as StatusBlock).model, timestamp: ts });
          break;
      }
    }
    return msgs;
  }
}
