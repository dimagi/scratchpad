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
