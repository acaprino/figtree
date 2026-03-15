import { useRef, useCallback } from "react";

// TODO: Re-implement autocomplete for textarea-based ChatView input.
// The old xterm-based ghost text rendering has been removed.

export interface AutocompleteState {
  hasSuggestionRef: React.RefObject<boolean>;
  accept: () => string;
  cycle: () => void;
  dismiss: () => void;
  onInputChange: () => void;
  cleanup: () => void;
  handleResponse: (suggestions: string[], seq: number) => void;
}

export function useAutocomplete(
  _inputRef: React.RefObject<HTMLTextAreaElement | null>,
  _tabIdRef: React.RefObject<string | null>,
  _inputBufRef: React.RefObject<string>,
  _projectPath: string,
  _enabled: boolean,
): AutocompleteState {
  const hasSuggestionRef = useRef(false);
  const noop = useCallback(() => "", []);
  const noopVoid = useCallback(() => {}, []);

  return {
    hasSuggestionRef,
    accept: noop,
    cycle: noopVoid,
    dismiss: noopVoid,
    onInputChange: noopVoid,
    cleanup: noopVoid,
    handleResponse: noopVoid,
  };
}
