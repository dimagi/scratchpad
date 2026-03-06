# Infrastructure Design: Case Search Endpoints

## Overview

This document covers infrastructure requirements and open questions for the
case search endpoints feature, specifically:

- Multi-tenancy model and table management in production
- Database placement and performance isolation
- Backend-agnostic endpoint design
- Partitioning strategy
- Key assumptions and open questions

The design is grounded in the existing CommCare HQ production topology
(verified in `commcare-hq` and `commcare-cloud`).

## Production Database Topology

CommCare HQ runs **six separate RDS (PostgreSQL 14) instances** in production,
all traffic routed through pgbouncer in transaction mode:

| Django alias     | Instance          | Purpose                              |
|------------------|-------------------|--------------------------------------|
| `default`        | `rds_pgmain1`     | Main app: users, domains, accounting |
| `ucr`            | `rds_pgucr0`      | UCR reporting tables                 |
| `p1`–`p5`        | `rds_pgshard1–5`  | Form/case data (PL/Proxy, 1024 shards) |
| `synclogs`       | `rds_pgsynclog2`  | Sync logs                            |
| `auditcare`      | `rds_pgauditcare1`| Audit log                            |
| `formplayer`     | `rds_pgformplayer2`| Formplayer                          |

SQLAlchemy uses `NullPool` (no built-in pooling); pgbouncer handles connection
pooling. Any new engine plugs into the same pgbouncer infrastructure.

Self-hosted deployments typically run a single PostgreSQL instance with the
same logical separation via `REPORTING_DATABASES` settings.

## Multi-Tenancy: Table Naming

All project DB tables live in a **single schema** on a shared database
instance, differentiated by table name. This is the same model UCR uses.

Table name format:

```
projectdb_<domain>_<case_type>_<hash>
```

The hash is a short SHA1 suffix (8 chars) applied via the same
`get_table_name()` function UCR uses (`corehq/apps/userreports/util.py`),
keeping names within Postgres's 63-character limit. Following UCR's
`max_length=50` is safe and maintains compatibility with any CitusDB
deployments.

There is no schema-per-domain or database-per-domain isolation. Domain
separation is enforced at the application layer, not the database layer —
consistent with how UCR works today.

## Database Placement

Introduce a `project_db` engine ID in `REPORTING_DATABASES`, defaulting to
the `ucr` alias (already on its own isolated RDS instance):

```python
# settings.py
REPORTING_DATABASES = {
    'default': 'default',
    'ucr': 'ucr',
    'project_db': 'ucr',   # defaults to UCR instance; configurable per deployment
}
```

The `ConnectionManager` in `corehq/sql_db/connections.py` picks this up with
no changes. Getting an engine is:

```python
engine = connection_manager.get_engine('project_db')
```

For deployments that need full isolation (dedicated RDS instance), the
operator adds a `project_db` entry to `postgresql.yml` (using the existing
`custom` list in `SmartDBConfig`) and updates `REPORTING_DATABASES` to point
to it. No code changes required — only configuration.

The UCR DB (`rds_pgucr0`) is the appropriate default because:

- It is already isolated from the main app DB, so project DB queries cannot
  impact user management, domain config, or billing
- It uses the same pgbouncer infrastructure (no new connection routing needed)
- It is already excluded from Django migrations (`django_migrate = False`)

### Schema Management

Project DB tables are **outside Django's migration framework**, exactly like
UCR tables. They are created and evolved using SQLAlchemy DDL directly:

- Table creation: `metadata.create_all(engine)` (idempotent)
- Column additions: `ALTER TABLE ADD COLUMN` (nullable, append-only)
- No `makemigrations`, no migration files, no Django model definitions

## Backend-Agnostic Endpoint

The case search endpoint must not depend on which query backend is active.
A global setting selects the backend:

```python
# settings.py (default)
CASE_SEARCH_BACKEND = 'elasticsearch'  # or 'project_db'
```

The application layer resolves this at startup via a factory function:

```python
def get_case_search_backend(domain):
    if settings.CASE_SEARCH_BACKEND == 'project_db':
        return SQLCaseSearchBackend(domain)
    return ElasticCaseSearchBackend(domain)
```

