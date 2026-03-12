# Open Questions

Single source of truth for all open questions and uncompleted to-dos. Supersedes the "Open Questions" sections in individual design documents.

---

## Requirements Questions

- [ ] **Q:** For the data freshness requirement, which implementation approach should be used — synchronous write to the project DB as part of form submission, or a client/server memory cache merged with endpoint results? | *Raised:* 2026-03-10 | *By:* Woody | *Docs:* `additional_endpoint_requirements.md`
  - *Discussion 2026-03-12:* In-memory caching ruled out. **Baseline:** async pillow-based updates (eventual consistency) — acknowledged may not fully satisfy the requirement. **Preferred path:** synchronous write, contingent on performance validation (expected to be fast: simple transform, single-row upsert, no related data fetch). **Views:** regular PostgreSQL views preferred over materialized views; regular views reflect updates instantly and materialized views add complexity and constrain synchronous update flexibility. Treat materialized views as a potential optimization only. Pending: performance testing against production-scale data before committing to synchronous write path. Cross-case-type relationship freshness is a separate open question (see below).

---

## Technical Questions

- [ ] **Q:** Is there sufficient headroom on `rds_pgucr0` (the UCR RDS instance) to absorb project DB write load (one upsert per case change per case type) and read load (case search queries) before launch? A dedicated instance may need to be provisioned instead. | *Raised:* 2026-03-09 | *By:* Claude - Martin's session | *Docs:* `infrastructure_design.md`

- [ ] **Q:** `pg_trgm` and `fuzzystrmatch` extensions are not currently installed on any CommCare HQ database. They are required for `fuzzy_match` and `phonetic_match` SQL backend components. Do these need to be added to commcare-cloud Ansible provisioning before launch, or should these components remain ES-only for the initial release? | *Raised:* 2026-03-09 | *By:* Claude - Martin's session | *Docs:* `infrastructure_design.md`, `query_builder_design.md`

- [ ] **Q:** `within_distance` (geo queries) requires PostGIS, which is not currently installed. What is the priority and timeline for enabling this, if at all? | *Raised:* 2026-03-07 | *By:* Claude - Ethan's session | *Docs:* `infrastructure_design.md`, `query_builder_design.md`

- [ ] **Q:** Are regular PostgreSQL views performant enough at scale for the query builder, or will materialized views be required? Regular views reflect updates instantly but may have higher query-time cost; materialized views can be indexed but require a synchronous update strategy. Must be validated via performance testing before the synchronous write path is finalized. | *Raised:* 2026-03-12 | *By:* Woody | *Docs:* `project_db_design.md`, `additional_endpoint_requirements.md`

- [ ] **Q:** How should the data freshness requirement be handled for cross-case-type relationship queries on materialized view (e.g., a query spanning patient + household tables)? When does writing to a materialized view require a full view refresh?  Does it matter whether you write to the "main" table of the view vs a related one?. Requires additional design work before this case can be addressed. | *Raised:* 2026-03-12 | *By:* Woody | *Docs:* `additional_endpoint_requirements.md`, `project_db_design.md`

- [ ] **Q:** What is the bootstrapping story for projects with sparse or incomplete data dictionaries? Project DB tables are derived entirely from the data dictionary — projects that lack one will get empty or incomplete schemas. This must be defined before a production rollout. | *Raised:* 2026-03-07 | *By:* Claude - Ethan's session | *Docs:* `project_db_design.md`, `infrastructure_design.md`

- [ ] **Q:** For large projects (millions of cases), how long will the initial backfill take? Can it be done incrementally without blocking other operations? | *Raised:* 2026-03-07 | *By:* Claude - Ethan's session | *Docs:* `project_db_design.md`

- [ ] **Q:** At scale, one table per domain per case type could produce thousands of tables in the shared database. Postgres catalog queries can slow above ~10k tables. At what point does this become a concern, and should a schema-per-domain model be revisited? | *Raised:* 2026-03-09 | *By:* Claude - Martin's session | *Docs:* `infrastructure_design.md`

- [ ] **Q:** `SmartDBConfig` in commcare-cloud currently has hardcoded named fields for each known database. Should `project_db` be added as a first-class named field (like `ucr`) rather than using the `custom` list? Requires a commcare-cloud coordination change. | *Raised:* 2026-03-09 | *By:* Claude - Martin's session | *Docs:* `infrastructure_design.md`

