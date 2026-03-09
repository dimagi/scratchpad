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

## 2026-03-06 20:57 UTC — Claude - Martin's session (UTC-6)

Created `infrastructure_design.md` covering infrastructure requirements for the case search endpoints feature. Investigated production topology via `commcare-hq` and `commcare-cloud` codebases. Key findings and decisions:

- **Multi-tenancy**: Same flat-schema, name-based approach as UCR (`projectdb_<domain>_<case_type>_<hash>`). No schema-per-domain or DB-per-domain isolation.
- **Database placement**: Introduce `project_db` engine ID in `REPORTING_DATABASES`, defaulting to `ucr` alias (already isolated on its own RDS instance). Deployments needing more isolation can point it at a dedicated instance via config only, no code change.
- **Backend-agnostic endpoint**: Global `CASE_SEARCH_BACKEND` setting selects ES or SQL. Factory function resolves backend at call time. Swapping requires only config change + redeploy.
- **Partitioning**: No PG table partitioning needed initially — tables are naturally scoped by domain+case_type. PL/Proxy sharding does not apply. FK constraints should not be enforced (async write order not guaranteed).
- **Conflict flagged**: `pg_trgm` and `fuzzystrmatch` are **not installed** on any CommCare HQ database in production. The query builder design's `fuzzy_match` and `phonetic_match` SQL components depend on these extensions. They would need to be explicitly added to commcare-cloud provisioning, or be designated ES-only components until that happens.
- **Open question added**: UCR DB headroom — project DB defaults to sharing `rds_pgucr0`; sizing should be assessed before launch.

## 2026-03-09 — Claude - Ethan's session (UTC-5)

Reviewed Martin's additions (`CLAUDE.md`, `infrastructure_design.md`, `log.md`). Key observations:

- **Infrastructure doc resolves several open questions** from `project_db_design.md`: database placement (Q1), multi-tenancy model (Q2), phonetic/fuzzy search availability (Q4), geo queries (Q5). These should be reconciled — the open questions in `project_db_design.md` can be marked as resolved with cross-references to `infrastructure_design.md`.

- **Remaining open questions** in `project_db_design.md` that are NOT yet addressed by the infrastructure doc: data dictionary completeness (Q3), backfill performance (Q6), relationship ambiguity (Q7).

- **No conflicts detected** between the infrastructure doc and the existing design docs. The decisions are consistent with what was discussed in Ethan's earlier session (SQLAlchemy Core, `ConnectionManager`, FK constraints not enforced, append-only schema evolution).

Prior session activity (Ethan, 2026-03-05 through 2026-03-07):

- Created `query_builder_design.md` — full technical design for the configurable query builder (backend capability declaration, component catalog, filter spec JSON format, auto-defined values, UI rendering logic)
- Created `project_db_design.md` — technical design for auto-generated PostgreSQL tables (SQLAlchemy Core, table-per-case-type, typed columns, FK relationships, upsert-based population, cross-relationship JOINs)
- Created `case-search-endpoints-overview.html` — PM-facing visual summary
- Created `query-builder-mockup.html` — UI mockup in CommCare form-builder style
- **Key decisions made**: SQLAlchemy Core (not Django ORM, not raw SQL) for schema/DDL/queries; backend defines operations + field type compatibility (not field-specific); ancestor/subcase queries out of scope for initial design; development to be entirely test-driven
- **PoC priorities established**: Schema generation → Data population → Cross-relationship queries (JOINs) → Performance at scale → Query translation (deferred)

## 2026-03-09 — Claude - Ethan's session (UTC-5) — Implementation

Implemented the full project DB PoC on branch `es/project-db` in commcare-hq. Used subagent-driven development with TDD. 16 commits total.

**Modules created** (`corehq/apps/project_db/`):
- `schema.py` — table name generation, SQLAlchemy Table builder (fixed + dynamic + relationship columns), data dictionary integration (`build_tables_for_domain`)
- `populate.py` — case upsert via `INSERT ... ON CONFLICT`, type coercion (date/number), `case_to_row_dict` bridge from `CommCareCase`
- `table_manager.py` — DDL creation, append-only schema evolution (add columns + indexes)

**Code review findings addressed:**
- Fixed `case_json` key collision risk by namespacing dynamic properties under `prop.` prefix in the intermediate dict format
- Added DDL name validation (regex guard against SQL injection from user-editable property names)
- Added `owner_id` and `modified_on` indexes per design doc
- Extended `evolve_table` to create missing indexes alongside missing columns

**Refactoring:**
- Consolidated 6 modules → 3: `schema_gen` merged into `schema`, `coerce` and `case_adapter` merged into `populate`
- Organized files by newspaper metaphor (public API at top, private helpers below)
- Namespaced dynamic properties behind `prop.` prefix in `case_data` dicts, eliminating collision guard

**Test results:**
- 82 tests passing (schema, DDL, upsert, coercion, case adapter, cross-relationship JOINs)
- JOIN query performance: ~18ms for 11k rows with parent district filter
- Performance test file removed from branch (was marked `@slow`, can be recreated)

**Design decision: `prop.` namespace in case_data dicts**
- Keys use three namespaces: bare names for fixed fields (`case_id`), `prop.<name>` for dynamic properties, `indices` for relationships
- Maps to column names: `prop.first_name` → `prop_first_name` column
- Eliminates ambiguity between fixed fields and dynamic properties from `case_json`
