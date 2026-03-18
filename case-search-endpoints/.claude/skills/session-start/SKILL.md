---
name: session-start
description: Use at the start of every session to sync with the latest repo state, surface changes from other developers and agents, and orient before doing any work.
---

# Session Start

## Overview

Multiple developers and AI agents work on this project asynchronously across timezones. Running this skill at the start of every session ensures you are working from the latest state, aware of what changed since the last session, and not duplicating or contradicting work already done.

## Steps

1. Pull the latest changes:
```bash
git pull --rebase
```

2. Check your author identity for this session. Look up the correct name and timezone in:
   - `~/.claude/projects/.../memory/MEMORY.md` (auto-memory, if available)
   - `CLAUDE.md` → Author format examples under the Activity Log section

3. Read `log.md` — scan all entries since the last session you are aware of. Note:
   - Decisions made by other developers or agents
   - New documents created or significantly changed
   - Conflicts or contradictions with anything you already know about the project

4. Read `open_questions.md` — scan for:
   - Newly added questions or to-dos
   - Newly resolved questions that may affect documents you plan to work on

5. Surface a brief orientation summary to the developer before starting work:
   > "Since [date of last known entry]: [X log entries], [Y questions changed]. Notable: [1–2 most important changes]. Ready to proceed."

## Notes

- Never skip this skill even if you believe your context is current — another agent or developer may have pushed changes
- If the rebase produces conflicts in `log.md`, resolve them by keeping both entries (remote entry above, local entry below), then run `git rebase --continue`
- If you find contradictions between recent log entries and existing design documents, flag them before doing any other work — do not silently pick one interpretation
- Run `git status` after pulling to check for any uncommitted local changes left over from a previous session — surface these to the developer before proceeding
