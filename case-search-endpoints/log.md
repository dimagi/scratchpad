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

## 2026-03-09 18:10 UTC — Claude - Martin's session (UTC-6)

Created `query_builder_tech_spec.md` — implementation spec for the case search endpoints feature. Key decisions made:

- **App location**: `corehq/apps/case_search/` (no new Django app)
- **Feature flag**: `CASE_SEARCH_ENDPOINTS` domain toggle
- **Data model**: `CaseSearchEndpoint` (id, domain, name, target_type, target_name, current_version, created_at, is_active) + `CaseSearchEndpointVersion` (id, endpoint, version_number, parameters, query, created_at). Split `target_type`/`target_name` from the start to avoid future migration.
- **Versioning**: Immutable versions, `current_version` pointer on endpoint, version rows never deleted. Apps can pin to a specific version number.
- **Deletion**: Soft delete (`is_active = False`) only.
- **Service layer**: `endpoint_service.py` contains all business logic. Views and future `api.py` (MCP) are thin wrappers calling the same functions.
- **Capability JSON**: Single endpoint `GET /capability/` returns all case types + fields + operations + auto_values grouped by field type. Source is data dictionary initially. `auto_values` keyed by field type so UI only shows relevant options per slot.
- **Query builder**: Standalone `partials/query_builder.html`, HTMX + Alpine.js + Bootstrap 5. Receives capability JSON as template variable, has no knowledge of search endpoints context.
- **Target**: Initially `project_db` only. `target_type`/`target_name` fields allow adding ES and view targets without migration.

## 2026-03-09 18:25 UTC — Claude - Martin's session (UTC-6)

Created `query-builder-implementation-plan.md` — 8-task TDD implementation plan for the query builder and case search endpoints feature. Key decisions resolved with Martin before writing:

- **PASSWORD fields**: Excluded from capability builder (not queryable)
- **Select field options source**: Data dictionary `CasePropertyAllowedValue` records (option a)
- **Service file naming**: `endpoint_service.py` (resolves inconsistency in tech spec between file tree and prose)
- **View base class**: `BaseProjectDataView` (matches `CSQLFixtureExpressionView` pattern)

**Task sequence**: Feature flag → Data models → Service layer → Capability builder → Views + URLs → List template → Edit template → Query builder Alpine.js partial

**Deferred items flagged in plan**:
- `geopoint`/`within_distance` unusable until PostGIS extensions provisioned (per `infrastructure_design.md`)
- Hard delete (currently deactivate-only)
- `api.py` for MCP access

## 2026-03-09 18:42 UTC — Claude - Martin's session (UTC-6)

Revised `query-builder-implementation-plan.md` and `query_builder_tech_spec.md` after plan review. Plan expanded from 8 to 9 tasks. Changes:

- **Added Task 5: Filter spec validation** — `validate_filter_spec()` checks tree structure, field existence, component/field compatibility, input slot completeness, parameter/auto_value refs. Raises `FilterSpecValidationError` caught by views → HTTP 400 + `{"errors": [...]}`. Also handles concurrent version number conflicts via `IntegrityError`.
- **Added `COMPONENT_INPUT_SCHEMAS`** to capability builder (Task 4) — maps each component to its input slots. Used by both validation and UI rendering. Included in capability JSON response as `component_schemas`.
- **Multi-slot support in query builder partial** (Task 9) — iterates `component_schemas[component]` instead of assuming single `value` slot. `date_range` now renders `start`/`end` inputs. Labels shown for multi-slot components.
- **XSS fix**: Replaced `{{ capability|safe }}` with `json_script` template tag in edit template (Task 8). Case property names are user-controlled.
- **Validation error display**: Added `validationErrors` to Alpine state, error alert with `<ul>` list before save button, cleared on re-save.
- **Round-trip tests**: Added `TestEndpointRoundTrip` class testing complex nested spec through create → retrieve → new version cycle.
- **Tech spec updates**: Added "Filter Spec Validation" section, "Component Input Schema" section with full `COMPONENT_INPUT_SCHEMAS` dict, updated UI section to describe multi-slot rendering and `json_script` usage, marked open questions 1 and 2 as resolved.

