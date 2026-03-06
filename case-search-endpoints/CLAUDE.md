# Case Search Endpoints — Project Instructions

## Purpose

This directory is a collaborative workspace for designing and planning the case search endpoints feature (project databases + configurable query builder). Work proceeds in three phases:

1. **Spec / Design** — explore approaches, identify trade-offs, surface issues
2. **Implementation Plan** — break down into actionable tasks, sequence work
3. **Implementation** — write code (not started yet)

Multiple human developers and AI agents may be working in parallel across different sessions.

## AI Role (Phases 1 & 2)

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

### Conflicts

If you notice conflicting assumptions, decisions, or designs across documents or log entries, flag them explicitly rather than silently picking one interpretation.

### Speculation

Be explicit when reasoning from established facts vs. speculating. Mark speculation clearly (e.g., "Speculating: ...").

## Version Control

Changes are tracked in git. Commit frequently — this is the safety net for document changes.

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
- "Open Questions" sections for unresolved design decisions
- "Out of Scope" sections to bound the work
