# Team Agents & Custom Subagents Integration

**Date:** 2026-03-31
**Status:** Approved
**Approach:** Multi-Sidecar Nativo (Approach 1)

## Overview

Integrate Claude Code's two multi-agent features into the GUI:

1. **Custom Subagents** (stable) — predefined agent configs in `.claude/agents/*.md`, delegated to by the lead agent or launched directly via `--agent` mode
2. **Agent Teams** (experimental) — multiple independent Claude Code sessions coordinating via shared task lists and inter-agent messaging, displayed in a tmux-style split view

## Architecture: Multi-Sidecar

Each agent in a team runs as an **independent sidecar process**. The lead is the existing sidecar; teammates are additional sidecar processes spawned by the Rust backend when the SDK reports new team members.

### Flow

```
Single session (1 sidecar, 1 XTermView)
    |
    v  User asks for team work / SDK spawns teammates autonomously
    |
    v  SDK emits TaskStarted { agentId, role, name } via sidecar stdout
    |
    v  Sidecar detects new agentId not in known members set, emits
    |  "team_member_joined" event to Rust backend
    |
    v  Rust backend: spawns additional sidecar per teammate
    |     - Same cwd (project directory)
    |     - Env: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=true (all sidecars)
    |     - Each sidecar has unique teamAgentId
    |     - Added to same Win32 Job Object (killed on tab close)
    |
    v  Frontend: transforms tab into TeamView (split-view)
         - Lead: left panel (existing xterm)
         - Teammates: additional xterm panels
         - Coordination Panel: right drawer
```

### Data Structures

#### Rust Backend (sidecar.rs)

```rust
struct TeamMember {
    agent_id: String,
    tab_id: String,         // parent tab
    role: String,           // "lead" | "teammate"
    name: String,           // "code-reviewer", "test-writer", etc.
    sidecar_pid: u32,
    channel: Sender<SidecarEvent>,
}

struct TeamState {
    members: Vec<TeamMember>,
}
```

#### Frontend (types.ts)

```typescript
interface TeamMember {
  agentId: string;
  name: string;
  role: "lead" | "teammate";
  status: "working" | "idle" | "waiting" | "disconnected";
  model?: string;
}

interface TeamTask {
  id: string;
  description: string;
  assignee?: string;       // agentId
  status: "pending" | "in_progress" | "completed";
}

interface InterAgentMsg {
  from: string;            // agentId
  to: string;              // agentId or "all"
  content: string;
  timestamp: number;
}

interface TeamState {
  active: boolean;
  members: TeamMember[];
  tasks: TeamTask[];
  messages: InterAgentMsg[];
}

// Tab extended
interface Tab {
  // ...existing fields...
  teamState?: TeamState;
  agentName?: string;      // if set, session runs as this agent
}
```

### Communication

- Each sidecar communicates with Rust backend over same Tauri IPC channel
- Events tagged with `agentId` for routing to correct panel
- Coordination events (TaskStarted, TaskProgress, TaskNotification) feed the Coordination Panel
- Frontend demultiplexes: `event.agentId -> correct XTermView panel`

### Extended Protocol — New Commands

```jsonc
// Send message to specific teammate
{ "cmd": "send", "tabId": "...", "agentId": "teammate-1", "text": "focus on edge cases" }

// Kill single teammate
{ "cmd": "kill_teammate", "tabId": "...", "agentId": "teammate-2" }
```

## Frontend: TeamView (tmux-style Split View)

### Layout

```
+-- project (team) ------------------------------------------------- x -+
|                                                    | Team Panel        |
|  +- Lead -------------------+ +- code-reviewer ---+|                   |
|  | > working on auth        | | > reviewing auth  || Tasks             |
|  |   module refactor...     | |   Found 3 issues..|| [ ] Refactor auth |
|  |                          | |                   || [x] Review code   |
|  |                          | |                   || [ ] Write tests   |
|  +-------- -----------------+ +-------------------+|                   |
|  | test-writer -------------| |                   || Messages          |
|  | > waiting for task...    | |                   || lead->reviewer:   |
|  |                          | |                   ||  "check auth"     |
|  |                          | |                   || reviewer->lead:   |
|  +-------- -----------------+ +-------------------+|  "3 issues found" |
+----------------------------------------------------+-------------------+
| OPUS [1M]  |  max  |  skip all  |  team: 3 agents                     |
+------------------------------------------------------------------------+
```

