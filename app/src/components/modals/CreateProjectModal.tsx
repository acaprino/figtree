import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import Modal from "../Modal";
import FolderTree from "../FolderTree";
import { PROJECT_TEMPLATES, ProjectTemplate } from "../../data/projectTemplates";

interface CreateProjectModalProps {
  defaultDir: string;
  onClose: () => void;
  onCreated: () => void;
}

export default function CreateProjectModal({
  defaultDir,
  onClose,
  onCreated,
}: CreateProjectModalProps) {
  const [name, setName] = useState("");
  const [parentDir, setParentDir] = useState(defaultDir);
  const [gitInit, setGitInit] = useState(true);
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<ProjectTemplate | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleCreate = async () => {
    if (!name.trim()) { setErr("Name cannot be empty"); return; }
    if (!parentDir) { setErr("No container directory configured. Add one via Settings."); return; }
    setCreating(true);
    setErr("");
    try {
      await invoke("create_project", { parent: parentDir, name: name.trim(), gitInit });
      // If a template was selected, create its system prompt
      if (selectedTemplate) {
        try {
          await invoke("save_prompt", {
            name: `${name.trim()} - ${selectedTemplate.name}`,
            description: selectedTemplate.description,
            content: selectedTemplate.systemPrompt,
          });
        } catch (err) { console.debug("[CreateProject] template prompt save failed:", err); }
      }
      onCreated();
      onClose();
    } catch (e) {
      setErr(String(e));
      setCreating(false);
    }
  };

  return (
    <Modal title="Create Project" onClose={onClose}>
      <div className="modal-field">
        <label>Template (optional)</label>
        <div className="template-picker">
          {PROJECT_TEMPLATES.map((t) => (
            <button
              key={t.name}
              className={`template-chip${selectedTemplate?.name === t.name ? " active" : ""}`}
              onClick={() => setSelectedTemplate(selectedTemplate?.name === t.name ? null : t)}
              title={t.description}
            >
              {t.name}
            </button>
          ))}
        </div>
        {selectedTemplate && (
          <div className="template-desc">{selectedTemplate.description}</div>
        )}
      </div>
      <div className="modal-field">
        <label>Project name</label>
        <input
          ref={inputRef}
          className="modal-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
          placeholder="my-project"
        />
      </div>
      <div className="modal-field">
        <label>Parent directory</label>
        <input
          className="modal-input"
          value={parentDir}
          onChange={(e) => setParentDir(e.target.value)}
          placeholder="D:\Projects"
        />
      </div>
      <FolderTree selected={parentDir} onSelect={setParentDir} />
      <div className="modal-checkbox">
        <input
          type="checkbox"
          id="git-init"
          checked={gitInit}
          onChange={(e) => setGitInit(e.target.checked)}
        />
        <label htmlFor="git-init">Initialize git repository</label>
      </div>
      {err && <div className="modal-error">{err}</div>}
      <div className="modal-buttons">
        <button className="modal-btn" onClick={onClose}>Cancel</button>
        <button className="modal-btn primary" onClick={handleCreate} disabled={creating}>
          {creating ? "Creating..." : "Create"}
        </button>
      </div>
    </Modal>
  );
}
