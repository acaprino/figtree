import { memo, useState, useEffect, useRef, useCallback } from "react";
import { useProjectsContext } from "../contexts/ProjectsContext";
import { SystemPrompt } from "../types";
import { Banner, Sep } from "./GsdPrimitives";
import "./GsdLayout.css";
import "./SystemPromptPage.css";

const PREVIEW_MAX_CHARS = 200;
const MAX_PROMPT_LENGTH = 100_000;

interface SystemPromptPageProps {
  tabId: string;
  onRequestClose: (tabId: string) => void;
  isActive: boolean;
}

function SystemPromptPage({ tabId, onRequestClose, isActive }: SystemPromptPageProps) {
  const { settings, updateSettings } = useProjectsContext();

  const prompts = settings?.system_prompts ?? [];
  const activeIds = settings?.active_prompt_ids ?? [];

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editContent, setEditContent] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  // Focus name input when creating/editing
  useEffect(() => {
    if (isCreating || editingId) {
      nameInputRef.current?.focus();
    }
  }, [isCreating, editingId]);

  // Esc closes tab (only when not editing)
  useEffect(() => {
    if (!isActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (isCreating || editingId) {
          setIsCreating(false);
          setEditingId(null);
        } else {
          onRequestClose(tabId);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isActive, tabId, onRequestClose, isCreating, editingId]);

  const handleCreate = useCallback(() => {
    setEditName("");
    setEditContent("");
    setEditingId(null);
    setIsCreating(true);
  }, []);

  const handleEdit = useCallback((prompt: SystemPrompt) => {
    setEditName(prompt.name);
    setEditContent(prompt.content);
    setEditingId(prompt.id);
    setIsCreating(false);
  }, []);

  const handleSave = useCallback(() => {
    const name = editName.trim();
    const content = editContent.trim();
    if (!name || !content) return;

    if (isCreating) {
      const newPrompt: SystemPrompt = {
        id: crypto.randomUUID(),
        name,
        content,
      };
      updateSettings({
        system_prompts: [...prompts, newPrompt],
      });
    } else if (editingId) {
      updateSettings({
        system_prompts: prompts.map((p) =>
          p.id === editingId ? { ...p, name, content } : p
        ),
      });
    }

    setIsCreating(false);
    setEditingId(null);
  }, [editName, editContent, isCreating, editingId, prompts, updateSettings]);

  const handleDelete = useCallback((id: string) => {
    updateSettings({
      system_prompts: prompts.filter((p) => p.id !== id),
      active_prompt_ids: activeIds.filter((aid) => aid !== id),
    });
    if (editingId === id) {
      setEditingId(null);
    }
  }, [prompts, activeIds, editingId, updateSettings]);

  const handleToggleActive = useCallback((id: string) => {
    const isCurrentlyActive = activeIds.includes(id);
    updateSettings({
      active_prompt_ids: isCurrentlyActive
        ? activeIds.filter((aid) => aid !== id)
        : [...activeIds, id],
    });
  }, [activeIds, updateSettings]);

  const handleCancel = useCallback(() => {
    setIsCreating(false);
    setEditingId(null);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      handleSave();
    }
  }, [handleSave]);

  const showEditor = isCreating || editingId !== null;

  return (
    <div className="static-page">
      <div className="static-page-inner">
        <Banner title="SYSTEM PROMPTS" />

        <div className="sp-description">
          Manage system prompts appended to every Claude session.
          Toggle prompts on/off — active prompts are combined when launching.
        </div>

        <Sep />

        {/* Prompt list */}
        <div className="sp-list">
          {prompts.length === 0 && !showEditor && (
            <div className="sp-empty">No system prompts yet. Create one to get started.</div>
          )}

          {prompts.map((prompt) => {
            const isItemActive = activeIds.includes(prompt.id);
            const isItemEditing = editingId === prompt.id;

            return (
              <div key={prompt.id} className={`sp-item ${isItemActive ? "active" : ""} ${isItemEditing ? "editing" : ""}`}>
                <div className="sp-item-header">
                  <button
                    className={`sp-toggle ${isItemActive ? "on" : "off"}`}
                    onClick={() => handleToggleActive(prompt.id)}
                    title={isItemActive ? "Deactivate" : "Activate"}
                  >
                    {isItemActive ? "[x]" : "[ ]"}
                  </button>
                  <span className="sp-item-name">{prompt.name}</span>
                  <span className="sp-item-size">{prompt.content.length} chars</span>
                  <button className="sp-btn sp-btn-edit" onClick={() => handleEdit(prompt)} title="Edit">edit</button>
                  <button className="sp-btn sp-btn-delete" onClick={() => handleDelete(prompt.id)} title="Delete">del</button>
                </div>
                {!isItemEditing && (
                  <pre className="sp-item-preview">{prompt.content.slice(0, PREVIEW_MAX_CHARS)}{prompt.content.length > PREVIEW_MAX_CHARS ? "..." : ""}</pre>
                )}
              </div>
            );
          })}
        </div>

        {/* Editor */}
        {showEditor && (
          <div className="sp-editor" onKeyDown={handleKeyDown}>
            <div className="sp-editor-title">
              {isCreating ? "New Prompt" : "Edit Prompt"}
            </div>
            <input
              ref={nameInputRef}
              className="sp-input"
              type="text"
              placeholder="Prompt name..."
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
            />
            <textarea
              ref={contentRef}
              className="sp-textarea"
              placeholder="System prompt content..."
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              maxLength={MAX_PROMPT_LENGTH}
              rows={12}
            />
            <div className="sp-editor-actions">
              <button className="sp-btn sp-btn-save" onClick={handleSave}>
                Save (Ctrl+Enter)
              </button>
              <button className="sp-btn sp-btn-cancel" onClick={handleCancel}>
                Cancel (Esc)
              </button>
            </div>
          </div>
        )}

        {/* Create button */}
        {!showEditor && (
          <div className="sp-actions">
            <button className="sp-btn sp-btn-create" onClick={handleCreate}>
              + New Prompt
            </button>
          </div>
        )}

        <div className="gsd-footer">
          <Sep />
          <div className="gsd-footer-text">Press Esc or Ctrl+Shift+P to close</div>
          <Sep />
        </div>
      </div>
    </div>
  );
}

export default memo(SystemPromptPage);
