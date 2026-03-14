/**
 * Built-in system prompt templates that ship with Anvil.
 * Users can toggle these on/off but cannot edit or delete them.
 * Each prompt is focused on a single behavior concern and kept
 * under 500 characters since it's appended to an already-large
 * system prompt.
 */

export interface BuiltinPrompt {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly content: string;
}

export const BUILTIN_PROMPTS: readonly BuiltinPrompt[] = [
  {
    id: "builtin-terse",
    name: "Terse Output",
    description: "Minimal explanations, just code and essential context",
    content: `Be terse. Avoid filler, preambles, and summaries. When editing code, show only what changed and why in one sentence. Do not restate the request. Do not say "Let me know if you need anything." Do not explain what code does unless the user asks. Prefer code blocks over prose. If a task needs no response beyond the code change, output nothing else.`,
  },
  {
    id: "builtin-plan-first",
    name: "Plan Before Acting",
    description: "Explain approach and get confirmation before making changes",
    content: `Before making any file changes, first outline your plan in a numbered list: what files you will modify, what changes you will make, and why. Wait for the user to confirm before proceeding. For trivial single-file changes (typos, one-line fixes), you may skip the plan and act directly. Always state assumptions that could affect the approach.`,
  },
  {
    id: "builtin-no-commit",
    name: "Never Auto-Commit",
    description: "Make changes but never create git commits unless explicitly asked",
    content: `NEVER create git commits, run git add, or stage files unless the user explicitly asks you to commit. When you finish a task, just report what you changed. Do not offer to commit. Do not suggest commit messages unless asked. The user manages their own git workflow.`,
  },
  {
    id: "builtin-diff-confirm",
    name: "Confirm Destructive Ops",
    description: "Show diffs and ask before any file deletion or large rewrite",
    content: `Before deleting any file, removing any function/class, or rewriting more than 50% of a file, stop and show what will be removed. Ask for explicit confirmation before proceeding. Never run destructive shell commands (rm, git clean, git reset --hard, DROP TABLE, etc.) without asking first. For file edits, prefer surgical changes over full rewrites.`,
  },
  {
    id: "builtin-match-style",
    name: "Match Codebase Style",
    description: "Strictly follow existing naming, formatting, and patterns",
    content: `Before writing code, examine nearby files to detect the project's conventions: indentation (tabs vs spaces, width), naming (camelCase, snake_case, PascalCase), quotes (single vs double), semicolons, import style, and error handling patterns. Match them exactly. Do not introduce new patterns, libraries, or abstractions unless the user asks. When in doubt, copy the style of the nearest similar code.`,
  },
  {
    id: "builtin-think-aloud",
    name: "Show Reasoning",
    description: "Think step-by-step and show your work for complex tasks",
    content: `For non-trivial tasks, think step-by-step. Show your reasoning: what you searched, what you found, what alternatives you considered, and why you chose your approach. When debugging, state your hypothesis before testing it. When the root cause is ambiguous, list the top 2-3 candidates ranked by likelihood. Keep reasoning concise — bullet points, not paragraphs.`,
  },
  {
    id: "builtin-security",
    name: "Security-Conscious",
    description: "Flag security issues and avoid introducing vulnerabilities",
    content: `When writing or reviewing code, actively watch for security issues: injection (SQL, XSS, command), hardcoded secrets, path traversal, insecure deserialization, missing input validation, and overly permissive permissions. Flag any you find, even if not directly related to the task. Never write code that logs secrets, disables TLS verification, or uses eval/exec on user input. Suggest safer alternatives.`,
  },
] as const;
