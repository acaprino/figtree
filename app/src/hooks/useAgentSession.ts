import { invoke, Channel } from "@tauri-apps/api/core";
import type { AgentEvent, SessionInfo, PermissionSuggestion, SlashCommand, AgentInfoSDK } from "../types";

export async function spawnAgent(
  tabId: string,
  projectPath: string,
  model: string,
  effort: string,
  systemPrompt: string,
  permMode: string,
  plugins: string[],
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
    permMode,
    plugins,
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
  permMode: string,
  plugins: string[],
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
    permMode,
    plugins,
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
  permMode: string,
  plugins: string[],
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
    permMode,
    plugins,
    onEvent: channel,
  });

  return channel;
}

export async function interruptAgent(tabId: string): Promise<void> {
  await invoke("agent_interrupt", { tabId });
}

export async function killAgent(tabId: string): Promise<void> {
  await invoke("agent_kill", { tabId });
}

export async function respondPermission(tabId: string, allow: boolean, updatedPermissions?: PermissionSuggestion[]): Promise<void> {
  await invoke("agent_permission", { tabId, allow, updatedPermissions: updatedPermissions || null });
}

export async function respondAskUser(tabId: string, answers: Record<string, string>): Promise<void> {
  await invoke("agent_ask_response", { tabId, answers });
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

export async function saveClipboardImage(): Promise<string> {
  return invoke<string>("save_clipboard_image");
}

export async function requestAutocomplete(
  tabId: string,
  input: string,
  context: Array<{ role: string; content: string }>,
  seq: number,
): Promise<void> {
  await invoke("agent_autocomplete", { tabId, input, context, seq });
}

export async function refreshCommands(tabId: string): Promise<{ commands: SlashCommand[]; agents: AgentInfoSDK[] }> {
  return invoke("refresh_commands", { tabId });
}

export interface CliResult {
  success: boolean;
  stdout: string;
  stderr: string;
  url: string | null;
}

export async function runClaudeCommand(subcommand: string): Promise<CliResult> {
  return invoke<CliResult>("run_claude_command", { subcommand });
}
