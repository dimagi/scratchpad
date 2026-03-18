---
name: open-questions
description: Use when capturing, reviewing, or resolving open questions and to-dos. Triggered automatically throughout sessions when questions surface in conversation or code, before committing or pushing changes, and when answers are provided by team members.
---

# Open Questions Management

## Overview

`open_questions.md` is the single source of truth for all open questions and uncompleted to-dos across the project. It supersedes the "Open Questions" sections in individual design documents — those sections should cross-reference this file rather than maintain their own lists.

## When to Use This Skill

**During a session — capture when:**
- A question surfaces in conversation with no clear answer yet
- A design decision is explicitly deferred
- A conflict or gap is identified in a design document
- A `# TODO` comment is encountered in code
- Any item is flagged as needing follow-up

**Before pushing changes — always prompt:**
> "Before I commit, do you have any open questions or to-dos from this session to capture?"

If yes, capture them before the commit. If no, proceed.

**When a question is answered:**
- A developer answers a question in conversation
- A team member updates `open_questions.md` directly with a resolution

## Capturing New Questions

1. Run `git pull --rebase` to get the latest version of `open_questions.md`
2. **Immediately before editing**, use the Read tool on `open_questions.md` — the tool requires a fresh read or the Edit will fail
3. Check for duplicates before adding
4. Identify the appropriate category:
   - **Requirements**: unclear or unresolved requirements
   - **Technical**: unresolved technical design or implementation decisions
   - **Prioritization**: sequencing, scope, or priority decisions
   - **To-Dos**: concrete action items not yet completed (from conversation or `# TODO` in code)
5. Present inferred questions to the developer for approval before adding:
   > "I noticed the following open questions from our session — should I add them to `open_questions.md`?"
6. Append approved items to the appropriate section using the entry format below
7. Commit and push immediately — do not batch with other changes:
```bash
git add open_questions.md && git commit -m "questions: <brief description>" && git push
```

## Resolving Questions

### Single question

When one question is answered:

1. Run `git pull --rebase` first
2. **Immediately before editing**, use the Read tool on `open_questions.md`
3. Move the entry from its active section to the **Resolved** section at the bottom of `open_questions.md`
4. Add the resolution date and answer to the entry
5. Check whether the question appears (in any form) in design doc "Open Questions" sections — if so, remove or cross-reference it there too
6. Commit all changed files together:
```bash
git add open_questions.md <affected-docs> && git commit -m "questions: resolve <question summary>" && git push
```

### Multiple questions at once

When several answers are provided together:

1. Run `git pull --rebase` first
2. **Immediately before editing**, use the Read tool on `open_questions.md`
3. Move all answered entries to the Resolved section in one edit
4. Check design docs for cross-references to any of the resolved questions and update those too
5. Commit all changed files in one commit:
```bash
git add open_questions.md <affected-docs> && git commit -m "questions: resolve <N> questions — <brief summary>" && git push
```

### Question answered before it was captured

If a developer answers a question that was never formally added to the active list:

1. Add it **directly to the Resolved section** — do not add it to an active section first
2. Set both `*Raised:*` and `*Resolved:*` to today's date
3. Use the resolved entry format below

## Entry Format

### Active question
```
- [ ] **Q:** <question text> | *Raised:* YYYY-MM-DD | *By:* [Author] | *Docs:* [relevant doc(s)]
```

### To-Do
```
- [ ] **TODO:** <action item> | *Raised:* YYYY-MM-DD | *By:* [Author] | *Source:* [conversation or filename:line]
```

### Resolved entry
```
- [x] **Q:** <question text> | *Raised:* YYYY-MM-DD | *Resolved:* YYYY-MM-DD | **Answer:** <resolution summary>
```

## File Location

`open_questions.md` is in the root of this directory (`case-search-endpoints/`).

## Notes

- Always check for duplicates before adding a new entry
- `open_questions.md` supersedes "Open Questions" sections in individual design docs — do not maintain separate lists there
- When in doubt whether something is worth capturing, add it — it's easier to close a question than to rediscover it
- Tag questions with relevant docs so other agents and developers know the origin
