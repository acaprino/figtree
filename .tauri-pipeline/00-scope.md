# Pipeline Scope

## Target
Full Tauri 2 desktop application - Anvil (Claude Code Agent SDK launcher with tabbed interface)

## Rust Backend Files
- app/src-tauri/src/main.rs
- app/src-tauri/src/sidecar.rs
- app/src-tauri/src/projects.rs
- app/src-tauri/src/commands.rs
- app/src-tauri/src/prompts.rs
- app/src-tauri/src/usage_stats.rs
- app/src-tauri/src/marketplace.rs
- app/src-tauri/src/autocomplete.rs
- app/src-tauri/src/logging.rs
- app/src-tauri/src/watcher.rs

## Frontend Files
- app/src/App.tsx, App.css
- app/src/main.tsx
- app/src/types.ts
- app/src/themes.ts
- app/src/contexts/ProjectsContext.tsx
- app/src/hooks/useTabManager.ts, useProjects.ts, useAgentSession.ts
- app/src/utils/sanitizeInput.ts, format.ts
- app/src/components/ChatView.tsx, ChatView.css
- app/src/components/TabBar.tsx, TabSidebar.tsx, TitleBar.tsx
- app/src/components/NewTabPage.tsx, ProjectList.tsx, SessionConfig.tsx
- app/src/components/InfoStrip.tsx, AboutPage.tsx, UsagePage.tsx
- app/src/components/SystemPromptPage.tsx, SessionBrowser.tsx, SessionPanel.tsx
- app/src/components/Modal.tsx, ErrorBoundary.tsx, AsciiLogo.tsx
- app/src/components/FolderTree.tsx, SegmentedControl.tsx, ShortcutsOverlay.tsx
- app/src/components/GsdPrimitives.tsx
- app/src/components/chat/ChatInput.tsx, MessageBubble.tsx, ToolCard.tsx
- app/src/components/chat/PermissionCard.tsx, ThinkingBlock.tsx, ThinkingIndicator.tsx
- app/src/components/chat/ThinkingPanel.tsx, ResultBar.tsx, RightSidebar.tsx
- app/src/components/chat/MinimapPanel.tsx, BookmarkPanel.tsx, TodoPanel.tsx
- app/src/components/chat/AttachmentChip.tsx, CommandMenu.tsx, MentionMenu.tsx
- app/src/components/chat/ErrorCard.tsx, AskQuestionCard.tsx, AgentTreePanel.tsx
- app/src/components/modals/SettingsModal.tsx, CreateProjectModal.tsx
- app/src/components/modals/LabelProjectModal.tsx, QuickLaunchModal.tsx

## Config Files
- app/src-tauri/tauri.conf.json
- app/src-tauri/Cargo.toml
- app/package.json

## Flags
- Rust Only: no
- Frontend Only: no
- Strict Mode: no

## Pipeline Phases
1. Rust Backend Review
2. Tauri IPC & Optimization
3. React Frontend Performance
4. Layout Composition
5. UI Polish & Animations
