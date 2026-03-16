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
- Serve as a backend for the configurable case search query builder

## Implementation Layer: SQLAlchemy Core

We use **SQLAlchemy Core** (not the ORM) for schema definition, DDL,
and query construction. This is a natural fit because:

- SQLAlchemy's `Table` / `Column` / `MetaData` API is designed for
  programmatic schema definition
- The expression language (`select()`, `where()`, `join()`) maps
  cleanly to the filter spec tree and composes naturally
- CommCare HQ already depends on SQLAlchemy — it's used extensively
  by UCR (`corehq/apps/userreports/`) and has existing connection
  infrastructure
- Clean separation from Django-managed models avoids ambiguity about
  what Django owns vs. what the project DB owns

### Connection Management

We use the existing `ConnectionManager` in `corehq/sql_db/connections.py`,
which bridges Django database settings to SQLAlchemy engines. This gives
us `connection_manager.get_engine()` pointed at the right database with
no separate connection management.

## Data Model

### Table Per Case Type

Each case type in a project gets its own table. The table name is derived
from the domain and case type (e.g., `projectdb_<domain>_<case_type>`,
or a hash-based scheme to avoid name length issues).

Tables are defined as SQLAlchemy `Table` objects bound to a `MetaData`
instance:

```python
metadata = MetaData()

patient_table = Table(
    'projectdb_myproject_patient', metadata,
    Column('case_id', Text, primary_key=True),
    Column('owner_id', Text, nullable=False),
    Column('case_name', Text),
    Column('opened_on', DateTime(timezone=True)),
    Column('closed_on', DateTime(timezone=True)),
    Column('modified_on', DateTime(timezone=True)),
    Column('closed', Boolean),
    Column('external_id', Text),
    Column('server_modified_on', DateTime(timezone=True)),
    Column('parent_id', Text),
    Column('host_id', Text),
    # Dynamic columns from data dictionary
    Column('prop__first_name', Text),
    Column('prop__dob', Text),
    Column('prop__dob__date', Date),
    Column('prop__age', Text),
    Column('prop__age__numeric', Numeric),
    Column('prop__risk_level', Text),
)
```

#### Fixed Columns (all tables)

| Column          | Type        | Notes                                |
|-----------------|-------------|--------------------------------------|
| `case_id`       | Text        | Primary key                          |
| `owner_id`      | Text        | FK to users/groups/locations         |
| `case_name`     | Text        |                                      |
| `opened_on`     | DateTime(tz)| Timestamp with timezone              |
| `closed_on`     | DateTime(tz)| Nullable                             |
| `modified_on`   | DateTime(tz)|                                      |
| `closed`        | Boolean     |                                      |
| `external_id`   | Text        | Nullable                             |
| `server_modified_on` | DateTime(tz) |                                |
| `parent_id`     | Text        | Nullable; `case_id` of parent index  |
| `host_id`       | Text        | Nullable; `case_id` of host index    |

#### Dynamic Columns (from data dictionary)

Each case property declared in the data dictionary gets one or two
columns:

- **Raw column** (`prop__<name>`): always `Text`, stores the original
  value as-is
- **Typed column** (`prop__<name>__<type>`): stores the value cast to its
  declared type (`Numeric`, `Date`, `DateTime(timezone=True)`, `Boolean`).
  Null if the raw value can't be coerced.

Text properties only get the raw column (no separate typed column
needed).

### Relationships

The two most common case index identifiers — `parent` and `host` —
are stored as fixed, nullable columns on every project DB table:

| Column      | Source                                          |
|-------------|-------------------------------------------------|
| `parent_id` | `CommCareCaseIndex` with `identifier='parent'`  |
| `host_id`   | `CommCareCaseIndex` with `identifier='host'`    |

These are plain Text columns with no foreign key constraints (the async
change feed does not guarantee write order across case types). They
support JOINs at query time:

```python
patient = tables['patient']
household = tables['household']

query = (
    select(patient.c.case_id, patient.c.case_name)
    .join(household, patient.c.parent_id == household.c.case_id)
    .where(household.c.prop__district == 'Kamuli')
)
```

Cases without a parent or host index get NULLs in those columns.
Cases with non-standard index identifiers (e.g., custom relationship
names) are not captured by these columns; support for additional
index types can be added later if needed.

## Schema Management

### Source of Truth

The **data dictionary** defines the expected schema: case types, their
properties, property data types, and relationships between case types.

### Schema Generation

`build_tables_for_domain()` reads from the data dictionary and produces
SQLAlchemy `Table` objects. This is the single point of translation
between data dictionary models and the database schema.

```
Data Dictionary → build_tables_for_domain() → SQLAlchemy Table objects → DDL
```

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

### DDL Application

Schema changes are applied using SQLAlchemy's DDL capabilities:

- **Table creation**: `metadata.create_all(engine)` creates tables that
  don't yet exist (safe to call repeatedly — it's a no-op for existing
  tables)
- **Column additions**: `AddColumn` DDL construct, or direct
  `ALTER TABLE ADD COLUMN` via `engine.execute()`
