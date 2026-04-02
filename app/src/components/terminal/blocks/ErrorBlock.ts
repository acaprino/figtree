import type { Block } from "./Block";
import type { TerminalPalette } from "../themes";
import { fg, BOLD, RESET, wordWrap, sanitizeAgentText } from "../AnsiUtils";

export class ErrorBlock implements Block {
  readonly type = "error";
  readonly timestamp = Date.now();
  startLine = 0;
  lineCount = 0;
  frozen = false;

  constructor(
    public readonly id: string,
    public code: string,
    public message: string,
  ) {}

  render(cols: number, palette: TerminalPalette): string {
    const prefix = `${fg(palette.red)}${BOLD}ERROR${RESET} ${fg(palette.red)}[${this.code}]${RESET} `;
    const prefixLen = 9 + this.code.length; // "ERROR " (6) + "[" (1) + code + "] " (2)
    const lines = wordWrap(sanitizeAgentText(this.message), cols - prefixLen);

    const rendered = lines.map((line, i) =>
      i === 0 ? `${prefix}${fg(palette.red)}${line}${RESET}` : `${" ".repeat(prefixLen)}${fg(palette.red)}${line}${RESET}`
    ).join("\r\n");

    return `${rendered}\r\n`;
  }
}
