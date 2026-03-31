/**
 * AnsiUtils — ANSI escape sequence utilities for xterm.js rendering.
 * All colors use 24-bit truecolor (\x1b[38;2;r;g;bm).
 */

import type { TerminalPalette } from "./themes";

// ── Constants ──────────────────────────────────────────────────────
export const ESC = "\x1b";
export const CSI = `${ESC}[`;

// ── SGR (Select Graphic Rendition) ─────────────────────────────────
export const RESET = `${CSI}0m`;
export const BOLD = `${CSI}1m`;
export const DIM = `${CSI}2m`;
export const ITALIC = `${CSI}3m`;
export const UNDERLINE = `${CSI}4m`;
export const STRIKETHROUGH = `${CSI}9m`;
export const BOLD_OFF = `${CSI}22m`;
export const ITALIC_OFF = `${CSI}23m`;
export const UNDERLINE_OFF = `${CSI}24m`;

/** Parse hex color (#RRGGBB or #RGB) to [r, g, b] */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16),
    ];
  }
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Set foreground color using 24-bit truecolor */
export function fg(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `${CSI}38;2;${r};${g};${b}m`;
}

/** Set background color using 24-bit truecolor */
export function bg(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `${CSI}48;2;${r};${g};${b}m`;
}

// ── Cursor movement ────────────────────────────────────────────────
export function cursorUp(n = 1): string { return `${CSI}${n}A`; }
export function cursorDown(n = 1): string { return `${CSI}${n}B`; }
export function cursorForward(n = 1): string { return `${CSI}${n}C`; }
export function cursorBack(n = 1): string { return `${CSI}${n}D`; }
export function cursorColumn(col: number): string { return `${CSI}${col}G`; }
export function cursorPosition(row: number, col: number): string { return `${CSI}${row};${col}H`; }
export const CURSOR_SAVE = `${ESC}7`;
export const CURSOR_RESTORE = `${ESC}8`;

// ── Erase ──────────────────────────────────────────────────────────
export const ERASE_LINE = `${CSI}2K`;
export const ERASE_TO_END = `${CSI}0K`;
export const ERASE_BELOW = `${CSI}0J`;
export const ERASE_SCREEN = `${CSI}2J`;

// ── Sanitization ──────────────────────────────────────────────────

/** Strip terminal control sequences from agent-sourced text (security) */
export function sanitizeAgentText(str: string): string {
  return str
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")    // CSI sequences (including private mode)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")  // OSC sequences
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, "")  // DCS, SOS, PM, APC
    .replace(/\x1b[78]/g, "")                    // cursor save/restore
    .replace(/[\x80-\x9f]/g, "")                 // C1 control codes
    .replace(/\x1b/g, "");                       // any remaining ESC
}

// ── Word wrapping ──────────────────────────────────────────────────

/** Strip ANSI escape sequences for length calculation */
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b[78]/g, "");
}

/** Get visible length of a string (excludes ANSI sequences) */
export function visibleLength(str: string): number {
  return stripAnsi(str).length;
}

/**
 * Word-wrap text to fit within a given column width.
 * Returns an array of lines. Preserves existing newlines.
 * Does NOT add ANSI formatting — caller should wrap output.
 */
export function wordWrap(text: string, cols: number): string[] {
  if (cols <= 0) return [text];
  const result: string[] = [];
  const paragraphs = text.split("\n");

  for (const para of paragraphs) {
    if (para.length === 0) {
      result.push("");
      continue;
    }
    const words = para.split(/(\s+)/);
    let line = "";
    let lineLen = 0;

    for (const word of words) {
      const wLen = word.length;
      if (lineLen + wLen > cols && lineLen > 0) {
        result.push(line);
        line = "";
        lineLen = 0;
        // Skip leading whitespace on new line
        if (/^\s+$/.test(word)) continue;
      }
      line += word;
      lineLen += wLen;
    }
    if (line.length > 0) result.push(line);
  }
  return result;
}

// ── Box drawing ────────────────────────────────────────────────────