Both backends implement the same interface defined in `query_builder_design.md`:
accept a bound filter spec tree, execute it, and return results. Swapping
backends requires only changing the setting and redeploying — no per-request
routing, no per-domain configuration.

This is consistent with how other global infrastructure toggles work in
CommCare HQ (e.g., `USE_PARTITIONED_DATABASE`).

## Partitioning

### Application-Level Partitioning (by design)

Project DB tables are already naturally partitioned by domain and case type:
one table per domain per case type. No further partitioning is needed at the
Postgres level for typical usage.

### PostgreSQL Table Partitioning

Not required for initial implementation. The expected query patterns (filter
by owner, by property values, by date range, JOINs across case types) are
well-served by column indexes.

If a single domain accumulates tens of millions of rows in one case type table,
`PARTITION BY RANGE (modified_on)` can be added later. The append-only schema
evolution model is compatible with this: a partitioned table can be introduced
without data loss by recreating the table as partitioned and backfilling.

### PL/Proxy Sharding

Not applicable. PL/Proxy sharding (used for form processing) distributes
write-heavy transactional data by hashing `form_id`/`case_id` across multiple
databases. Project DB tables are read-optimized with bulk upserts from the
change feed — a fundamentally different access pattern that does not benefit
from this approach.

### Foreign Key Constraints

FK columns (`idx_parent`, etc.) are defined for JOIN purposes but **FK
constraints are not enforced at the database level**. The change feed does not
guarantee write order — a child case may be written before its parent exists.
Enforcing constraints would cause spurious violations. Application-layer joins
using these columns are safe regardless.

## Open Questions

1. **UCR DB headroom**: Project DB tables default to sharing `rds_pgucr0` with
   UCR. The additional write load (one upsert per case change, per case type)
   and read load (case search queries) may exceed current capacity. UCR DB
   sizing and current utilization should be assessed before launch. If
   headroom is insufficient, a dedicated instance should be provisioned from
   the start rather than migrating under load.

2. **`pg_trgm` and `fuzzystrmatch` availability**: Neither extension is
   installed on any CommCare HQ database today (verified in commcare-cloud
   Ansible playbooks). The query builder design includes `fuzzy_match`
   (requires `pg_trgm`) and `phonetic_match` (requires `fuzzystrmatch`) as
   SQL backend components. These would need to be explicitly installed on the
   project DB instance. On RDS this is straightforward (`CREATE EXTENSION IF
   NOT EXISTS pg_trgm`), but it must be added to the commcare-cloud Ansible
   provisioning for the target database. Until resolved, these two components
   are ES-only and should be excluded from the SQL backend's capability
   declaration.

3. **PostGIS / geo queries**: The `within_distance` component requires PostGIS.
   Not currently installed. Lower priority than fuzzy/phonetic, but same
   resolution path.

4. **Data dictionary completeness**: Project DB tables are derived from the
   data dictionary. Projects with sparse or missing data dictionaries get
   incomplete or empty schemas. The bootstrapping story for existing projects
   needs to be defined before a production rollout — this is a prerequisite,
   not an implementation detail.

5. **Table count growth**: One table per domain per case type means potentially
   thousands of tables in a shared database. Postgres handles large table
   counts well, but catalog queries (e.g., `pg_tables`) can become slow above
   ~10k tables. This should be monitored and may inform whether a
   schema-per-domain model is worth revisiting at scale.

6. **`project_db` in commcare-cloud schema**: The `SmartDBConfig` class in
   commcare-cloud currently has hardcoded named fields for each known database
   (`main`, `ucr`, `synclogs`, etc.). Adding `project_db` as a first-class
   field (like `ucr`) would be cleaner than using the `custom` list, but
   requires a commcare-cloud change. This is a coordination dependency.

## Out of Scope

- Read replica configuration for `project_db` (can be added via
  `REPORTING_DATABASES` read/write splitting, same as UCR — not needed at launch)
- Connection pool tuning (pgbouncer pool sizes for `project_db` — operational
  concern, not a design decision)
- Synchronous write path (noted as a future option in `project_db_design.md`)
- SQL sandboxing for direct user queries
