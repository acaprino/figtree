import { invoke, Channel } from "@tauri-apps/api/core";

type PtyEvent =
  | { type: "output"; data: string }
  | { type: "exit"; code: number };

export async function spawnClaude(
  projectPath: string,
  toolIdx: number,
  modelIdx: number,
  effortIdx: number,
  skipPerms: boolean,
  autocompact: boolean,
  cols: number,
  rows: number,
  onOutput: (data: string) => void,
  onExit: (code: number) => void,
): Promise<{ sessionId: string; channel: Channel<PtyEvent> }> {
  const onEvent = new Channel<PtyEvent>();
  onEvent.onmessage = (msg) => {
    if (msg.type === "output") {
      onOutput(msg.data);
    } else if (msg.type === "exit") {
      onExit(msg.code);
    }
  };

  const sessionId = await invoke<string>("spawn_tool", {
    projectPath,
    toolIdx,
    modelIdx,
    effortIdx,
    skipPerms,
    autocompact,
    cols,
    rows,
    onEvent,
  });

  return { sessionId, channel: onEvent };
}

export async function writePty(sessionId: string, data: string): Promise<void> {
  await invoke("write_pty", { sessionId, data });
}

export async function resizePty(sessionId: string, cols: number, rows: number): Promise<void> {
  await invoke("resize_pty", { sessionId, cols, rows });
}

export async function killSession(sessionId: string): Promise<void> {
  await invoke("kill_session", { sessionId });
}

export async function sendHeartbeat(sessionId: string): Promise<void> {
  await invoke("heartbeat", { sessionId });
}

export async function saveClipboardImage(): Promise<string> {
  return invoke<string>("save_clipboard_image");
}
