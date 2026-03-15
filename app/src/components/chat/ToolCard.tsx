import { useState } from "react";

interface Props {
  tool: string;
  input: unknown;
  output?: string;
  success?: boolean;
}

export default function ToolCard({ tool, input, output, success }: Props) {
  const [expanded, setExpanded] = useState(false);
  const inputStr = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  const truncatedInput = inputStr.length > 300 ? inputStr.slice(0, 300) + "..." : inputStr;

  return (
    <div className={`tool-card${success === false ? " failed" : ""}`}>
      <div className="tool-card-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-card-icon">{success === undefined ? "⚙" : success ? "✓" : "✗"}</span>
        <span className="tool-card-name">{tool}</span>
        {!expanded && <span className="tool-card-preview">{truncatedInput.split("\n")[0].slice(0, 60)}</span>}
        <span className="tool-card-toggle">{expanded ? "▾" : "▸"}</span>
      </div>
      {expanded && (
        <div className="tool-card-body">
          <pre className="tool-card-input">{inputStr}</pre>
          {output && <pre className="tool-card-output">{output}</pre>}
        </div>
      )}
    </div>
  );
}
