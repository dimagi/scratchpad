# Project Databases: Technical Design

## Overview

Auto-generated PostgreSQL tables storing case data in a normalized,
relational schema — one table per case type per project, with typed
columns and foreign key relationships. No user-facing configuration.
Populated automatically from the change feed.

This system replaces or supplements both UCR and the Elasticsearch case
search index as the backend for case search, exports, reporting, and
integrations.

## Goals

- Provide a relational, schema'd representation of case data with no
  project-specific configuration
- Enable efficient cross-relationship queries (JOINs instead of
  multi-round-trip ID lookups)
- Store case properties with their declared data types
- Support append-only schema evolution (no rebuilds)
- Serve as a backend for the configurable query builder

## Data Model

### Table Per Case Type

Each case type in a project gets its own table. The table name is derived
from the domain and case type (e.g., `projectdb_<domain>_<case_type>`,
or a hash-based scheme to avoid name length issues).

#### Fixed Columns (all tables)

| Column          | Type        | Notes                                |
|-----------------|-------------|--------------------------------------|
| `case_id`       | UUID / text | Primary key                          |
| `owner_id`      | text        | FK to users/groups/locations         |
| `case_name`     | text        |                                      |
| `opened_on`     | timestamptz |                                      |
| `closed_on`     | timestamptz | Nullable                             |
| `modified_on`   | timestamptz |                                      |
| `closed`        | boolean     |                                      |
| `external_id`   | text        | Nullable                             |
| `server_modified_on` | timestamptz |                                 |

#### Dynamic Columns (from data dictionary)

Each case property declared in the data dictionary gets one or two
columns:

- **Raw column** (`prop_<name>`): always `text`, stores the original
  value as-is
- **Typed column** (`prop_<name>_<type>`): stores the value cast to its
  declared type (`integer`, `numeric`, `date`, `timestamptz`, `boolean`).
  Null if the raw value can't be coerced.

Text properties only get the raw column (no separate typed column
needed).

Example for a `patient` case type:

```
projectdb_myproject_patient
├── case_id           UUID  PK
├── owner_id          text
├── case_name         text
├── opened_on         timestamptz
├── ...
├── prop_first_name   text
├── prop_dob          text
├── prop_dob_date     date
├── prop_age          text
├── prop_age_numeric  numeric
└── prop_risk_level   text
```

### Relationships (Foreign Keys)

Case indices (parent/child, host/extension) are represented as foreign
key columns on the child table, referencing the parent table's
`case_id`.

For a `patient` case type with a `parent` index pointing to `household`:

```
projectdb_myproject_patient
├── ...
├── idx_parent        text  FK → projectdb_myproject_household(case_id)
└── ...
```

#### Open Questions — Relationships

- A case can have multiple indices of different types. Each gets its own
  FK column.
- What happens when the index target case type is ambiguous or
  inconsistent? (e.g., `parent` sometimes points to `household`,
  sometimes to `clinic`) Options:
  - Use the data dictionary relationship definitions as the source of
    truth; ignore non-conforming indices
  - Store the FK as plain text (no constraint) and leave joins to
    query time
- Should we store the index identifier (e.g., "parent") as a column
  name prefix, or use the relationship name from the data dictionary?

## Schema Management

### Source of Truth

The **data dictionary** defines the expected schema: case types, their
properties, property data types, and relationships between case types.

### Schema Evolution

All schema changes are **append-only**:

- New property → `ALTER TABLE ADD COLUMN` (nullable)
- Property type change → add a new typed column, keep the old one
  (or drop it if unused)
- New case type → `CREATE TABLE`
- New relationship → `ALTER TABLE ADD COLUMN` for the FK

No columns are dropped automatically. Removed properties simply stop
being populated. This means:

- Migrations are always trivial (add nullable column / create table)
- Full table rebuilds are never required for schema changes
- Data type recasting can be done with a SQL data migration if needed

### Migration Generation

When the data dictionary changes, we generate and apply Django
migrations (or raw SQL via a management command). This could be:

1. A Django `RunSQL` migration generated on the fly
2. A custom migration framework outside Django's ORM (since these
   tables don't correspond to Django models)
3. Direct `ALTER TABLE` statements applied by a management command

Option 2 or 3 seems more appropriate since these tables are
project-specific and dynamic.

