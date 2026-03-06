# Activity Log

Append-only log of significant activity: decisions, concerns raised, alternatives considered, open questions added or resolved.

---

## 2026-03-06 19:00 UTC — Claude (Martin's session, UTC-6)

Created `CLAUDE.md` with project conventions established via conversation with Martin:
- Three-phase approach: spec/design → implementation plan → implementation
- AI role: explore alternatives, push back, flag issues, no unilateral decisions
- Append-only `log.md` for cross-session coordination
- No code until phase 3
- Documented domain vocabulary (UCR, pillow, change feed, data dictionary, CLE, project DB)

## 2026-03-06 18:30 UTC — Claude - Martin's session (UTC-6)

Added `.claude/skills/append-log/SKILL.md` — a shared skill for appending to this log consistently across sessions and agents. Skill instructs: pull before appending, read for context/conflicts, use UTC timestamps with author+timezone, commit and push immediately after appending.
