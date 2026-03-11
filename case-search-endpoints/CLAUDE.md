# Case Search Endpoints — Project Instructions

## Goals

This directory is a collaborative workspace for designing and planning the case search endpoints feature (project databases + configurable query builder). The project has two goals:

1. **Improve developer skills and collaboration using AI tools** — create artifacts and develop code across a distributed team collaboratively via an AI-assisted process, in order to determine feasibility and an implementation plan for a foundational new CommCare feature in a short period of time. Learnings, updated Claude skills, and a repeatable process that can be applied to other areas of the codebase should be outputs of this work.

2. **Determine feasibility of case search endpoints using project database tables** — determine whether a project database can be built and used as a backend for a case search endpoint, and progress as far as possible toward a stable implementation that satisfies the requirements outlined in this repo.

Work proceeds in three phases:

1. **Spec / Design** — explore approaches, identify trade-offs, surface issues
2. **Implementation Plan** — break down into actionable tasks, sequence work
3. **Implementation** — write code (not started yet)

Multiple human developers and AI agents may be working in parallel across different sessions.

## Process

Developers and AI agents should follow a research → design → plan → implement cycle, as defined by the [Claude Superpowers plugin](https://claude.com/plugins/superpowers). Key principles:

- **Artifacts first** — focus on creating comprehensive design and planning artifacts before moving to implementation. Do not skip or compress phases.
- **Smallest possible scope** — split the research/design/plan/implement cycle into the smallest practical technical component before beginning each cycle.
- This process applies to both human developers and AI agents.

## AI Role

- Follow the research/design/plan/implement process above — do not move to a later phase without completing prior phases
- Explore alternative approaches and weigh them against each other
- Push back on proposals when there are meaningful concerns — but not aggressively
- Flag gaps, edge cases, and hidden assumptions in anything proposed
- Raise scope changes or open question resolutions for human decision — do not resolve them unilaterally
- Ask before making significant changes to existing documents
- No code until phase 3. Pseudocode, SQL, and JSON are fine.

## Collaboration

### Activity Log

Maintain `log.md` as an append-only log of significant activity: decisions, concerns raised, alternatives considered, open questions added or resolved.

- Read `log.md` at the start of each session to catch changes from other developers or agents
- Push entries often — after any meaningful discussion or document change
- Flag conflicts or contradictions with existing documents or prior log entries
- Entry format:

```
## YYYY-MM-DD HH:MM UTC — [Author, Timezone]

<content>
```

Author format examples: `Martin (UTC-6)`, `Claude - Martin's session`, `Claude - Ana's session`

### Open Questions

Maintain `open_questions.md` as the single source of truth for all open questions and uncompleted to-dos. It supersedes "Open Questions" sections in individual design documents.

- Read `open_questions.md` at the start of each session alongside `log.md`
- Capture new questions throughout the session as they surface in conversation or code
- Always prompt before pushing: "Do you have any open questions or to-dos from this session to capture?"
- When a question is resolved, move it to the Resolved section and update any affected documents

### Conflicts

If you notice conflicting assumptions, decisions, or designs across documents or log entries, flag them explicitly rather than silently picking one interpretation.

### Speculation

Be explicit when reasoning from established facts vs. speculating. Mark speculation clearly (e.g., "Speculating: ...").

## Version Control

Changes are tracked in git. Commit frequently — this is the safety net for document changes.

## Implementation Repository

The codebase where this feature will be implemented is at `../../commcare-hq` (relative to this directory).

## Domain Vocabulary

These terms are established — use them as-is:

- **UCR** — User Created Report
- **Pillow / change feed** — async case change processing pipeline (Kafka-based)
- **Data dictionary** — project-level schema definition (case types, properties, relationships)
- **CLE** — Case List Explorer
- **Project DB** — the auto-generated PostgreSQL tables described in `project_db_design.md`

## Document Conventions

Follow the style of existing documents:
- Plain markdown
- Tables for component/field catalogs
- JSON for filter spec examples
- "Open Questions" sections in design docs should cross-reference `open_questions.md` rather than maintain their own independent lists
- "Out of Scope" sections to bound the work
