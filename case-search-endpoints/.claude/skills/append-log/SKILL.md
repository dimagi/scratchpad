---
name: append-log
description: Use when recording activity in the project log — after design decisions, alternatives considered, conflicts found, open questions added or resolved, or significant document changes.
---

# Append to Activity Log

## Overview

`log.md` is an append-only coordination log shared across developers and AI agents working in different timezones. Read it at the start of each session and write to it often.

## When to Log

- Design decisions made or rejected
- Alternatives explored and trade-offs identified
- Conflicts or contradictions found across documents
- Open questions added or resolved
- Significant changes to any design document

## Entry Format

```markdown
## YYYY-MM-DD HH:MM UTC — [Author (Timezone)]

<content>
```

**Author format — look this up, do not guess:**
Check `~/.claude/projects/.../memory/MEMORY.md` for the correct author name and timezone. If not found, check `CLAUDE.md` for the author format examples under the Activity Log section.

**Get current UTC time:**
```bash
date -u +"%Y-%m-%d %H:%M UTC"
```

## Steps

1. Get current UTC timestamp with the command above
2. Pull the latest version of the repo to minimize conflicts:
```bash
git pull --rebase
```
3. **Immediately before editing**, use the Read tool on `log.md` — even if you read it moments ago. The tool requires a fresh read in the same tool call sequence or the Edit will fail.
4. Insert the new entry at the **top of the existing entries**, immediately below the file header and `---` divider, so the most recent entry is always first.
5. Commit and push immediately — do not batch with other changes:
```bash
git add log.md && git commit -m "log: <brief description>" && git push
```

## Conflict Resolution

If `git pull --rebase` produces a conflict in `log.md`:
1. Open the file and locate the conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)
2. Keep **both** entries — place the remote entry above, your new entry below
3. Remove the conflict markers
4. Run `git rebase --continue`

## Log File Location

`log.md` is in the root of this directory (`case-search-endpoints/`).

## Notes

- Never edit or delete existing entries — append only
- Flag conflicts with existing documents or prior log entries explicitly
- Mark speculation clearly: "Speculating: ..."
