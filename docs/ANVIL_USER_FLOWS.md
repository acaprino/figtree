# Anvil -- User Flows

## 1. Core Flow: Launch Agent Session

```mermaid
flowchart TD
    A[App Launch] --> B[New Tab Page]
    B --> C{Configure Session}
    C --> D[Select Model<br/>sonnet/opus/haiku/1M]
    C --> E[Set Effort<br/>high/medium/low]
    C --> F[Set Permissions<br/>plan/accept edits/skip all]
    C --> G[Toggle Autocompact]
    D & E & F & G --> H[Select Project]
    H --> I{Launch Method}
    I -->|Enter / Double-click| J[Agent Session Starts]
    I -->|F10: Quick Launch| K[Quick Launch Modal]
    K --> L[Enter directory path]
    L --> M{Add to projects?}
    M -->|Yes| N[Saved + Launch]
    M -->|No| O[Temp session + Launch]
    N & O --> J
    J --> P{View Style}
    P -->|Terminal| Q[Terminal View<br/>xterm-style output]
    P -->|Chat| R[Chat View<br/>Markdown rendering]
```

## 2. Agent Session Interaction Loop

```mermaid
flowchart TD
    A[Agent Initialized] --> B{Input State}
    B -->|awaiting_input| C[User types message]
    C --> D{Input Type}
    D -->|Plain text| E[Submit message]
    D -->|/ prefix| F[Command Menu appears]
    D -->|@ prefix| G[Mention Menu appears]
    D -->|Drag & Drop| H[File attachment chips]
    D -->|Paste image| I[Image attachment]
    E --> J[Agent Processing]
    F --> K[Select command]
    K -->|/clear /compact /theme etc.| L[Local action]
    K -->|SDK skill| M[Skill invocation]
    G --> N[Select agent mention]
    N --> E
    J --> O{Agent Response}
    O -->|Text| P[Streaming assistant message]
    O -->|Tool call| Q[Tool card appears]
    O -->|Permission needed| R[Permission card]
    O -->|Thinking| S[Thinking block]
    O -->|Error| T[Error card]
    O -->|Result| U[Result bar: cost, tokens, turns]
    R --> V{User decision}
    V -->|Y: Yes| W[Allow once]
    V -->|A: Allow session| X[Allow for session]
    V -->|N: No| Y[Deny]
    W & X & Y --> J
    Q --> J
    P --> B
    U --> B

    B -->|processing| Z[Activity spinner<br/>Ctrl+C to interrupt]
    Z --> O
```

## 3. Session Management Flow

```mermaid
flowchart TD
    A[Session Panel<br/>Ctrl+Shift+S] --> B{Sessions list}
    B --> C[Select session]
    C --> D{Action}
    D -->|Enter / Click| E[Resume session<br/>in current tab]
    D -->|Ctrl+Enter| F[Resume in new tab]
    D -->|F key| G[Fork session<br/>in current tab]
    D -->|Ctrl+F| H[Fork in new tab]
    D -->|Right-click| I[Context menu]
    I --> J[Resume / Fork /<br/>Resume in New Tab /<br/>Fork in New Tab]

    K[Sessions Browser<br/>Ctrl+Shift+H] --> L{Full-page list}
    L --> M[Keyboard navigate]
    M --> N{Action}
    N -->|R| O[Resume]
    N -->|F| P[Fork]
    N -->|Enter| Q[View transcript<br/>TODO: not implemented]
```

## 4. Settings & Configuration Flow

```mermaid
flowchart TD
    A[Ctrl+, or Gear icon] --> B[Settings Modal]
    B --> C{Section}
    C --> D[Appearance<br/>14 theme cards]
    C --> E[Terminal Font<br/>Family + Size slider]
    C --> F[Chat Font<br/>Family + Size slider]
    C --> G[Directories<br/>Add/Remove/Toggle mode]
    C --> H[Behavior<br/>Toggles & controls]

    D --> D1[Click theme card]
    D1 --> D2[Theme applied instantly<br/>150ms crossfade]

    E --> E1[Select font family]
    E1 --> E2[Adjust size 10-24px]
    E2 --> E3[Live preview updates]

    G --> G1{Directory management}
    G1 --> G2[Add new path]
    G1 --> G3[Remove existing]
    G1 --> G4[Toggle container/single]
    G2 & G3 & G4 --> G5[Save & Rescan]

    H --> H1[View style: Terminal/Chat]
    H --> H2[Tab layout: Horizontal/Vertical]
    H --> H3[Sort order: alpha/last used/most used]
    H --> H4[Security gate: on/off]
    H --> H5[Autocomplete: on/off]
    H --> H6[Hide thinking: on/off]
    H --> H7[Marketplace global: on/off]
```