- [ ] **Q:** When `api.py` is built for MCP / programmatic access, what authentication mechanism should it use (API key, OAuth, other)? Not needed for the HTML views but must be decided before MCP work begins. | *Raised:* 2026-03-09 | *By:* Claude - Martin's session | *Docs:* `query_builder_tech_spec.md`

---

## Prioritization Questions

- [ ] **Q:** Should there be a hard delete option for endpoints that have never been used or have no pinned app references, in addition to the current soft deactivate? | *Raised:* 2026-03-09 | *By:* Claude - Martin's session | *Docs:* `query_builder_tech_spec.md`

---

## Uncompleted To-Dos

- [ ] **TODO:** Build a management command to populate a project DB for a domain (e.g., BHA) and run performance benchmarks comparing regular views vs. materialized views and async vs. synchronous write paths. UAT and performance spaces have sufficient data for testing. | *Raised:* 2026-03-12 | *By:* Woody | *Source:* data freshness discussion

- [ ] **TODO:** Assess UCR DB (`rds_pgucr0`) sizing and current utilization to determine whether it can support project DB load before launch, or whether a dedicated instance needs to be provisioned. | *Raised:* 2026-03-09 | *By:* Claude - Martin's session | *Source:* `infrastructure_design.md`

- [ ] **TODO:** Add `pg_trgm` and `fuzzystrmatch` to commcare-cloud Ansible provisioning for the project DB target database if the decision is made to support fuzzy/phonetic SQL components at launch. | *Raised:* 2026-03-09 | *By:* Claude - Martin's session | *Source:* `infrastructure_design.md`

- [ ] **TODO:** Define the data dictionary bootstrapping story for existing projects before production rollout — what is the process for projects that lack a well-populated data dictionary? | *Raised:* 2026-03-07 | *By:* Claude - Ethan's session | *Source:* `project_db_design.md`

- [ ] **TODO:** Coordinate `project_db` addition as a named field in `SmartDBConfig` with the commcare-cloud team. | *Raised:* 2026-03-09 | *By:* Claude - Martin's session | *Source:* `infrastructure_design.md`

- [ ] **TODO:** Switch `PROJECT_DB_ENGINE_ID` from `'default'` to `'project_db'` once the database is configured. | *Raised:* 2026-03-09 | *By:* Claude - Ethan's session | *Source:* `implementation-plan.md`

- [ ] **TODO:** Implement relationship support (Task 6 in implementation plan) — currently deferred pending clearer design. | *Raised:* 2026-03-09 | *By:* Claude - Ethan's session | *Source:* `implementation-plan.md`

- [ ] **TODO:** Implement type coercion for typed columns (Task 9 in implementation plan). | *Raised:* 2026-03-09 | *By:* Claude - Ethan's session | *Source:* `implementation-plan.md`

---

## Resolved

- [x] **Q:** Where should project DB tables be placed — same PostgreSQL instance as the main app DB, a separate database, or a separate cluster? | *Raised:* 2026-03-07 | *Resolved:* 2026-03-09 | **Answer:** Introduce a `project_db` engine ID in `REPORTING_DATABASES` defaulting to the `ucr` alias (`rds_pgucr0`). Deployments needing isolation can point it at a dedicated instance via config only — no code changes required. See `infrastructure_design.md`.

- [x] **Q:** What multi-tenancy model should be used — schema-per-domain, DB-per-domain, or shared flat schema? | *Raised:* 2026-03-07 | *Resolved:* 2026-03-09 | **Answer:** Shared flat schema with name-based separation (`projectdb_<domain>_<case_type>_<hash>`), matching the UCR model. Domain separation enforced at the application layer. See `infrastructure_design.md`.

- [x] **Q:** How should case relationships be stored — dynamic `idx_<identifier>` columns, or a fixed set of FK columns? | *Raised:* 2026-03-07 | *Resolved:* 2026-03-09 | **Answer:** Fixed `parent_id` and `host_id` columns on every table covering the two most common index identifiers. Non-standard identifiers are not captured initially. No FK constraints enforced. See `project_db_design.md`.

- [x] **Q:** Should `PASSWORD` fields be included in the query builder capability? | *Raised:* 2026-03-09 | *Resolved:* 2026-03-09 | **Answer:** Excluded — not queryable. See `query_builder_tech_spec.md`.

- [x] **Q:** What should be the source for `select` field options in the query builder? | *Raised:* 2026-03-09 | *Resolved:* 2026-03-09 | **Answer:** Data dictionary `CasePropertyAllowedValue` records. See `query_builder_tech_spec.md`.
