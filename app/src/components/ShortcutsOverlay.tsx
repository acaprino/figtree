import { memo, useEffect } from "react";

interface Props {
  onClose: () => void;
}

const SECTIONS = [
  {
    title: "Global",
    keys: [
      ["Ctrl+T", "New tab"],
      ["Ctrl+F4", "Close tab"],
      ["Ctrl+Tab", "Next tab"],
      ["Ctrl+Shift+Tab", "Previous tab"],
      ["Ctrl+1..9", "Jump to tab"],
      ["F1", "Toggle this overlay"],
      ["F12", "About"],
      ["Ctrl+U", "Usage stats"],
      ["Ctrl+Shift+P", "System prompts"],
      ["Ctrl+Shift+H", "Sessions browser"],
      ["Ctrl+Shift+S", "Session panel"],
      ["Ctrl+,", "Settings"],
    ],
  },
  {
    title: "Project Picker",
    keys: [
      ["Arrows", "Navigate"],
      ["Enter", "Launch project"],
      ["Tab", "Cycle perm mode"],
      ["F2", "Cycle effort"],
      ["F3", "Cycle sort"],
      ["F4", "Cycle model"],
      ["F5", "New project"],
      ["F6", "Open in Explorer"],
      ["F8", "Label project"],
      ["F10", "Quick launch"],
      ["Type", "Filter projects"],
      ["Esc", "Clear filter / close"],
    ],
  },
  {
    title: "Agent Session",
    keys: [
      ["Enter", "Submit message"],
      ["Shift+Enter", "New line"],
      ["Y / N / A", "Permission: yes / no / allow session"],
      ["Ctrl+C", "Interrupt agent"],
      ["Ctrl+B", "Toggle sidebar"],
      ["/", "Slash commands"],
      ["@", "Agent mentions"],
    ],
  },
  {
    title: "Sessions Browser",
    keys: [
      ["Arrows", "Navigate"],
      ["R", "Resume session"],
      ["F", "Fork session"],
      ["Enter", "View session"],
      ["Type", "Filter"],
      ["Esc", "Clear / close"],
    ],
  },
];

export default memo(function ShortcutsOverlay({ onClose }: Props) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "F1") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="shortcuts-overlay" onClick={onClose}>
      <div className="shortcuts-content" onClick={e => e.stopPropagation()}>
        <div className="shortcuts-title">Keyboard Shortcuts</div>
        <div className="shortcuts-grid">
          {SECTIONS.map(section => (
            <div key={section.title} className="shortcuts-section">
              <div className="shortcuts-section-title">{section.title}</div>
              {section.keys.map(([key, desc]) => (
                <div key={key} className="shortcuts-row">
                  <kbd className="shortcuts-key">{key}</kbd>
                  <span className="shortcuts-desc">{desc}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="shortcuts-footer">Press <kbd>F1</kbd> or <kbd>Esc</kbd> to close</div>
      </div>
    </div>
  );
});
