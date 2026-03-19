---
name: Root Cause First
description: "When something fails, stop and fix the root cause — never bypass or skip"
version: 1.1.0
---

# Root Cause First

## Core Principle

If a step in a prescribed process fails, **stop and fix the root cause**.
Do not skip, bypass, approximate, or replace the step.

Process integrity is more important than completing the task by other means.

Expected failures (e.g., TDD failing tests) are not errors.

## Mandatory Behavior

When a command or process fails unexpectedly:

1. **Stop the current task**
2. **Investigate the root cause**
3. **Fix the underlying issue**
4. **Verify the original command now works**
5. **Only then resume the task**

## Strict Prohibitions

Never:

- bypass the failing tool
- switch to another tool to get the result
- skip the failing step
- manually replicate what automation should do
- fabricate missing results
- approximate expected outputs

The fix must make **the original command or process succeed**.

## Workaround Warning Signals

If you find yourself thinking or writing phrases like:

- "instead"
- "alternatively"
- "directly"
- "manually"
- "skip"
- "fall back"
- "work around"
- "since this isn't working"

you are likely bypassing the problem.

Stop and fix the failure instead.

## Rule

Do not continue until **the original failing command works correctly**.