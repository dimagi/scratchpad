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

1. Run `git pull` to get the latest version of `open_questions.md`
2. Read `open_questions.md` to check for duplicates
3. Identify the appropriate category:
   - **Requirements**: unclear or unresolved requirements
   - **Technical**: unresolved technical design or implementation decisions
   - **Prioritization**: sequencing, scope, or priority decisions
   - **To-Dos**: concrete action items not yet completed (from conversation or `# TODO` in code)
4. Present inferred questions to the developer for approval before adding:
   > "I noticed the following open questions from our session — should I add them to `open_questions.md`?"
5. Append approved items to the appropriate section using the entry format below
6. Commit and push immediately — do not batch with other changes:
```bash
git add open_questions.md && git commit -m "questions: <brief description>" && git push
```

## Resolving Questions

When a question is answered:

1. Run `git pull` first
2. Move the entry from its active section to the **Resolved** section at the bottom of `open_questions.md`
3. Add the resolution date and answer to the entry
4. Update any relevant design documents that referenced the question:
   - Remove or cross out the question in design doc "Open Questions" sections
   - Add a brief note pointing to the resolution if helpful
5. Commit all changed files together:
```bash
git add open_questions.md <affected-docs> && git commit -m "questions: resolve <question summary>" && git push
```

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