## 2026-03-10 — Claude - Ethan's session (UTC-5)

Continued project DB work on branch `es/project-db`.

**Relationship support removed:**
- Removed `relationships_by_type` param from `build_tables_for_domain`, `relationships` param from `build_table_for_case_type`
- Deleted `_build_relationship_columns`, all `idx_*` column generation, and relationship index creation
- Removed `indices` key handling from `case_to_row_dict` and `_build_values_dict` in `populate.py`
- Deleted `test_queries.py` (all cross-case-type JOIN tests)
- Test count: 82 → 62. Decision: re-add relationships later when design is clearer.

**Added `CaseTable` class** (`schema.py`):
- Lightweight handle initialized with `(domain, case_type)` for lazy access to project DB table metadata
- `table_name` — deterministic PG table name (no DB hit, `cached_property`)
- `dd_case_type` — `CaseType` model from data dictionary (`cached_property`, raises `DoesNotExist`)
- `get_desired_table_schema()` — SQLAlchemy `Table` built from data dictionary (method, not cached — schema can change between calls)
- `table_schema` — SQLAlchemy `Table` reflected from PostgreSQL via `autoload_with`, or `None` (`cached_property`, uses try/except `NoSuchTableError` instead of listing all tables)
- Uses Django's `cached_property` instead of manual sentinel pattern

**Current state:** 70 tests passing, 3 production modules (`schema.py`, `populate.py`, `table_manager.py`)

## 2026-03-10 01:58 UTC — Claude - Woody's session (UTC-6)

Created `additional_endpoint_requirements.md` — overflow document for functional and non-functional requirements that don't fit cleanly in other design docs. Document is currently a blank template with sections for functional and non-functional requirements.

## 2026-03-10 — Claude - Ethan's session (UTC-5)

Continued project DB work on branch `es/project-db`.

**Walked back `CaseTable` class:**
- Removed `CaseTable` and related commits entirely
- Kept only the table reflection functionality as standalone `get_case_table_schema(domain, case_type)` function
- Updated full-stack test to use `build_tables_for_domain` directly

**Relationship support re-added with simpler design:**
- **Decision**: Instead of dynamic `idx_<identifier>` columns derived from relationship metadata, use fixed `parent_id` and `host_id` columns on every table. These cover the two most common `CommCareCaseIndex` identifiers (`parent` and `host`). No FK constraints (async change feed doesn't guarantee write order).
- Added `parent_id` (Text, nullable) and `host_id` (Text, nullable) to `build_table_for_case_type` fixed columns
- Both columns get database indexes for JOIN performance
- `case_to_row_dict` extracts `referenced_id` from `case.live_indices` matching `identifier='parent'` and `identifier='host'`; cases without those indices get NULLs
- Non-standard index identifiers (custom relationship names) are not captured; can be added later
- **Open question Q7 (relationship ambiguity) marked resolved** in `project_db_design.md`
- Updated `project_db_design.md`: fixed columns table, example schema, population example, query example, indexing section

**Test cleanup:**
- Replaced raw `DROP TABLE` SQL in all test teardowns with `table.drop(engine, checkfirst=True)`
- Consolidated full-stack test into single test covering data dictionary → schema → DDL → populate → single-table query → cross-case-type JOIN

**Current state:** 74 tests passing, 3 production modules (`schema.py`, `populate.py`, `table_manager.py`)

## 2026-03-10 16:09 UTC — Claude - Woody's session (UTC-6)

Added two requirements to `additional_endpoint_requirements.md`:

- **Data Freshness** (functional): Web users must see case updates reflected immediately in subsequent endpoint searches. Two viable approaches documented: synchronous write during form submission, or local memory cache merged with endpoint results. Approach not yet decided.
- **Performance / USS** (non-functional): p95 targets for US Solutions projects — open case list (search + render): 3s; form submission: 3s.
