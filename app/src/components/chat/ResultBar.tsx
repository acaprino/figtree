interface Props {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  turns: number;
  durationMs: number;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toString();
}

export default function ResultBar({ cost, inputTokens, outputTokens, cacheReadTokens, turns, durationMs }: Props) {
  const safe = (n: number) => (Number.isFinite(n) ? n : 0);
  const totalTokens = safe(inputTokens) + safe(outputTokens);
  const cached = safe(cacheReadTokens) > 0 ? ` (${fmtTokens(safe(cacheReadTokens))} cached)` : "";

  return (
    <div className="result-bar">
      <span>${safe(cost).toFixed(3)}</span>
      <span className="result-sep">·</span>
      <span>{fmtTokens(totalTokens)} tokens{cached}</span>
      <span className="result-sep">·</span>
      <span>{safe(turns)} turn{safe(turns) !== 1 ? "s" : ""}</span>
      <span className="result-sep">·</span>
      <span>{(safe(durationMs) / 1000).toFixed(1)}s</span>
    </div>
  );
}