## Population

### Write Path

Tables are populated from the change feed, similar to how UCR and ES
pillows work today:

1. Case change arrives via pillow / Kafka consumer
2. Look up the table for this domain + case type
3. Upsert the row: fixed columns from case metadata, dynamic columns
   from case properties (with type coercion for typed columns)
4. Update FK columns from case indices

#### Write-Time Costs

Significantly lower than UCR or ES:

- No related-doc lookups (data is normalized — parent data lives in the
  parent table, not denormalized into the child row)
- Simple upsert of a single row per case change
- Type coercion is cheap (parse string to date/number, null on failure)

#### Synchronous Option

For latency-sensitive projects, we may offer synchronous writes
(updating the project DB table in the same transaction as the case
save). This needs further investigation around:

- Transaction scope (same DB? different DB?)
- Failure handling (what if the project DB write fails?)
- Performance impact on the write path

### Backfill

For existing projects, a backfill process iterates all cases and
populates the tables. This is similar to a UCR rebuild but simpler
(no related-doc lookups, no complex indicator calculations).

## Query Interface

### For Case Search (Query Builder)

The project DB serves as a backend for the configurable query builder.
The `SQLCaseSearchBackend` translates a filter spec tree into SQL:

- **AND/OR/NOT** → `WHERE ... AND/OR ...`, `NOT (...)`
- **exact_match** → `prop_<name> = %s`
- **fuzzy_match** → trigram similarity or `ILIKE` with pg_trgm
- **phonetic_match** → requires a phonetic extension
  (e.g., `fuzzystrmatch`)
- **numeric comparisons** → `prop_<name>_numeric > %s`
- **date comparisons** → `prop_<name>_date > %s`
- **date_range** → `prop_<name>_date BETWEEN %s AND %s`
- **is_empty** → `prop_<name> IS NULL OR prop_<name> = ''`
- **starts_with** → `prop_<name> LIKE %s || '%%'`

Cross-relationship queries become JOINs:

```sql
SELECT p.case_id, p.case_name
FROM projectdb_myproject_patient p
JOIN projectdb_myproject_household h ON p.idx_parent = h.case_id
WHERE h.prop_district = 'Kamuli'
  AND p.prop_dob_date > '2020-01-01'
```

This replaces the current multi-round-trip approach and eliminates the
500k parent case limit.

### For Other Consumers

- **Exports**: `SELECT *` with optional JOINs for denormalized output
- **Reporting**: direct SQL queries or as a UCR-like datasource
- **APIs**: filtered queries with pagination
- **CLE**: same query interface as case search

## Indexing

At minimum:

- Primary key on `case_id`
- Index on `owner_id`
- Index on FK columns (for JOIN performance)
- Index on `modified_on` (for change-feed-style queries)
- Composite indexes on commonly filtered columns (TBD, possibly
  driven by usage patterns or explicit configuration)

For text search operations (fuzzy match, starts_with), consider:

- GIN index with `pg_trgm` for trigram similarity
- GiST index for phonetic matching

## Open Questions

1. **Database placement**: Same PostgreSQL instance as the main app DB?
   A separate database? A separate cluster? Tradeoffs around connection
   pooling, transaction scope, and operational complexity.

2. **Multi-tenancy model**: One schema per domain? One set of tables in
   a shared schema with domain prefixed names? Separate databases per
   domain?

3. **Data dictionary completeness**: How many projects have a
   well-populated data dictionary today? What's the bootstrapping story
   for projects that don't?

4. **Phonetic / fuzzy search in Postgres**: ES has built-in phonetic
   analysis. Postgres needs extensions (`fuzzystrmatch`,
   `pg_trgm`). Are these available in our managed Postgres instances?

5. **Geo queries**: ES has native geo-distance. Postgres needs PostGIS.
   Is that available / acceptable?

6. **Backfill performance**: For large projects (millions of cases),
   how long does initial population take? Can it be done incrementally?

7. **Relationship ambiguity**: When case indices don't conform to data
   dictionary definitions, what's the fallback behavior?

## Out of Scope (For Now)

- User/group/location reference tables (mentioned in the proposal but
  not detailed here)
- Reporting integration (UCR replacement)
- Data-first app development features
- Synchronous write path
- SQL sandboxing for direct user queries