- **Diffing**: Compare the current `Table` definition against the
  database's actual schema (via `inspect(engine)`) to determine what
  columns need to be added

This is outside Django's migration framework entirely — these tables
are not Django models and don't appear in `makemigrations`.

## Population

### Write Path

Tables are populated from the change feed, similar to how UCR and ES
pillows work today:

1. Case change arrives via pillow / Kafka consumer
2. Look up the `Table` object for this domain + case type
3. Upsert the row using SQLAlchemy's `insert().on_conflict_do_update()`:
   fixed columns from case metadata, dynamic columns from case
   properties (with type coercion for typed columns)
4. Update FK columns from case indices

```python
stmt = insert(patient_table).values(
    case_id=case.case_id,
    owner_id=case.owner_id,
    case_name=case.name,
    prop__dob=case.get_case_property('dob'),
    prop__dob__date=try_parse_date(case.get_case_property('dob')),
    parent_id=get_index_ref(case, 'parent'),
    host_id=get_index_ref(case, 'host'),
    ...
)
stmt = stmt.on_conflict_do_update(
    index_elements=['case_id'],
    set_={col.name: col for col in stmt.excluded},
)
engine.execute(stmt)
```

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
The `SQLCaseSearchBackend` translates a filter spec tree into
SQLAlchemy expressions:

- **AND/OR/NOT** → `and_()`, `or_()`, `not_()`
- **exact_match** → `table.c.prop__name == value`
- **not_equals** → `table.c.prop__name != value`
- **starts_with** → `table.c.prop__name.startswith(value)`
- **fuzzy_match** → `func.similarity(table.c.prop__name, value) > threshold`
  (with pg_trgm)
- **phonetic_match** → `func.soundex(table.c.prop__name) == func.soundex(value)`
  (with fuzzystrmatch)
- **numeric comparisons** → `table.c.prop__name__numeric > value`
- **date comparisons** → `table.c.prop__name__date > value`
- **date_range** → `table.c.prop__name__date.between(start, end)`
- **is_empty** → `or_(table.c.prop__name == None, table.c.prop__name == '')`

Cross-relationship queries become SQLAlchemy JOINs:

```python
patient = tables['patient']
household = tables['household']

query = (
    select(patient.c.case_id, patient.c.case_name)
    .join(household, patient.c.parent_id == household.c.case_id)
    .where(and_(
        household.c.prop__district == 'Kamuli',
        patient.c.prop__dob__date > date(2020, 1, 1),
    ))
)
```

This replaces the current multi-round-trip approach and eliminates the
500k parent case limit.

### For Other Consumers

- **Exports**: `select()` with optional `.join()` for denormalized output
- **Reporting**: direct SQL queries or as a UCR-like datasource
- **APIs**: filtered queries with `.limit()` / `.offset()`
- **CLE**: same query interface as case search

## Indexing

At minimum:

- Primary key on `case_id`
- Index on `owner_id`
- Index on `parent_id` and `host_id` (for JOIN performance)
- Index on `modified_on` (for change-feed-style queries)
- Composite indexes on commonly filtered columns (TBD, possibly
  driven by usage patterns or explicit configuration)

For text search operations (fuzzy match, starts_with), consider:

- GIN index with `pg_trgm` for trigram similarity
- GiST index for phonetic matching

These are defined as SQLAlchemy `Index` objects on the `Table` and
created alongside the table via `metadata.create_all()`.

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

7. ~~**Relationship ambiguity**~~: Resolved. Fixed `parent_id` and
   `host_id` columns cover the common cases. Non-standard index
   identifiers are simply not captured; support can be added later.

8. **ProjectDB class to manage state**: Currently, callers need to
   juggle SQLAlchemy engines, MetaData objects, connections, and
   `search_path` settings. Explore a `ProjectDB(domain)` class that
   encapsulates this state — holding the engine, schema name, and
   table references — and provides a clean interface for common
   operations (sync tables, get a scoped connection, upsert cases).
   This would reduce the amount of SQLAlchemy knowledge needed by
   management commands, the change feed processor, and other callers.

9. **Restricted database role per domain**: `SET LOCAL search_path`
   scopes unqualified name resolution but does not prevent access to
   other schemas via fully-qualified names (e.g. `public.auth_user`).
   For true domain isolation — especially if we ever expose SQL
   querying beyond operator shell access — we'd need a PostgreSQL
   role per domain with `USAGE` and `SELECT` granted only on that
   domain's project DB schema, and `REVOKE` on `public`. This would
   require managing role lifecycle (create on domain setup, drop on
   teardown) and connecting as the restricted role for query
   execution, likely via a separate engine/connection pool. Worth
   exploring if project DB queries are ever exposed to non-operators.

## Out of Scope (For Now)

- User/group/location reference tables (mentioned in the proposal but
  not detailed here)
- Reporting integration (UCR replacement)
- Data-first app development features
- Synchronous write path
- SQL sandboxing for direct user queries
- Filter spec → SQLAlchemy query translation (deferred until the data
  model and query performance are validated)
