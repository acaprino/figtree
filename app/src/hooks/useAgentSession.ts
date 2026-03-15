import { invoke, Channel } from "@tauri-apps/api/core";
import type { AgentEvent, SessionInfo } from "../types";

export async function spawnAgent(
  tabId: string,
  projectPath: string,
  model: string,
  effort: string,
  systemPrompt: string,
  skipPerms: boolean,
  onEvent: (event: AgentEvent) => void,
): Promise<Channel<AgentEvent>> {
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;

  await invoke("spawn_agent", {
    tabId,
    projectPath,
    model,
    effort,
    systemPrompt,
    skipPerms,
    onEvent: channel,
  });

  return channel;
}

export async function sendAgentMessage(tabId: string, text: string): Promise<void> {
  await invoke("agent_send", { tabId, text });
}

export async function resumeAgent(
  tabId: string,
  sessionId: string,
  projectPath: string,
  model: string,
  effort: string,
  onEvent: (event: AgentEvent) => void,
): Promise<Channel<AgentEvent>> {
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;

  await invoke("agent_resume", {
    tabId,
    sessionId,
    projectPath,
    model,
    effort,
    onEvent: channel,
  });

  return channel;
}

export async function forkAgent(
  tabId: string,
  sessionId: string,
  projectPath: string,
  model: string,
  effort: string,
  onEvent: (event: AgentEvent) => void,
): Promise<Channel<AgentEvent>> {
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;

  await invoke("agent_fork", {
    tabId,
    sessionId,
    projectPath,
    model,
    effort,
    onEvent: channel,
  });

  return channel;
}

export async function killAgent(tabId: string): Promise<void> {
  await invoke("agent_kill", { tabId });
}

export async function respondPermission(tabId: string, allow: boolean): Promise<void> {
  await invoke("agent_permission", { tabId, allow });
}

export async function setAgentModel(tabId: string, model: string): Promise<void> {
  await invoke("agent_set_model", { tabId, model });
}

export async function listAgentSessions(cwd?: string): Promise<SessionInfo[]> {
  return invoke<SessionInfo[]>("list_agent_sessions", { cwd: cwd || null });
}

export async function getAgentMessages(sessionId: string, dir?: string): Promise<unknown> {
  return invoke("get_agent_messages", { sessionId, dir: dir || null });
}

export interface SidecarStatus {
  available: boolean;
  reason: string | null;
}

export async function getSidecarStatus(): Promise<SidecarStatus> {
  return invoke<SidecarStatus>("sidecar_available");
}