const BOX = {
  topLeft: "\u256d",
  topRight: "\u256e",
  bottomLeft: "\u2570",
  bottomRight: "\u256f",
  horizontal: "\u2500",
  vertical: "\u2502",
} as const;

/**
 * Draw a box around content lines.
 * Returns an array of ANSI-formatted lines.
 *
 * @param title - Box title (shown in top border)
 * @param content - Array of content lines (will be padded to box width)
 * @param cols - Available terminal columns
 * @param borderColor - Hex color for the border
 * @param palette - Terminal palette for text colors
 */
export function boxDraw(
  title: string,
  content: string[],
  cols: number,
  borderColor: string,
  palette: TerminalPalette,
): string[] {
  const innerWidth = Math.max(cols - 4, 20); // 2 for border + 2 for padding
  const bc = fg(borderColor);
  const tc = fg(palette.text);
  const lines: string[] = [];

  // Top border: ╭─ Title ─────────╮
  const titleStr = title ? ` ${title} ` : "";
  const topFill = Math.max(0, innerWidth - stripAnsi(titleStr).length);
  lines.push(
    `${bc}${BOX.topLeft}${BOX.horizontal}${RESET}${tc}${titleStr}${RESET}${bc}${BOX.horizontal.repeat(topFill)}${BOX.topRight}${RESET}`
  );

  // Content lines: │ content │
  for (const line of content) {
    const visible = stripAnsi(line);
    const pad = Math.max(0, innerWidth - visible.length);
    lines.push(
      `${bc}${BOX.vertical}${RESET} ${line}${" ".repeat(pad)}${bc}${BOX.vertical}${RESET}`
    );
  }

  // Bottom border: ╰─────────────────╯
  lines.push(
    `${bc}${BOX.bottomLeft}${BOX.horizontal.repeat(innerWidth + 2)}${BOX.bottomRight}${RESET}`
  );

  return lines;
}

// ── Inline markdown formatting ─────────────────────────────────────

/**
 * Convert inline markdown (bold, italic, code) to ANSI sequences.
 * Only handles: **bold**, *italic*, `code`
 */
export function inlineMarkdown(text: string, palette: TerminalPalette): string {
  return text
    // Bold: **text**
    .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${BOLD_OFF}`)
    // Italic: *text*
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, `${ITALIC}$1${ITALIC_OFF}`)
    // Inline code: `code`
    .replace(/`([^`]+)`/g, `${fg(palette.accent)}$1${RESET}`);
}

// ── Diff formatting ────────────────────────────────────────────────

/**
 * Format a unified diff string into colored ANSI lines.
 */
export function formatDiff(diffText: string, palette: TerminalPalette): string[] {
  return diffText.split("\n").map(line => {
    if (line.startsWith("+")) return `${fg(palette.green)}${line}${RESET}`;
    if (line.startsWith("-")) return `${fg(palette.red)}${line}${RESET}`;
    if (line.startsWith("@@")) return `${fg(palette.accent)}${line}${RESET}`;
    return `${fg(palette.textDim)}${line}${RESET}`;
  });
}

// ── Horizontal rule ────────────────────────────────────────────────

export function horizontalRule(text: string, cols: number, color: string): string {
  const textLen = text.length + 2; // space padding
  const sideLen = Math.max(2, Math.floor((cols - textLen) / 2));
  const dash = "\u2500";
  return `${fg(color)}${dash.repeat(sideLen)} ${text} ${dash.repeat(sideLen)}${RESET}`;
}

// ── Status icons ───────────────────────────────────────────────────
export const ICON = {
  pending: "\u25cb",   // ○
  success: "\u2713",   // ✓
  fail: "\u2717",      // ✗
  prompt: "\u276f",    // ❯
  thinking: "\u25c9",  // ◉
  warning: "\u26a0",   // ⚠
  arrow_right: "\u25b8", // ▸
  arrow_down: "\u25be",  // ▾
  spinner: ["\u280b", "\u2819", "\u2838", "\u2830", "\u2824", "\u2826", "\u2807", "\u280f"], // braille spinner
} as const;
