import { memo, useState, useEffect } from "react";

// ASCII density ramp: dark → light
const DENSITY = "@%#*+=-:. ";

interface AsciiCell {
  char: string;
  r: number;
  g: number;
  b: number;
  a: number;
}

function imageToAscii(img: HTMLImageElement, cols: number): AsciiCell[][] {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  ctx.drawImage(img, 0, 0);

  if (cols <= 0 || img.naturalWidth <= 0 || img.naturalHeight <= 0) return [];

  const aspect = 0.5; // monospace chars are ~2x tall as wide
  const cellW = img.naturalWidth / cols;
  const cellH = cellW / aspect;
  const rows = Math.floor(img.naturalHeight / cellH);

  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const grid: AsciiCell[][] = [];

  for (let row = 0; row < rows; row++) {
    const line: AsciiCell[] = [];
    for (let col = 0; col < cols; col++) {
      const x0 = Math.floor(col * cellW);
      const y0 = Math.floor(row * cellH);
      const x1 = Math.min(Math.floor((col + 1) * cellW), canvas.width);
      const y1 = Math.min(Math.floor((row + 1) * cellH), canvas.height);

      let rSum = 0, gSum = 0, bSum = 0, aSum = 0, count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (y * canvas.width + x) * 4;
          rSum += pixels.data[idx];
          gSum += pixels.data[idx + 1];
          bSum += pixels.data[idx + 2];
          aSum += pixels.data[idx + 3];
          count++;
        }
      }

      if (count === 0) {
        line.push({ char: " ", r: 0, g: 0, b: 0, a: 0 });
        continue;
      }

      const r = Math.round(rSum / count);
      const g = Math.round(gSum / count);
      const b = Math.round(bSum / count);
      const a = Math.round(aSum / count);

      const brightness = (r * 0.299 + g * 0.587 + b * 0.114);
      const charIdx = Math.floor((brightness / 255) * (DENSITY.length - 1));
      const char = a < 30 ? " " : DENSITY[charIdx];

      line.push({ char, r, g, b, a });
    }
    grid.push(line);
  }
  return grid;
}

// Module-level cache so the ASCII grid is only computed once per cols value
const gridCache = new Map<number, AsciiCell[][]>();

const AsciiLogo = memo(function AsciiLogo({ cols = 60 }: { cols?: number }) {
  const [grid, setGrid] = useState<AsciiCell[][] | null>(() => gridCache.get(cols) ?? null);

  useEffect(() => {
    const cached = gridCache.get(cols);
    if (cached) { setGrid(cached); return; }
    const img = new Image();
    img.onload = () => {
      const result = imageToAscii(img, cols);
      gridCache.set(cols, result);
      setGrid(result);
    };
    img.onerror = () => setGrid([]);
    img.src = "/icon.png";
  }, [cols]);

  if (!grid) return <div className="ascii-logo-wrap"><pre className="ascii-logo">Loading...</pre></div>;

  return (
    <div className="ascii-logo-wrap">
      <pre className="ascii-logo" aria-label="Anvil logo">
        {grid.map((row, ri) => (
          <span key={ri}>
            {row.map((cell, ci) => {
              if (cell.char === " " || cell.a < 30) return cell.char;
              return (
                <span key={ci} style={{ color: `rgb(${cell.r},${cell.g},${cell.b})` }}>
                  {cell.char}
                </span>
              );
            })}
            {ri < grid.length - 1 ? "\n" : ""}
          </span>
        ))}
      </pre>
    </div>
  );
});

export default AsciiLogo;
