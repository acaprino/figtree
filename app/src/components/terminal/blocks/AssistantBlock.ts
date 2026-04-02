import type { Block } from "./Block";
import type { TerminalPalette } from "../themes";
import { RESET, wordWrap, inlineMarkdown, fg, sanitizeAgentText } from "../AnsiUtils";

export class AssistantBlock implements Block {
  readonly type = "assistant";
  readonly timestamp = Date.now();
  startLine = 0;
  lineCount = 0;
  frozen = false;
  streaming = true;

  constructor(public readonly id: string, public text: string, streaming: boolean) {
    this.streaming = streaming;
  }

  append(chunk: string): void {
    this.text += chunk;
  }

  finalize(): void {
    this.streaming = false;
  }

  render(cols: number, palette: TerminalPalette): string {
    const sanitized = sanitizeAgentText(this.text).replace(/\s+$/, "");
    const formatted = inlineMarkdown(sanitized, palette);
    const lines: string[] = [];
    let inCodeBlock = false;
    let codeLang = "";

    for (const rawLine of formatted.split("\n")) {
      if (rawLine.startsWith("```")) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeLang = rawLine.slice(3).trim();
          lines.push(`  ${fg(palette.textDim)}${"─".repeat(Math.min(cols - 4, 38))}${codeLang ? ` ${codeLang}` : ""}${RESET}`);
        } else {
          inCodeBlock = false;
          codeLang = "";
          lines.push(`  ${fg(palette.textDim)}${"─".repeat(Math.min(cols - 4, 38))}${RESET}`);
        }
        continue;
      }

      if (inCodeBlock) {
        lines.push(`${fg(palette.accent)}  ${rawLine}${RESET}`);
      } else {
        const wrapped = wordWrap(rawLine, cols - 1);
        lines.push(...wrapped);
      }
    }

    return lines.join("\r\n") + "\r\n";
  }
}
