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

**Author format examples:**
- `Martin (UTC-6)`
- `Claude - Martin's session (UTC-6)`
- `Claude - Ana's session (UTC+1)`

**Get current UTC time:**
```bash
date -u +"%Y-%m-%d %H:%M UTC"
```

## Steps

1. Get current UTC timestamp with the command above
2. Pull the latest version of the repo to minimize conflicts:
```bash
git pull
```
3. Read `log.md` to check for recent entries that might conflict or provide context
4. Append the new entry at the bottom of `log.md`
5. Commit and push immediately — do not batch with other changes:
```bash
git add log.md && git commit -m "log: <brief description>" && git push
```

## Log File Location

`log.md` is in the root of this directory (`case-search-endpoints/`).

## Notes

- Never edit or delete existing entries — append only
- Flag conflicts with existing documents or prior log entries explicitly
- Mark speculation clearly: "Speculating: ..."