## 5. System Prompts Flow

```mermaid
flowchart TD
    A[Ctrl+Shift+P or<br/>Pencil icon] --> B[System Prompts Page]
    B --> C{Prompts list}
    C --> D[Toggle active/inactive<br/>checkbox]
    C --> E[Click Edit]
    C --> F[Click Delete]
    C --> G[Click + New Prompt]

    E --> H[Editor: pre-filled]
    G --> I[Editor: empty]
    H & I --> J{Edit fields}
    J --> K[Name]
    J --> L[Description]
    J --> M[Content textarea]
    K & L & M --> N{Action}
    N -->|Ctrl+Enter| O[Save prompt]
    N -->|Esc| P[Cancel]
    O --> Q[Prompt saved to .md file]
    Q --> R[Active prompts combined<br/>on next session launch]

    D --> S{Toggle state}
    S -->|Activate| T[Added to active_prompt_ids]
    S -->|Deactivate| U[Removed from active_prompt_ids]
```

## 6. Tab Management Flow

```mermaid
flowchart TD
    A[App] --> B{Tab Operations}
    B -->|Ctrl+T| C[New Tab<br/>Project Picker]
    B -->|Ctrl+F4| D[Close active tab]
    B -->|Ctrl+Tab| E[Next tab]
    B -->|Ctrl+Shift+Tab| F[Previous tab]
    B -->|Ctrl+1-9| G[Jump to tab N]
    B -->|F12| H[Toggle About]
    B -->|Ctrl+U| I[Toggle Usage]
    B -->|Ctrl+Shift+P| J[Toggle System Prompts]
    B -->|Ctrl+Shift+H| K[Toggle Sessions Browser]

    L[Tab types] --> M[new-tab: Project Picker]
    L --> N[agent: Active session]
    L --> O[about: Info page]
    L --> P[usage: Stats page]
    L --> Q[system-prompt: Prompt manager]
    L --> R[sessions: History browser]

    S[Tab indicators] --> T[Active: full opacity]
    S --> U[Inactive: dimmed]
    S --> V[Has new output: glow pulse]
    S --> W[Exit ok: green checkmark]
    S --> X[Exit error: red cross]
    S --> Y[Temporary: italic style]
    S --> Z[Closing: fade-out animation]
```

## 7. Right Sidebar Flow

```mermaid
flowchart TD
    A[Agent Session] --> B{Toggle Sidebar}
    B -->|Ctrl+B or button| C[Right Sidebar Open]
    C --> D{Select Tab}
    D --> E[Bookmarks<br/>User message list]
    D --> F[Minimap<br/>Canvas conversation overview]
    D --> G[Todos<br/>Agent task checklist]
    D --> H[Thinking<br/>All thinking blocks]
    D --> I[Agents<br/>Sub-agent task tree]

    E --> J[Click bookmark]
    J --> K[Scroll to message<br/>with highlight flash]

    G --> L[Todo states]
    L --> M[Pending: empty checkbox]
    L --> N[In Progress: filled circle]
    L --> O[Completed: checked box]

    I --> P[Agent states]
    P --> Q[Running: play icon + tool name]
    P --> R[Completed: checkmark + summary]
    P --> S[Failed: cross + summary]
```

## 8. Project Picker Navigation Flow

```mermaid
flowchart TD
    A[New Tab Page] --> B{Keyboard Input}
    B -->|Letters/numbers| C[Type-to-filter<br/>No explicit search field]
    B -->|Backspace| D[Delete last filter char]
    B -->|Esc| E{Filter active?}
    E -->|Yes| F[Clear filter]
    E -->|No| G[Close tab]
    B -->|Arrow Up/Down| H[Move selection]
    B -->|Page Up/Down| I[Jump 10 items]
    B -->|Home/End| J[Jump to first/last]
    B -->|Enter| K[Launch selected project]

    C --> L[Project list filters<br/>Case-insensitive match]
    L --> M[Selection resets to 0]

    N[Project item shows] --> O[Name or custom label]
    N --> P[CLAUDE.md badge]
    N --> Q[Git branch + dirty indicator]
    N --> R[Full path]
```
