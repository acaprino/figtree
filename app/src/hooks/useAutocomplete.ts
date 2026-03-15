import { useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { requestAutocomplete } from "./useAgentSession";
import type { Terminal } from "@xterm/xterm";

// ANSI escape helpers
const ESC_ERASE_EOL = "\x1b[K";
const ESC_DIM_ITALIC_GREY = "\x1b[2;3;90m";
const ESC_RESET = "\x1b[0m";

interface CacheEntry {
  suggestions: string[];
  timestamp: number;
  inputSnapshot: string;
}

const CACHE_TTL_MS = 30_000;
const DEBOUNCE_MS = 300;
const MIN_CHARS_FILE = 1;
const MIN_CHARS_LLM = 3;

export interface AutocompleteState {
  /** Ref-based — always current, safe to read in event handlers */
  hasSuggestionRef: React.RefObject<boolean>;
  accept: () => string;
  cycle: () => void;
  dismiss: () => void;
  onInputChange: () => void;
  cleanup: () => void;
  handleResponse: (suggestions: string[], seq: number) => void;
}

export function useAutocomplete(
  xtermRef: React.RefObject<Terminal | null>,
  tabIdRef: React.RefObject<string | null>,
  inputBufRef: React.RefObject<string>,
  projectPath: string,
  enabled: boolean,
  toolIdx: number,
): AutocompleteState {
  const suggestionsRef = useRef<string[]>([]);
  const currentIdxRef = useRef(0);
  // Declared early — used by renderGhost/clearGhost closures below
  const hasSuggestionRef = useRef(false);
  const seqRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());
  const ghostVisibleRef = useRef(false);
  const lastGhostLenRef = useRef(0);
  const savedCursorRef = useRef<{ row: number; col: number } | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  const renderGhost = useCallback((suggestion: string, idx: number, total: number) => {
    const xterm = xtermRef.current;
    if (!xterm) return;

    // Save cursor position from JS (not ANSI DECSC — avoids conflicts)
    const row = xterm.buffer.active.cursorY + xterm.buffer.active.baseY + 1; // 1-based for ANSI
    const col = xterm.buffer.active.cursorX + 1; // 1-based

    // Truncate to fit remaining columns
    const availCols = xterm.cols - (col - 1);
    const indicator = total > 1 ? ` (${idx + 1}/${total})` : "";
    let display = suggestion.split("\n")[0]; // First line only
    const maxLen = availCols - indicator.length;
    if (display.length > maxLen) {
      display = display.slice(0, Math.max(0, maxLen - 3)) + "...";
    }

    // Erase previous ghost if any
    if (ghostVisibleRef.current && savedCursorRef.current) {
      const { row: sRow, col: sCol } = savedCursorRef.current;
      xterm.write(`\x1b[${sRow};${sCol}H${ESC_ERASE_EOL}`);
    }

    // Write ghost text
    xterm.write(`\x1b[${row};${col}H${ESC_DIM_ITALIC_GREY}${display}${indicator}${ESC_RESET}`);
    // Restore cursor
    xterm.write(`\x1b[${row};${col}H`);

    savedCursorRef.current = { row, col };
    ghostVisibleRef.current = true;
    hasSuggestionRef.current = true;
    lastGhostLenRef.current = display.length + indicator.length;
  }, [xtermRef]);

  const clearGhost = useCallback(() => {
    if (!ghostVisibleRef.current || !savedCursorRef.current) return;
    const xterm = xtermRef.current;
    if (!xterm) return;

    const { row, col } = savedCursorRef.current;
    xterm.write(`\x1b[${row};${col}H${ESC_ERASE_EOL}`);
    xterm.write(`\x1b[${row};${col}H`);

    ghostVisibleRef.current = false;
    hasSuggestionRef.current = false;
    savedCursorRef.current = null;
    lastGhostLenRef.current = 0;
  }, [xtermRef]);

  const dismiss = useCallback(() => {
    clearGhost();
    suggestionsRef.current = [];
    currentIdxRef.current = 0;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, [clearGhost]);

  const cycle = useCallback(() => {
    if (!enabled) return;
    const suggestions = suggestionsRef.current;
    if (suggestions.length === 0) return;

    currentIdxRef.current = (currentIdxRef.current + 1) % suggestions.length;
    renderGhost(suggestions[currentIdxRef.current], currentIdxRef.current, suggestions.length);
  }, [enabled, renderGhost]);

  const accept = useCallback((): string => {
    if (!enabled || suggestionsRef.current.length === 0) return "";
    const suggestion = suggestionsRef.current[currentIdxRef.current] || "";
    clearGhost();
    suggestionsRef.current = [];
    currentIdxRef.current = 0;
    return suggestion;
  }, [enabled, clearGhost]);

  const fetchSuggestions = useCallback(async (input: string) => {
    if (!enabled || !input.trim()) return;

    const newSuggestions: string[] = [];

    // 1. File path provider (Rust backend) — instant
    if (input.length >= MIN_CHARS_FILE) {
      try {
        const files = await invoke<string[]>("autocomplete_files", {
          cwd: projectPath,
          input,
        });
        newSuggestions.push(...files);
      } catch {
        // Silently ignore file scan errors
      }
    }

    // Show file results immediately
    if (newSuggestions.length > 0) {
      suggestionsRef.current = newSuggestions;
      currentIdxRef.current = 0;
      renderGhost(newSuggestions[0], 0, newSuggestions.length);
    }

    // 2. LLM provider — async, only for Claude (toolIdx 0), min 3 chars
    if (input.length >= MIN_CHARS_LLM && toolIdx === 0) {
      // Check cache first
      const cacheKey = input.toLowerCase().trim();
      const cached = cacheRef.current.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        // Verify cache is still relevant
        if (cacheKey.startsWith(cached.inputSnapshot.toLowerCase().trim())) {
          const merged = [...newSuggestions, ...cached.suggestions.filter((s) => !newSuggestions.includes(s))];
          suggestionsRef.current = merged;
          if (merged.length > 0) {
            currentIdxRef.current = 0;
            renderGhost(merged[0], 0, merged.length);
          }
          return;
        }
      }

      // Show loading indicator if no file results are showing yet
      if (newSuggestions.length === 0) {
        const xterm = xtermRef.current;
        if (xterm) {
          const row = xterm.buffer.active.cursorY + xterm.buffer.active.baseY + 1;
          const col = xterm.buffer.active.cursorX + 1;
          savedCursorRef.current = { row, col };
          xterm.write(`\x1b[${row};${col}H${ESC_DIM_ITALIC_GREY}...${ESC_RESET}`);
          xterm.write(`\x1b[${row};${col}H`);
          ghostVisibleRef.current = true;
          lastGhostLenRef.current = 3;
        }
      }

      // Make LLM request
      const seq = ++seqRef.current;
      try {
        await requestAutocomplete(
          tabIdRef.current || "",
          input,
          [], // Context will be enhanced later
          seq,
        );
        // Response comes back via handleAutocompleteResponse (called from Terminal.tsx)
      } catch {
        // Silently ignore LLM errors
      }
    }
  }, [enabled, projectPath, toolIdx, tabIdRef, xtermRef, renderGhost]);

  // Handle LLM autocomplete responses from sidecar
  const handleAutocompleteResponse = useCallback((suggestions: string[], seq: number) => {
    if (!enabled) return;
    // Discard stale responses
    if (seq !== seqRef.current) return;

    if (suggestions.length === 0) return;

    // Cache the LLM response
    const input = inputBufRef.current;
    if (input && suggestions.length > 0) {
      const cacheKey = input.toLowerCase().trim();
      cacheRef.current.set(cacheKey, {
        suggestions,
        timestamp: Date.now(),
        inputSnapshot: input,
      });
    }

    // Append LLM suggestions to existing file path suggestions
    const existing = suggestionsRef.current;
    const merged = [...existing, ...suggestions.filter((s) => !existing.includes(s))];
    suggestionsRef.current = merged;

    // If no ghost text is showing yet, render the first suggestion
    if (!ghostVisibleRef.current && merged.length > 0) {
      currentIdxRef.current = 0;
      renderGhost(merged[0], 0, merged.length);
    } else if (ghostVisibleRef.current) {
      // Update the cycle indicator without changing current suggestion
      renderGhost(merged[currentIdxRef.current], currentIdxRef.current, merged.length);
    }
  }, [enabled, inputBufRef, renderGhost]);

  // Expose the response handler via ref so it's always current
  const responseHandlerRef = useRef(handleAutocompleteResponse);
  responseHandlerRef.current = handleAutocompleteResponse;

  const onInputChange = useCallback(() => {
    if (!enabled) return;

    // Clear existing ghost and debounce timer
    clearGhost();
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      const input = inputBufRef.current;
      if (input && input.length >= MIN_CHARS_FILE) {
        fetchSuggestions(input);
      }
    }, DEBOUNCE_MS);
  }, [enabled, inputBufRef, clearGhost, fetchSuggestions]);

  const cleanup = useCallback(() => {
    dismiss();
    cacheRef.current.clear();
  }, [dismiss]);

  return {
    hasSuggestionRef,
    accept,
    cycle,
    dismiss,
    onInputChange,
    cleanup,
    handleResponse: (s: string[], seq: number) => responseHandlerRef.current(s, seq),
  };
}