### Components

- **TeamView.tsx** — Replaces AgentView when tab is in team mode. Contains:
  - N `XTermView` panels in auto-grid (1=full, 2=side-by-side, 3-4=2x2)
  - Each panel has header: agent name + role + status badge (working/idle/waiting)
  - Panels resizable via drag handles
- **TeamCoordinationPanel.tsx** — Right drawer (toggle Ctrl+B, reuses RightSidebar pattern):
  - **Tasks tab**: Shared task list with status and assignments
  - **Messages tab**: Chronological inter-agent message timeline
  - **Members tab**: Team member list with status, model, role
- **InfoStrip** — Updated to show "team: N agents" in team mode

### Transition: Single -> Team

When SDK emits first `TaskStarted` with a new `agentId`:
1. Update `tab.teamState` with new member
2. Swap `AgentView` -> `TeamView` (existing terminal becomes "Lead" panel, new panels added)
3. Animation: panels slide in from right

### Transition: Team -> Single

When all teammates terminate (tasks complete or killed):
1. Layout reverts to single panel automatically
2. Lead stays active, `teamState.active = false`
3. User can also force: "Dissolve team" in Coordination Panel kills all teammates

## Sidecar & SDK Integration

### Enable Agent Teams

```javascript
// sidecar.js — on session creation
process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "true";
```

The SDK handles teammate spawning internally. The lead agent decides when to create a team based on the user's task.

### Team Events from SDK

Already defined in types.ts and forwarded by sidecar:
- `task_started` — `{ agentId, taskDescription, assignee }`
- `task_progress` — `{ agentId, taskId, status, summary }`
- `task_notification` — `{ agentId, from, to, message }`

In team mode these events carry different `agentId` values for each member.

## Custom Subagents (Stable Feature)

### Run-as-Agent at Launch

Optional "Run as agent" dropdown in NewTabPage. Populated from the filesystem scan (`list_agent_definitions` Rust command) since no active session exists yet at launch time. Passes `agent: "name"` to SDK `query()`.

### Filesystem Agent Scanning

New Rust command scans `.claude/agents/*.md` (project) and `~/.claude/agents/*.md` (global), parses YAML frontmatter + body:

```rust
#[tauri::command]
fn list_agent_definitions(project_path: String) -> Vec<AgentDefinition>
```

Returns richer metadata than `supportedAgents()` (which only returns name/description/model).

### Programmatic Agent Injection

Sidecar accepts `agents` field in create command for programmatic definitions (no files required):

```javascript
const opts = {
  // ...existing...
  agent: cmd.agent,     // run-as-agent
  agents: cmd.agents,   // programmatic definitions
};
```

### No Editor

The GUI is a consumer/launcher only. Users create `.claude/agents/*.md` files manually or via Claude Code itself.

## Error Handling & Lifecycle

### Teammate Crash

- Panel shows inline "Agent disconnected" with "Restart" button
- Lead continues — no dependency on teammates
- Coordination Panel updates member status to "disconnected"

### Tab Close

- Kills all sidecars (lead + teammates) via Win32 Job Object
- Existing "agent running" confirmation dialog is sufficient

### Permissions

- Each teammate inherits `permMode` from lead by default
- Permission requests appear in the teammate's specific panel
- `skip all` propagates to all teammates

### Rate Limiting

- Rate-limited teammate shows countdown in its panel
- Other agents continue working

### Resource Limits

- ~50-80MB per additional Node.js sidecar process
- Max 5 teammates per tab (+ lead = 6 total)
- Excess spawn requests rejected with warning in Coordination Panel
