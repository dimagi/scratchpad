# Project Database Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the Project Database system — auto-generated PostgreSQL tables storing case data in a normalized, relational schema — and validate suitability for real-world case search via tests.

**Architecture:** Data dictionary definitions (CaseType, CaseProperty) drive SQLAlchemy Core Table objects. Tables are created/evolved via DDL, populated via upserts from case data, and queried with SQLAlchemy expressions including cross-case-type JOINs. All code lives in a new `corehq/apps/project_db/` app.

**Tech Stack:** Python, SQLAlchemy Core, PostgreSQL, pytest, Django (for data dictionary models and test infrastructure)

---

## Reference: Key Existing Code

These files are the primary touchpoints. Read them before starting work.

| File | What to learn |
|------|---------------|
| `corehq/apps/data_dictionary/models.py` | `CaseType`, `CaseProperty` (with `DataType` enum), `CasePropertyGroup` |
| `corehq/form_processor/models/cases.py` | `CommCareCase` (fields, `case_json`, `get_case_property`), `CommCareCaseIndex` (fields, relationship types) |
| `corehq/sql_db/connections.py` | `ConnectionManager`, `SessionHelper`, `connection_manager.get_engine()` |
| `corehq/apps/userreports/util.py:203-226` | `get_table_name()` — reusable table name hashing |
| `corehq/apps/userreports/sql/adapter.py` | UCR's `build_table()`, `rebuild_table()`, `get_indicator_table()` — patterns to follow |

## Reference: Data Dictionary Data Types

`CaseProperty.DataType` values and their project DB column mapping:

| DataType | Value | Raw column (Text) | Typed column |
|----------|-------|--------------------|--------------|
| `PLAIN` | `'plain'` | `prop_<name>` | *(none — Text only)* |
| `DATE` | `'date'` | `prop_<name>` | `prop_<name>_date` (Date) |
| `NUMBER` | `'number'` | `prop_<name>` | `prop_<name>_numeric` (Numeric) |
| `SELECT` | `'select'` | `prop_<name>` | *(none — Text only)* |
| `GPS` | `'gps'` | `prop_<name>` | *(none — Text only, future PostGIS)* |
| `BARCODE` | `'barcode'` | `prop_<name>` | *(none — Text only)* |
| `PHONE_NUMBER` | `'phone_number'` | `prop_<name>` | *(none — Text only)* |
| `PASSWORD` | `'password'` | `prop_<name>` | *(none — Text only)* |
| `UNDEFINED` | `''` | `prop_<name>` | *(none — Text only)* |

Only `DATE` and `NUMBER` get a second typed column. All types get the raw Text column.

## Reference: Fixed Columns

Every project DB table has these columns, derived from `CommCareCase` model fields:

| Column | SQLAlchemy type | Source |
|--------|----------------|--------|
| `case_id` | `Text`, primary key | `CommCareCase.case_id` |
| `owner_id` | `Text`, not null, indexed | `CommCareCase.owner_id` |
| `case_name` | `Text` | `CommCareCase.name` |
| `opened_on` | `DateTime(timezone=True)` | `CommCareCase.opened_on` |
| `closed_on` | `DateTime(timezone=True)` | `CommCareCase.closed_on` |
| `modified_on` | `DateTime(timezone=True)`, indexed | `CommCareCase.modified_on` |
| `closed` | `Boolean` | `CommCareCase.closed` |
| `external_id` | `Text` | `CommCareCase.external_id` |
| `server_modified_on` | `DateTime(timezone=True)` | `CommCareCase.server_modified_on` |

---

## Task 1: App skeleton and table name generation

**Files:**
- Create: `corehq/apps/project_db/__init__.py`
- Create: `corehq/apps/project_db/schema.py`
- Create: `corehq/apps/project_db/tests/__init__.py`
- Create: `corehq/apps/project_db/tests/test_schema.py`

**Step 1: Write the failing test**

```python
# corehq/apps/project_db/tests/test_schema.py

from corehq.apps.project_db.schema import get_project_db_table_name


class TestTableName:

    def test_basic_name(self):
        name = get_project_db_table_name('myproject', 'patient')
        assert name.startswith('projectdb_')
        assert 'myproject' in name
        assert 'patient' in name

    def test_within_postgres_limit(self):
        name = get_project_db_table_name('a' * 100, 'b' * 100)
        assert len(name) <= 63

    def test_deterministic(self):
        name1 = get_project_db_table_name('myproject', 'patient')
        name2 = get_project_db_table_name('myproject', 'patient')
        assert name1 == name2

    def test_different_domains_differ(self):
        name1 = get_project_db_table_name('project_a', 'patient')
        name2 = get_project_db_table_name('project_b', 'patient')
        assert name1 != name2

    def test_different_case_types_differ(self):
        name1 = get_project_db_table_name('myproject', 'patient')
        name2 = get_project_db_table_name('myproject', 'household')
        assert name1 != name2
```

**Step 2: Run test to verify it fails**

Run: `pytest corehq/apps/project_db/tests/test_schema.py -v --no-header -rN`
Expected: FAIL — `ImportError: cannot import name 'get_project_db_table_name'`

**Step 3: Write minimal implementation**

```python
# corehq/apps/project_db/__init__.py
# (empty)
```

```python
# corehq/apps/project_db/tests/__init__.py
# (empty)
```

```python
# corehq/apps/project_db/schema.py

from corehq.apps.userreports.util import get_table_name

PROJECT_DB_TABLE_PREFIX = 'projectdb_'


def get_project_db_table_name(domain, case_type):
    """Generate a deterministic table name for a domain's case type.

    Uses the same hashing approach as UCR to stay within Postgres's
    63-character identifier limit.
    """
    return get_table_name(domain, case_type, prefix=PROJECT_DB_TABLE_PREFIX)
```

**Step 4: Run test to verify it passes**

Run: `pytest corehq/apps/project_db/tests/test_schema.py -v --no-header -rN`
Expected: PASS

**Step 5: Commit**

```bash
git add corehq/apps/project_db/
git commit -m "Add project_db app skeleton with table name generation"
```

---

## Task 2: Schema generation — fixed columns

**Files:**
- Modify: `corehq/apps/project_db/schema.py`
- Modify: `corehq/apps/project_db/tests/test_schema.py`

**Step 1: Write the failing test**

```python
# Add to test_schema.py

from corehq.apps.project_db.schema import build_table_for_case_type

import sqlalchemy


class TestFixedColumns:

    def test_table_has_case_id_primary_key(self):
        metadata = sqlalchemy.MetaData()
        table = build_table_for_case_type(metadata, 'test-domain', 'patient')
        assert 'case_id' in table.c
        assert table.c.case_id.primary_key

    def test_table_has_owner_id(self):
        metadata = sqlalchemy.MetaData()
        table = build_table_for_case_type(metadata, 'test-domain', 'patient')
        assert 'owner_id' in table.c
        assert not table.c.owner_id.nullable

    def test_table_has_all_fixed_columns(self):
        metadata = sqlalchemy.MetaData()
        table = build_table_for_case_type(metadata, 'test-domain', 'patient')
        expected = {
            'case_id', 'owner_id', 'case_name', 'opened_on',
            'closed_on', 'modified_on', 'closed', 'external_id',
            'server_modified_on',
        }
        assert expected == set(table.c.keys())

    def test_table_name_uses_project_db_prefix(self):
        metadata = sqlalchemy.MetaData()
        table = build_table_for_case_type(metadata, 'test-domain', 'patient')
        assert table.name.startswith('projectdb_')
```

**Step 2: Run test to verify it fails**

Run: `pytest corehq/apps/project_db/tests/test_schema.py::TestFixedColumns -v --no-header -rN`
Expected: FAIL — `ImportError: cannot import name 'build_table_for_case_type'`

**Step 3: Write minimal implementation**

```python
# Add to schema.py

import sqlalchemy
from sqlalchemy import Boolean, Column, DateTime, MetaData, Table, Text


FIXED_COLUMNS = [
    Column('case_id', Text, primary_key=True),
    Column('owner_id', Text, nullable=False),
    Column('case_name', Text),
    Column('opened_on', DateTime(timezone=True)),
    Column('closed_on', DateTime(timezone=True)),
    Column('modified_on', DateTime(timezone=True)),
    Column('closed', Boolean),
    Column('external_id', Text),
    Column('server_modified_on', DateTime(timezone=True)),
]


def build_table_for_case_type(metadata, domain, case_type, properties=None,
                               relationships=None):
    """Build a SQLAlchemy Table for a domain's case type.

    Args:
        metadata: SQLAlchemy MetaData instance
        domain: project domain name
        case_type: case type name
        properties: list of (name, data_type) tuples from data dictionary
            (optional, for dynamic columns — see Task 3)
        relationships: list of (identifier, referenced_case_type) tuples
            (optional, for FK columns — see Task 4)

    Returns:
        SQLAlchemy Table object
    """
    table_name = get_project_db_table_name(domain, case_type)
    columns = [col.copy() for col in FIXED_COLUMNS]
    return Table(table_name, metadata, *columns)
```

**Step 4: Run test to verify it passes**

Run: `pytest corehq/apps/project_db/tests/test_schema.py::TestFixedColumns -v --no-header -rN`
Expected: PASS

**Step 5: Commit**

```bash
git add corehq/apps/project_db/schema.py corehq/apps/project_db/tests/test_schema.py
git commit -m "Add build_table_for_case_type with fixed columns"
```

---

## Task 3: Schema generation — dynamic columns from data dictionary

**Files:**
- Modify: `corehq/apps/project_db/schema.py`
- Modify: `corehq/apps/project_db/tests/test_schema.py`

This task adds `prop_<name>` (raw Text) and `prop_<name>_<type>` (typed) columns based on data dictionary properties.

**Step 1: Write the failing test**

```python
# Add to test_schema.py

from corehq.apps.data_dictionary.models import CaseProperty


class TestDynamicColumns:

    def test_text_property_gets_one_column(self):
        metadata = sqlalchemy.MetaData()
        table = build_table_for_case_type(
            metadata, 'test-domain', 'patient',
            properties=[('first_name', CaseProperty.DataType.PLAIN)],
        )
        assert 'prop_first_name' in table.c
        assert isinstance(table.c.prop_first_name.type, sqlalchemy.Text)

    def test_date_property_gets_two_columns(self):
        metadata = sqlalchemy.MetaData()
        table = build_table_for_case_type(
            metadata, 'test-domain', 'patient',
            properties=[('dob', CaseProperty.DataType.DATE)],
        )
        assert 'prop_dob' in table.c
        assert 'prop_dob_date' in table.c
        assert isinstance(table.c.prop_dob.type, sqlalchemy.Text)
        assert isinstance(table.c.prop_dob_date.type, sqlalchemy.Date)

    def test_number_property_gets_two_columns(self):
        metadata = sqlalchemy.MetaData()
        table = build_table_for_case_type(
            metadata, 'test-domain', 'patient',
            properties=[('age', CaseProperty.DataType.NUMBER)],
        )
        assert 'prop_age' in table.c
        assert 'prop_age_numeric' in table.c
        assert isinstance(table.c.prop_age.type, sqlalchemy.Text)
        assert isinstance(table.c.prop_age_numeric.type, sqlalchemy.Numeric)

    def test_select_property_gets_one_column(self):
        metadata = sqlalchemy.MetaData()
        table = build_table_for_case_type(
            metadata, 'test-domain', 'patient',
            properties=[('risk_level', CaseProperty.DataType.SELECT)],
        )
        assert 'prop_risk_level' in table.c
        assert 'prop_risk_level_select' not in table.c

    def test_undefined_property_gets_one_column(self):
        metadata = sqlalchemy.MetaData()
        table = build_table_for_case_type(
            metadata, 'test-domain', 'patient',
            properties=[('unknown_prop', CaseProperty.DataType.UNDEFINED)],
        )
        assert 'prop_unknown_prop' in table.c

    def test_multiple_properties(self):
        metadata = sqlalchemy.MetaData()
        table = build_table_for_case_type(
            metadata, 'test-domain', 'patient',
            properties=[
                ('first_name', CaseProperty.DataType.PLAIN),
                ('dob', CaseProperty.DataType.DATE),
                ('age', CaseProperty.DataType.NUMBER),
            ],
        )
        # 9 fixed + 3 raw + 2 typed = 14
        assert len(table.c) == 14
```

**Step 2: Run test to verify it fails**

Run: `pytest corehq/apps/project_db/tests/test_schema.py::TestDynamicColumns -v --no-header -rN`
Expected: FAIL — dynamic columns not present

**Step 3: Write minimal implementation**

```python
# Add to schema.py, above build_table_for_case_type

from sqlalchemy import Date, Numeric

# Data types that get a second typed column alongside the raw Text column.
TYPED_COLUMN_MAP = {
    CaseProperty.DataType.DATE: ('date', Date),
    CaseProperty.DataType.NUMBER: ('numeric', Numeric),
}


def _dynamic_columns_for_property(name, data_type):
    """Return SQLAlchemy Column objects for a case property.

    Every property gets a raw Text column (prop_<name>).
    DATE and NUMBER properties also get a typed column
    (prop_<name>_date or prop_<name>_numeric).
    """
    columns = [Column(f'prop_{name}', Text)]
    if data_type in TYPED_COLUMN_MAP:
        suffix, sa_type = TYPED_COLUMN_MAP[data_type]
        columns.append(Column(f'prop_{name}_{suffix}', sa_type))
    return columns
```

Update `build_table_for_case_type` to use `properties`:

```python
def build_table_for_case_type(metadata, domain, case_type, properties=None,
                               relationships=None):
    table_name = get_project_db_table_name(domain, case_type)
    columns = [col.copy() for col in FIXED_COLUMNS]
    for name, data_type in (properties or []):
        columns.extend(_dynamic_columns_for_property(name, data_type))
    return Table(table_name, metadata, *columns)
```

**Step 4: Run test to verify it passes**

Run: `pytest corehq/apps/project_db/tests/test_schema.py::TestDynamicColumns -v --no-header -rN`
Expected: PASS

**Step 5: Commit**

```bash
git add corehq/apps/project_db/schema.py corehq/apps/project_db/tests/test_schema.py
git commit -m "Add dynamic columns from data dictionary properties"
```

---

## Task 4: Schema generation — relationship columns

**Files:**
- Modify: `corehq/apps/project_db/schema.py`
- Modify: `corehq/apps/project_db/tests/test_schema.py`

Adds `idx_<identifier>` columns for case index relationships. These are plain Text columns (no FK constraints enforced — async write ordering from change feed makes constraints unreliable).

**Step 1: Write the failing test**

```python
# Add to test_schema.py


class TestRelationshipColumns:

    def test_parent_index_column(self):
        metadata = sqlalchemy.MetaData()
        table = build_table_for_case_type(
            metadata, 'test-domain', 'patient',
            relationships=[('parent', 'household')],
        )
        assert 'idx_parent' in table.c
        assert isinstance(table.c.idx_parent.type, sqlalchemy.Text)

    def test_multiple_relationships(self):
        metadata = sqlalchemy.MetaData()
        table = build_table_for_case_type(
            metadata, 'test-domain', 'visit',
            relationships=[
                ('parent', 'patient'),
                ('host', 'clinic'),
            ],
        )
        assert 'idx_parent' in table.c
        assert 'idx_host' in table.c

    def test_no_fk_constraints(self):
        """FK constraints are not enforced — change feed doesn't
        guarantee write order."""
        metadata = sqlalchemy.MetaData()
        table = build_table_for_case_type(
            metadata, 'test-domain', 'patient',
            relationships=[('parent', 'household')],
        )
        assert len(table.foreign_keys) == 0

    def test_index_columns_are_indexed(self):
        metadata = sqlalchemy.MetaData()
        table = build_table_for_case_type(
            metadata, 'test-domain', 'patient',
            relationships=[('parent', 'household')],
        )
        indexed_columns = {
            col.name for idx in table.indexes for col in idx.columns
        }
        assert 'idx_parent' in indexed_columns
```

**Step 2: Run test to verify it fails**

Run: `pytest corehq/apps/project_db/tests/test_schema.py::TestRelationshipColumns -v --no-header -rN`
Expected: FAIL — idx_ columns not present

**Step 3: Write minimal implementation**

Update `build_table_for_case_type`:

```python
from sqlalchemy import Index

def build_table_for_case_type(metadata, domain, case_type, properties=None,
                               relationships=None):
    table_name = get_project_db_table_name(domain, case_type)
    columns = [col.copy() for col in FIXED_COLUMNS]
    for name, data_type in (properties or []):
        columns.extend(_dynamic_columns_for_property(name, data_type))
    for identifier, _referenced_type in (relationships or []):
        columns.append(Column(f'idx_{identifier}', Text))
    table = Table(table_name, metadata, *columns)
    for identifier, _referenced_type in (relationships or []):
        Index(f'ix_{table_name}_idx_{identifier}', table.c[f'idx_{identifier}'])
    return table
```

**Step 4: Run test to verify it passes**

Run: `pytest corehq/apps/project_db/tests/test_schema.py::TestRelationshipColumns -v --no-header -rN`
Expected: PASS

**Step 5: Commit**

```bash
git add corehq/apps/project_db/schema.py corehq/apps/project_db/tests/test_schema.py
git commit -m "Add relationship index columns with database indexes"
```

---

## Task 5: Schema from data dictionary — integration

**Files:**
- Create: `corehq/apps/project_db/schema_gen.py`
- Create: `corehq/apps/project_db/tests/test_schema_gen.py`

This task connects `build_table_for_case_type` to the actual data dictionary models. It reads `CaseType` and `CaseProperty` objects from the database and produces a complete table definition.

**Step 1: Write the failing test**

These tests need the database (data dictionary models are Django ORM). Use `@pytest.mark.django_db`.

```python
# corehq/apps/project_db/tests/test_schema_gen.py

import pytest
import sqlalchemy

from corehq.apps.data_dictionary.models import CaseProperty, CaseType
from corehq.apps.project_db.schema_gen import build_tables_for_domain

DOMAIN = 'test-project-db'


@pytest.mark.django_db
class TestBuildTablesForDomain:

    @pytest.fixture(autouse=True)
    def setup_data_dictionary(self):
        self.case_type = CaseType.objects.create(
            domain=DOMAIN, name='patient',
        )
        CaseProperty.objects.create(
            case_type=self.case_type, name='first_name',
            data_type=CaseProperty.DataType.PLAIN,
        )
        CaseProperty.objects.create(
            case_type=self.case_type, name='dob',
            data_type=CaseProperty.DataType.DATE,
        )
        CaseProperty.objects.create(
            case_type=self.case_type, name='age',
            data_type=CaseProperty.DataType.NUMBER,
        )
        yield
        CaseType.objects.filter(domain=DOMAIN).delete()

    def test_returns_table_for_case_type(self):
        metadata = sqlalchemy.MetaData()
        tables = build_tables_for_domain(metadata, DOMAIN)
        assert 'patient' in tables

    def test_table_has_dynamic_columns(self):
        metadata = sqlalchemy.MetaData()
        tables = build_tables_for_domain(metadata, DOMAIN)
        table = tables['patient']
        assert 'prop_first_name' in table.c
        assert 'prop_dob' in table.c
        assert 'prop_dob_date' in table.c
        assert 'prop_age' in table.c
        assert 'prop_age_numeric' in table.c

    def test_deprecated_properties_excluded(self):
        CaseProperty.objects.create(
            case_type=self.case_type, name='old_field',
            data_type=CaseProperty.DataType.PLAIN,
            deprecated=True,
        )
        metadata = sqlalchemy.MetaData()
        tables = build_tables_for_domain(metadata, DOMAIN)
        table = tables['patient']
        assert 'prop_old_field' not in table.c

    def test_deprecated_case_types_excluded(self):
        CaseType.objects.create(
            domain=DOMAIN, name='legacy_type', is_deprecated=True,
        )
        metadata = sqlalchemy.MetaData()
        tables = build_tables_for_domain(metadata, DOMAIN)
        assert 'legacy_type' not in tables

    def test_empty_domain(self):
        metadata = sqlalchemy.MetaData()
        tables = build_tables_for_domain(metadata, 'nonexistent-domain')
        assert tables == {}
```

**Step 2: Run test to verify it fails**

Run: `pytest corehq/apps/project_db/tests/test_schema_gen.py -v --no-header -rN`
Expected: FAIL — `ImportError: cannot import name 'build_tables_for_domain'`

**Step 3: Write minimal implementation**

```python
# corehq/apps/project_db/schema_gen.py

from corehq.apps.data_dictionary.models import CaseProperty, CaseType
from corehq.apps.project_db.schema import build_table_for_case_type


def build_tables_for_domain(metadata, domain):
    """Build SQLAlchemy Table objects for all active case types in a domain.

    Reads the data dictionary and produces one Table per non-deprecated
    case type, with columns derived from non-deprecated properties.

    Returns:
        dict mapping case_type name to SQLAlchemy Table
    """
    case_types = CaseType.objects.filter(
        domain=domain,
        is_deprecated=False,
    ).prefetch_related('properties')

    tables = {}
    for ct in case_types:
        properties = [
            (prop.name, prop.data_type)
            for prop in ct.properties.all()
            if not prop.deprecated
        ]
        # TODO: relationships (Task 6)
        table = build_table_for_case_type(
            metadata, domain, ct.name,
            properties=properties,
        )
        tables[ct.name] = table
    return tables
```

**Step 4: Run test to verify it passes**

Run: `pytest corehq/apps/project_db/tests/test_schema_gen.py -v --no-header -rN --reusedb=1`
Expected: PASS

**Step 5: Commit**

```bash
git add corehq/apps/project_db/schema_gen.py corehq/apps/project_db/tests/test_schema_gen.py
git commit -m "Add build_tables_for_domain reading from data dictionary"
```

---

## Task 6: Schema from data dictionary — relationships

**Files:**
- Modify: `corehq/apps/project_db/schema_gen.py`
- Modify: `corehq/apps/project_db/tests/test_schema_gen.py`

Data dictionary relationships are not stored in the `CaseProperty` model — they come from `CommCareCaseIndex` patterns or from app definitions. For now, we'll derive relationships from the data dictionary's case type structure. The data dictionary doesn't have an explicit relationship model, so we need to look at how the codebase tracks these.

**Step 1: Research — how are case type relationships defined?**

Read these files to understand how relationships between case types are tracked:
- `corehq/apps/data_dictionary/models.py` — look for any relationship model
- `corehq/apps/app_manager/app_schemas/case_properties.py` — `ParentCasePropertyBuilder`, `_CaseRelationshipManager`
- `corehq/apps/data_dictionary/util.py` — look for relationship-related functions

**Note:** If data dictionary doesn't store relationships directly, the initial implementation should accept relationships as an explicit parameter (not auto-derived). The integration with app schema or index analysis can come later. Document this as a known gap.

**Step 2: Write the failing test**

```python
# Add to test_schema_gen.py


@pytest.mark.django_db
class TestBuildTablesWithRelationships:

    @pytest.fixture(autouse=True)
    def setup_case_types(self):
        self.household = CaseType.objects.create(
            domain=DOMAIN, name='household',
        )
        self.patient = CaseType.objects.create(
            domain=DOMAIN, name='patient',
        )
        yield
        CaseType.objects.filter(domain=DOMAIN).delete()

    def test_explicit_relationships_produce_index_columns(self):
        metadata = sqlalchemy.MetaData()
        relationships_by_type = {
            'patient': [('parent', 'household')],
        }
        tables = build_tables_for_domain(
            metadata, DOMAIN,
            relationships_by_type=relationships_by_type,
        )
        assert 'idx_parent' in tables['patient'].c

    def test_no_relationships_no_index_columns(self):
        metadata = sqlalchemy.MetaData()
        tables = build_tables_for_domain(metadata, DOMAIN)
        patient_cols = set(tables['patient'].c.keys())
        idx_cols = {c for c in patient_cols if c.startswith('idx_')}
        assert idx_cols == set()
```

**Step 3: Update implementation**

Update `build_tables_for_domain` signature to accept `relationships_by_type`:

```python
def build_tables_for_domain(metadata, domain, relationships_by_type=None):
    # ... existing code ...
    for ct in case_types:
        properties = [...]
        relationships = (relationships_by_type or {}).get(ct.name, [])
        table = build_table_for_case_type(
            metadata, domain, ct.name,
            properties=properties,
            relationships=relationships,
        )
        tables[ct.name] = table
    return tables
```

**Step 4: Run tests, verify pass, commit**

Run: `pytest corehq/apps/project_db/tests/test_schema_gen.py -v --no-header -rN --reusedb=1`

```bash
git add corehq/apps/project_db/schema_gen.py corehq/apps/project_db/tests/test_schema_gen.py
git commit -m "Support explicit relationships in build_tables_for_domain"
```

---

## Task 7: DDL — create and evolve tables

**Files:**
- Create: `corehq/apps/project_db/table_manager.py`
- Create: `corehq/apps/project_db/tests/test_table_manager.py`

This task creates actual PostgreSQL tables and handles schema evolution (adding new columns when the data dictionary changes). Tests use a real database connection.

**Step 1: Write the failing test**

```python
# corehq/apps/project_db/tests/test_table_manager.py

import pytest
import sqlalchemy
from sqlalchemy import inspect

from corehq.apps.data_dictionary.models import CaseProperty
from corehq.apps.project_db.schema import build_table_for_case_type
from corehq.apps.project_db.table_manager import (
    create_tables,
    evolve_table,
    get_project_db_engine,
)

DOMAIN = 'test-project-db-ddl'


@pytest.fixture
def engine():
    return get_project_db_engine()


@pytest.fixture
def cleanup_tables(engine):
    """Track and drop tables created during test."""
    created = []
    yield created
    with engine.begin() as conn:
        for table_name in created:
            conn.execute(sqlalchemy.text(f'DROP TABLE IF EXISTS "{table_name}"'))


@pytest.mark.django_db
class TestCreateTables:

    def test_create_table(self, engine, cleanup_tables):
        metadata = sqlalchemy.MetaData()
        table = build_table_for_case_type(metadata, DOMAIN, 'patient')
        cleanup_tables.append(table.name)
        create_tables(engine, metadata)
        assert inspect(engine).has_table(table.name)

    def test_create_is_idempotent(self, engine, cleanup_tables):
        metadata = sqlalchemy.MetaData()
        table = build_table_for_case_type(metadata, DOMAIN, 'patient')
        cleanup_tables.append(table.name)
        create_tables(engine, metadata)
        create_tables(engine, metadata)  # should not raise
        assert inspect(engine).has_table(table.name)


@pytest.mark.django_db
class TestEvolveTable:

    def test_add_new_column(self, engine, cleanup_tables):
        # Create table with one property
        metadata1 = sqlalchemy.MetaData()
        table1 = build_table_for_case_type(
            metadata1, DOMAIN, 'patient',
            properties=[('first_name', CaseProperty.DataType.PLAIN)],
        )
        cleanup_tables.append(table1.name)
        create_tables(engine, metadata1)

        # Build new definition with an additional property
        metadata2 = sqlalchemy.MetaData()
        table2 = build_table_for_case_type(
            metadata2, DOMAIN, 'patient',
            properties=[
                ('first_name', CaseProperty.DataType.PLAIN),
                ('dob', CaseProperty.DataType.DATE),
            ],
        )
        evolve_table(engine, table2)

        # Verify new columns exist
        columns = {c['name'] for c in inspect(engine).get_columns(table2.name)}
        assert 'prop_dob' in columns
        assert 'prop_dob_date' in columns

    def test_evolve_does_not_drop_existing_columns(self, engine, cleanup_tables):
        # Create table with a property
        metadata1 = sqlalchemy.MetaData()
        table1 = build_table_for_case_type(
            metadata1, DOMAIN, 'patient',
            properties=[('old_prop', CaseProperty.DataType.PLAIN)],
        )
        cleanup_tables.append(table1.name)
        create_tables(engine, metadata1)

        # Build new definition WITHOUT old_prop
        metadata2 = sqlalchemy.MetaData()
        table2 = build_table_for_case_type(
            metadata2, DOMAIN, 'patient',
        )
        evolve_table(engine, table2)

        # old_prop should still exist (append-only)
        columns = {c['name'] for c in inspect(engine).get_columns(table2.name)}
        assert 'prop_old_prop' in columns
```

**Step 2: Run test to verify it fails**

Run: `pytest corehq/apps/project_db/tests/test_table_manager.py -v --no-header -rN --reusedb=1`
Expected: FAIL — `ImportError: cannot import name 'create_tables'`

**Step 3: Write minimal implementation**

```python
# corehq/apps/project_db/table_manager.py

import sqlalchemy
from sqlalchemy import Column, Text, inspect as sa_inspect

from corehq.sql_db.connections import connection_manager

PROJECT_DB_ENGINE_ID = 'default'  # TODO: use 'project_db' once configured


def get_project_db_engine():
    """Get the SQLAlchemy engine for project DB tables."""
    return connection_manager.get_engine(PROJECT_DB_ENGINE_ID)


def create_tables(engine, metadata):
    """Create all tables defined in metadata that don't yet exist.

    Safe to call repeatedly — skips tables that already exist.
    """
    with engine.begin() as connection:
        metadata.create_all(connection, checkfirst=True)


def evolve_table(engine, table):
    """Add any columns present in the table definition but missing from
    the database. Never drops columns (append-only schema evolution)."""
    inspector = sa_inspect(engine)
    if not inspector.has_table(table.name):
        return

    existing_columns = {c['name'] for c in inspector.get_columns(table.name)}
    new_columns = [
        col for col in table.columns
        if col.name not in existing_columns
    ]
    if new_columns:
        with engine.begin() as connection:
            for col in new_columns:
                col_type = col.type.compile(engine.dialect)
                connection.execute(sqlalchemy.text(
                    f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {col_type}'
                ))
```

**Step 4: Run test to verify it passes**

Run: `pytest corehq/apps/project_db/tests/test_table_manager.py -v --no-header -rN --reusedb=1`
Expected: PASS

**Step 5: Commit**

```bash
git add corehq/apps/project_db/table_manager.py corehq/apps/project_db/tests/test_table_manager.py
git commit -m "Add table creation and schema evolution"
```

---

## Task 8: Data population — single case upsert

**Files:**
- Create: `corehq/apps/project_db/populate.py`
- Create: `corehq/apps/project_db/tests/test_populate.py`

**Step 1: Write the failing test**

```python
# corehq/apps/project_db/tests/test_populate.py

import pytest
import sqlalchemy

from corehq.apps.data_dictionary.models import CaseProperty
from corehq.apps.project_db.populate import upsert_case
from corehq.apps.project_db.schema import build_table_for_case_type
from corehq.apps.project_db.table_manager import create_tables, get_project_db_engine

DOMAIN = 'test-project-db-pop'


@pytest.fixture
def engine():
    return get_project_db_engine()


@pytest.fixture
def patient_table(engine):
    metadata = sqlalchemy.MetaData()
    table = build_table_for_case_type(
        metadata, DOMAIN, 'patient',
        properties=[
            ('first_name', CaseProperty.DataType.PLAIN),
            ('dob', CaseProperty.DataType.DATE),
            ('age', CaseProperty.DataType.NUMBER),
        ],
        relationships=[('parent', 'household')],
    )
    create_tables(engine, metadata)
    yield table
    with engine.begin() as conn:
        conn.execute(sqlalchemy.text(f'DROP TABLE IF EXISTS "{table.name}"'))


@pytest.mark.django_db
class TestUpsertCase:

    def test_insert_new_case(self, engine, patient_table):
        upsert_case(engine, patient_table, {
            'case_id': 'case-001',
            'owner_id': 'user-001',
            'case_name': 'Alice',
            'first_name': 'Alice',
        })
        with engine.begin() as conn:
            row = conn.execute(
                sqlalchemy.select(patient_table)
                .where(patient_table.c.case_id == 'case-001')
            ).fetchone()
        assert row is not None
        assert row.case_name == 'Alice'
        assert row.prop_first_name == 'Alice'

    def test_upsert_updates_existing(self, engine, patient_table):
        upsert_case(engine, patient_table, {
            'case_id': 'case-002',
            'owner_id': 'user-001',
            'case_name': 'Bob',
        })
        upsert_case(engine, patient_table, {
            'case_id': 'case-002',
            'owner_id': 'user-001',
            'case_name': 'Robert',
        })
        with engine.begin() as conn:
            row = conn.execute(
                sqlalchemy.select(patient_table)
                .where(patient_table.c.case_id == 'case-002')
            ).fetchone()
        assert row.case_name == 'Robert'

    def test_index_column_populated(self, engine, patient_table):
        upsert_case(engine, patient_table, {
            'case_id': 'case-003',
            'owner_id': 'user-001',
            'indices': {'parent': 'household-001'},
        })
        with engine.begin() as conn:
            row = conn.execute(
                sqlalchemy.select(patient_table)
                .where(patient_table.c.case_id == 'case-003')
            ).fetchone()
        assert row.idx_parent == 'household-001'
```

**Step 2: Run test to verify it fails**

Run: `pytest corehq/apps/project_db/tests/test_populate.py -v --no-header -rN --reusedb=1`
Expected: FAIL — `ImportError`

**Step 3: Write minimal implementation**

```python
# corehq/apps/project_db/populate.py

from sqlalchemy.dialects.postgresql import insert


def upsert_case(engine, table, case_data):
    """Upsert a single case into its project DB table.

    Args:
        engine: SQLAlchemy engine
        table: SQLAlchemy Table object for this case type
        case_data: dict with keys:
            - Fixed fields: case_id, owner_id, case_name, opened_on, etc.
            - Case properties: keyed by property name (without prop_ prefix)
            - indices: dict of {identifier: referenced_case_id}
    """
    values = {}
    table_columns = set(table.c.keys())

    # Fixed columns
    for fixed_col in ('case_id', 'owner_id', 'case_name', 'opened_on',
                       'closed_on', 'modified_on', 'closed', 'external_id',
                       'server_modified_on'):
        if fixed_col in case_data:
            values[fixed_col] = case_data[fixed_col]

    # Dynamic property columns
    for key, value in case_data.items():
        prop_col = f'prop_{key}'
        if prop_col in table_columns:
            values[prop_col] = value
            # TODO Task 9: type coercion for typed columns

    # Index columns
    for identifier, referenced_id in case_data.get('indices', {}).items():
        idx_col = f'idx_{identifier}'
        if idx_col in table_columns:
            values[idx_col] = referenced_id

    stmt = insert(table).values(**values)
    update_cols = {k: v for k, v in values.items() if k != 'case_id'}
    stmt = stmt.on_conflict_do_update(
        index_elements=['case_id'],
        set_=update_cols,
    )
    with engine.begin() as conn:
        conn.execute(stmt)
```

**Step 4: Run test to verify it passes**

Run: `pytest corehq/apps/project_db/tests/test_populate.py -v --no-header -rN --reusedb=1`
Expected: PASS

**Step 5: Commit**

```bash
git add corehq/apps/project_db/populate.py corehq/apps/project_db/tests/test_populate.py
git commit -m "Add case upsert for project DB tables"
```

---

## Task 9: Data population — type coercion

**Files:**
- Create: `corehq/apps/project_db/coerce.py`
- Create: `corehq/apps/project_db/tests/test_coerce.py`
- Modify: `corehq/apps/project_db/populate.py`

Type coercion converts raw string values to typed column values. Failed coercion produces `None` (null) in the typed column — the raw Text column always gets the original value.

**Step 1: Write the failing test**

```python
# corehq/apps/project_db/tests/test_coerce.py

from datetime import date
from decimal import Decimal

from corehq.apps.project_db.coerce import coerce_to_date, coerce_to_number


class TestCoerceToDate:

    def test_iso_date(self):
        assert coerce_to_date('2024-03-15') == date(2024, 3, 15)

    def test_invalid_returns_none(self):
        assert coerce_to_date('not-a-date') is None

    def test_empty_returns_none(self):
        assert coerce_to_date('') is None

    def test_none_returns_none(self):
        assert coerce_to_date(None) is None

    def test_datetime_string_extracts_date(self):
        assert coerce_to_date('2024-03-15T10:30:00') == date(2024, 3, 15)


class TestCoerceToNumber:

    def test_integer_string(self):
        assert coerce_to_number('42') == Decimal('42')

    def test_decimal_string(self):
        assert coerce_to_number('3.14') == Decimal('3.14')

    def test_invalid_returns_none(self):
        assert coerce_to_number('abc') is None

    def test_empty_returns_none(self):
        assert coerce_to_number('') is None

    def test_none_returns_none(self):
        assert coerce_to_number(None) is None
```

**Step 2: Run test to verify it fails**

Run: `pytest corehq/apps/project_db/tests/test_coerce.py -v --no-header -rN`
Expected: FAIL

**Step 3: Write minimal implementation**

```python
# corehq/apps/project_db/coerce.py

from datetime import date
from decimal import Decimal, InvalidOperation


def coerce_to_date(value):
    """Parse a string to a date. Returns None on failure."""
    if not value:
        return None
    try:
        # Handle both date and datetime strings
        return date.fromisoformat(value[:10])
    except (ValueError, TypeError):
        return None


def coerce_to_number(value):
    """Parse a string to a Decimal. Returns None on failure."""
    if not value:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
```

**Step 4: Run test to verify it passes**

Run: `pytest corehq/apps/project_db/tests/test_coerce.py -v --no-header -rN`
Expected: PASS

**Step 5: Integrate into upsert and add test**

Add to `test_populate.py`:

```python
    def test_typed_columns_coerced(self, engine, patient_table):
        upsert_case(engine, patient_table, {
            'case_id': 'case-004',
            'owner_id': 'user-001',
            'dob': '2020-06-15',
            'age': '5',
        })
        with engine.begin() as conn:
            row = conn.execute(
                sqlalchemy.select(patient_table)
                .where(patient_table.c.case_id == 'case-004')
            ).fetchone()
        assert row.prop_dob == '2020-06-15'
        assert row.prop_dob_date == date(2020, 6, 15)
        assert row.prop_age == '5'
        assert row.prop_age_numeric == Decimal('5')

    def test_invalid_typed_value_stores_null(self, engine, patient_table):
        upsert_case(engine, patient_table, {
            'case_id': 'case-005',
            'owner_id': 'user-001',
            'dob': 'not-a-date',
            'age': 'not-a-number',
        })
        with engine.begin() as conn:
            row = conn.execute(
                sqlalchemy.select(patient_table)
                .where(patient_table.c.case_id == 'case-005')
            ).fetchone()
        assert row.prop_dob == 'not-a-date'
        assert row.prop_dob_date is None
        assert row.prop_age == 'not-a-number'
        assert row.prop_age_numeric is None
```

Update `upsert_case` in `populate.py` to call coercion functions for typed columns. The implementation needs to know which columns have typed counterparts. Add a `typed_columns` parameter or detect `_date`/`_numeric` suffix columns in the table.

```python
# Update populate.py

from corehq.apps.project_db.coerce import coerce_to_date, coerce_to_number

TYPED_COLUMN_COERCIONS = {
    '_date': coerce_to_date,
    '_numeric': coerce_to_number,
}


def upsert_case(engine, table, case_data):
    values = {}
    table_columns = set(table.c.keys())

    # Fixed columns
    for fixed_col in ('case_id', 'owner_id', 'case_name', 'opened_on',
                       'closed_on', 'modified_on', 'closed', 'external_id',
                       'server_modified_on'):
        if fixed_col in case_data:
            values[fixed_col] = case_data[fixed_col]

    # Dynamic property columns
    for key, value in case_data.items():
        prop_col = f'prop_{key}'
        if prop_col in table_columns:
            values[prop_col] = value
            # Check for typed columns
            for suffix, coerce_fn in TYPED_COLUMN_COERCIONS.items():
                typed_col = f'{prop_col}{suffix}'
                if typed_col in table_columns:
                    values[typed_col] = coerce_fn(value)

    # Index columns
    for identifier, referenced_id in case_data.get('indices', {}).items():
        idx_col = f'idx_{identifier}'
        if idx_col in table_columns:
            values[idx_col] = referenced_id

    stmt = insert(table).values(**values)
    update_cols = {k: v for k, v in values.items() if k != 'case_id'}
    stmt = stmt.on_conflict_do_update(
        index_elements=['case_id'],
        set_=update_cols,
    )
    with engine.begin() as conn:
        conn.execute(stmt)
```

**Step 6: Run all populate tests**

Run: `pytest corehq/apps/project_db/tests/test_populate.py -v --no-header -rN --reusedb=1`
Expected: PASS

**Step 7: Commit**

```bash
git add corehq/apps/project_db/coerce.py corehq/apps/project_db/tests/test_coerce.py \
       corehq/apps/project_db/populate.py corehq/apps/project_db/tests/test_populate.py
git commit -m "Add type coercion for date and numeric columns"
```

---

## Task 10: Population from CommCareCase objects

**Files:**
- Create: `corehq/apps/project_db/case_adapter.py`
- Create: `corehq/apps/project_db/tests/test_case_adapter.py`

This task bridges the `CommCareCase` model to the `upsert_case` function, extracting case data into the dict format expected by `upsert_case`.

**Step 1: Write the failing test**

```python
# corehq/apps/project_db/tests/test_case_adapter.py

from corehq.apps.project_db.case_adapter import case_to_row_dict


class TestCaseToRowDict:

    def test_extracts_fixed_fields(self):
        case = _make_case(
            case_id='case-001',
            owner_id='user-001',
            name='Alice',
            closed=False,
        )
        row = case_to_row_dict(case)
        assert row['case_id'] == 'case-001'
        assert row['owner_id'] == 'user-001'
        assert row['case_name'] == 'Alice'
        assert row['closed'] is False

    def test_extracts_dynamic_properties(self):
        case = _make_case(
            case_id='case-001',
            owner_id='user-001',
            case_json={'first_name': 'Alice', 'age': '30'},
        )
        row = case_to_row_dict(case)
        assert row['first_name'] == 'Alice'
        assert row['age'] == '30'

    def test_extracts_indices(self):
        case = _make_case(
            case_id='case-001',
            owner_id='user-001',
            indices=[('parent', 'household-001')],
        )
        row = case_to_row_dict(case)
        assert row['indices'] == {'parent': 'household-001'}


def _make_case(case_id, owner_id, name='', closed=False,
               case_json=None, indices=None, **kwargs):
    """Create a mock case object with the fields upsert needs."""
    from unittest.mock import Mock
    case = Mock()
    case.case_id = case_id
    case.owner_id = owner_id
    case.name = name
    case.closed = closed
    case.opened_on = kwargs.get('opened_on')
    case.closed_on = kwargs.get('closed_on')
    case.modified_on = kwargs.get('modified_on')
    case.external_id = kwargs.get('external_id')
    case.server_modified_on = kwargs.get('server_modified_on')
    case.case_json = case_json or {}
    mock_indices = []
    for identifier, ref_id in (indices or []):
        idx = Mock()
        idx.identifier = identifier
        idx.referenced_id = ref_id
        mock_indices.append(idx)
    case.live_indices = mock_indices
    return case
```

**Step 2: Run test to verify it fails**

Run: `pytest corehq/apps/project_db/tests/test_case_adapter.py -v --no-header -rN`
Expected: FAIL

**Step 3: Write minimal implementation**

```python
# corehq/apps/project_db/case_adapter.py


def case_to_row_dict(case):
    """Extract a dict from a CommCareCase for upserting into project DB.

    Returns a dict with:
        - Fixed field keys (case_id, owner_id, etc.)
        - Dynamic property keys (from case_json, without prop_ prefix)
        - 'indices' key mapping identifier → referenced_id
    """
    row = {
        'case_id': case.case_id,
        'owner_id': case.owner_id,
        'case_name': case.name,
        'opened_on': case.opened_on,
        'closed_on': case.closed_on,
        'modified_on': case.modified_on,
        'closed': case.closed,
        'external_id': case.external_id,
        'server_modified_on': case.server_modified_on,
    }
    # Dynamic properties from case_json
    row.update(case.case_json)
    # Indices
    row['indices'] = {
        idx.identifier: idx.referenced_id
        for idx in case.live_indices
    }
    return row
```

**Step 4: Run test to verify it passes**

Run: `pytest corehq/apps/project_db/tests/test_case_adapter.py -v --no-header -rN`
Expected: PASS

**Step 5: Commit**

```bash
git add corehq/apps/project_db/case_adapter.py corehq/apps/project_db/tests/test_case_adapter.py
git commit -m "Add case_to_row_dict bridging CommCareCase to upsert format"
```

---

## Task 11: Cross-relationship queries — JOINs

**Files:**
- Create: `corehq/apps/project_db/tests/test_queries.py`

This task validates the core value proposition: cross-case-type JOINs that replace the current multi-round-trip approach with a single SQL query. No new production code needed — this is a test-only validation using the existing SQLAlchemy tables and population code.

**Step 1: Write tests demonstrating JOIN queries**

```python
# corehq/apps/project_db/tests/test_queries.py

import pytest
import sqlalchemy
from sqlalchemy import and_, select

from corehq.apps.data_dictionary.models import CaseProperty
from corehq.apps.project_db.populate import upsert_case
from corehq.apps.project_db.schema import build_table_for_case_type
from corehq.apps.project_db.table_manager import create_tables, get_project_db_engine

DOMAIN = 'test-project-db-joins'


@pytest.fixture
def engine():
    return get_project_db_engine()


@pytest.fixture
def household_and_patient(engine):
    """Create household and patient tables with sample data."""
    metadata = sqlalchemy.MetaData()
    household = build_table_for_case_type(
        metadata, DOMAIN, 'household',
        properties=[
            ('district', CaseProperty.DataType.PLAIN),
            ('village', CaseProperty.DataType.PLAIN),
        ],
    )
    patient = build_table_for_case_type(
        metadata, DOMAIN, 'patient',
        properties=[
            ('first_name', CaseProperty.DataType.PLAIN),
            ('dob', CaseProperty.DataType.DATE),
            ('age', CaseProperty.DataType.NUMBER),
        ],
        relationships=[('parent', 'household')],
    )
    create_tables(engine, metadata)

    # Populate households
    for i, (district, village) in enumerate([
        ('Kamuli', 'Village A'),
        ('Kamuli', 'Village B'),
        ('Jinja', 'Village C'),
    ]):
        upsert_case(engine, household, {
            'case_id': f'hh-{i}',
            'owner_id': 'user-001',
            'case_name': f'Household {i}',
            'district': district,
            'village': village,
        })

    # Populate patients
    for i, (name, dob, age, hh_id) in enumerate([
        ('Alice', '2020-01-15', '4', 'hh-0'),
        ('Bob', '2018-06-01', '6', 'hh-0'),
        ('Carol', '2022-03-10', '2', 'hh-1'),
        ('Dan', '2015-11-20', '9', 'hh-2'),
    ]):
        upsert_case(engine, patient, {
            'case_id': f'pt-{i}',
            'owner_id': 'user-001',
            'case_name': name,
            'first_name': name,
            'dob': dob,
            'age': age,
            'indices': {'parent': hh_id},
        })

    yield {'household': household, 'patient': patient}

    with engine.begin() as conn:
        conn.execute(sqlalchemy.text(f'DROP TABLE IF EXISTS "{patient.name}"'))
        conn.execute(sqlalchemy.text(f'DROP TABLE IF EXISTS "{household.name}"'))


@pytest.mark.django_db
class TestCrossRelationshipQueries:

    def test_join_patient_to_household(self, engine, household_and_patient):
        patient = household_and_patient['patient']
        household = household_and_patient['household']

        query = (
            select(patient.c.case_name, household.c.prop_district)
            .join(household, patient.c.idx_parent == household.c.case_id)
        )
        with engine.begin() as conn:
            rows = conn.execute(query).fetchall()
        assert len(rows) == 4
        # All patients should have a district
        districts = {row.prop_district for row in rows}
        assert districts == {'Kamuli', 'Jinja'}

    def test_filter_by_parent_property(self, engine, household_and_patient):
        """Find patients in Kamuli district — the core use case that
        currently requires multi-round-trip lookups."""
        patient = household_and_patient['patient']
        household = household_and_patient['household']

        query = (
            select(patient.c.case_name)
            .join(household, patient.c.idx_parent == household.c.case_id)
            .where(household.c.prop_district == 'Kamuli')
        )
        with engine.begin() as conn:
            names = {row.case_name for row in conn.execute(query).fetchall()}
        assert names == {'Alice', 'Bob', 'Carol'}

    def test_filter_on_both_tables(self, engine, household_and_patient):
        """Patients in Kamuli born after 2019."""
        patient = household_and_patient['patient']
        household = household_and_patient['household']

        from datetime import date
        query = (
            select(patient.c.case_name)
            .join(household, patient.c.idx_parent == household.c.case_id)
            .where(and_(
                household.c.prop_district == 'Kamuli',
                patient.c.prop_dob_date > date(2019, 1, 1),
            ))
        )
        with engine.begin() as conn:
            names = {row.case_name for row in conn.execute(query).fetchall()}
        assert names == {'Alice', 'Carol'}

    def test_aggregate_by_parent(self, engine, household_and_patient):
        """Count patients per household."""
        patient = household_and_patient['patient']
        household = household_and_patient['household']

        query = (
            select(
                household.c.case_name,
                sqlalchemy.func.count(patient.c.case_id).label('patient_count'),
            )
            .join(household, patient.c.idx_parent == household.c.case_id)
            .group_by(household.c.case_name)
            .order_by(household.c.case_name)
        )
        with engine.begin() as conn:
            rows = conn.execute(query).fetchall()
        counts = {row.case_name: row.patient_count for row in rows}
        assert counts == {
            'Household 0': 2,
            'Household 1': 1,
            'Household 2': 1,
        }
```

**Step 2: Run tests**

Run: `pytest corehq/apps/project_db/tests/test_queries.py -v --no-header -rN --reusedb=1`
Expected: PASS (this uses already-implemented code, just validates the query patterns)

**Step 3: Commit**

```bash
git add corehq/apps/project_db/tests/test_queries.py
git commit -m "Add cross-relationship JOIN query tests"
```

---

## Task 12: Performance validation — bulk operations

**Files:**
- Create: `corehq/apps/project_db/tests/test_performance.py`

This task validates that the system can handle realistic data volumes. These tests are slow and should be marked accordingly.

**Step 1: Write performance tests**

```python
# corehq/apps/project_db/tests/test_performance.py

import time
import pytest
import sqlalchemy
from datetime import date, datetime, timezone

from corehq.apps.data_dictionary.models import CaseProperty
from corehq.apps.project_db.populate import upsert_case
from corehq.apps.project_db.schema import build_table_for_case_type
from corehq.apps.project_db.table_manager import create_tables, get_project_db_engine

DOMAIN = 'test-project-db-perf'


@pytest.fixture
def engine():
    return get_project_db_engine()


@pytest.fixture
def perf_tables(engine):
    metadata = sqlalchemy.MetaData()
    household = build_table_for_case_type(
        metadata, DOMAIN, 'household',
        properties=[
            ('district', CaseProperty.DataType.PLAIN),
            ('village', CaseProperty.DataType.PLAIN),
            ('head_of_household', CaseProperty.DataType.PLAIN),
        ],
    )
    patient = build_table_for_case_type(
        metadata, DOMAIN, 'patient',
        properties=[
            ('first_name', CaseProperty.DataType.PLAIN),
            ('last_name', CaseProperty.DataType.PLAIN),
            ('dob', CaseProperty.DataType.DATE),
            ('age', CaseProperty.DataType.NUMBER),
            ('sex', CaseProperty.DataType.SELECT),
            ('phone', CaseProperty.DataType.PHONE_NUMBER),
            ('risk_level', CaseProperty.DataType.SELECT),
        ],
        relationships=[('parent', 'household')],
    )
    create_tables(engine, metadata)
    yield {'household': household, 'patient': patient}
    with engine.begin() as conn:
        conn.execute(sqlalchemy.text(f'DROP TABLE IF EXISTS "{patient.name}"'))
        conn.execute(sqlalchemy.text(f'DROP TABLE IF EXISTS "{household.name}"'))


@pytest.mark.slow
@pytest.mark.django_db
class TestBulkPopulation:

    def test_insert_10k_cases(self, engine, perf_tables):
        """Insert 10,000 cases and verify count."""
        table = perf_tables['patient']
        start = time.time()
        for i in range(10_000):
            upsert_case(engine, table, {
                'case_id': f'perf-pt-{i}',
                'owner_id': f'user-{i % 100}',
                'case_name': f'Patient {i}',
                'first_name': f'First{i}',
                'last_name': f'Last{i}',
                'dob': f'200{i % 10}-{(i % 12) + 1:02d}-15',
                'age': str(20 + i % 50),
                'sex': 'male' if i % 2 == 0 else 'female',
                'indices': {'parent': f'perf-hh-{i % 1000}'},
            })
        elapsed = time.time() - start
        with engine.begin() as conn:
            count = conn.execute(
                sqlalchemy.select(sqlalchemy.func.count())
                .select_from(table)
            ).scalar()
        assert count == 10_000
        # Log timing for review (not a hard assertion)
        print(f"\n10k inserts: {elapsed:.2f}s ({10_000/elapsed:.0f} cases/sec)")


@pytest.mark.slow
@pytest.mark.django_db
class TestQueryPerformance:

    @pytest.fixture(autouse=True)
    def populate_data(self, engine, perf_tables):
        """Populate 1000 households and 10,000 patients."""
        household = perf_tables['household']
        patient = perf_tables['patient']
        districts = ['Kamuli', 'Jinja', 'Iganga', 'Bugiri', 'Mayuge']
        for i in range(1_000):
            upsert_case(engine, household, {
                'case_id': f'perf-hh-{i}',
                'owner_id': f'user-{i % 50}',
                'case_name': f'Household {i}',
                'district': districts[i % len(districts)],
                'village': f'Village {i % 100}',
            })
        for i in range(10_000):
            upsert_case(engine, patient, {
                'case_id': f'perf-pt-{i}',
                'owner_id': f'user-{i % 100}',
                'case_name': f'Patient {i}',
                'first_name': f'First{i}',
                'dob': f'200{i % 10}-{(i % 12) + 1:02d}-15',
                'age': str(20 + i % 50),
                'indices': {'parent': f'perf-hh-{i % 1000}'},
            })

    def test_join_query_time(self, engine, perf_tables):
        """Filter patients by parent's district — timed."""
        patient = perf_tables['patient']
        household = perf_tables['household']
        start = time.time()
        query = (
            sqlalchemy.select(patient.c.case_id, patient.c.case_name)
            .join(household, patient.c.idx_parent == household.c.case_id)
            .where(household.c.prop_district == 'Kamuli')
        )
        with engine.begin() as conn:
            rows = conn.execute(query).fetchall()
        elapsed = time.time() - start
        assert len(rows) == 2_000  # 10k patients / 5 districts
        print(f"\nJOIN query (10k rows, filter by parent): {elapsed*1000:.1f}ms")

    def test_filtered_join_with_typed_column(self, engine, perf_tables):
        """Filter by parent district AND child date — timed."""
        patient = perf_tables['patient']
        household = perf_tables['household']
        start = time.time()
        query = (
            sqlalchemy.select(patient.c.case_id)
            .join(household, patient.c.idx_parent == household.c.case_id)
            .where(sqlalchemy.and_(
                household.c.prop_district == 'Kamuli',
                patient.c.prop_dob_date > date(2005, 1, 1),
            ))
        )
        with engine.begin() as conn:
            rows = conn.execute(query).fetchall()
        elapsed = time.time() - start
        assert len(rows) > 0
        print(f"\nFiltered JOIN query: {elapsed*1000:.1f}ms, {len(rows)} results")
```

**Step 2: Run tests**

Run: `pytest corehq/apps/project_db/tests/test_performance.py -v --no-header -rN --reusedb=1 -s`
Expected: PASS (with timing output)

Note: Use `-m slow` to include these in targeted runs: `pytest -m slow corehq/apps/project_db/`

**Step 3: Commit**

```bash
git add corehq/apps/project_db/tests/test_performance.py
git commit -m "Add bulk population and query performance tests"
```

---

## Summary

| Task | What it builds | Key files |
|------|---------------|-----------|
| 1 | App skeleton, table naming | `schema.py`, `test_schema.py` |
| 2 | Fixed columns (case_id, owner_id, etc.) | `schema.py`, `test_schema.py` |
| 3 | Dynamic columns from data dictionary | `schema.py`, `test_schema.py` |
| 4 | Relationship index columns | `schema.py`, `test_schema.py` |
| 5 | Data dictionary → SQLAlchemy integration | `schema_gen.py`, `test_schema_gen.py` |
| 6 | Relationships in schema generation | `schema_gen.py`, `test_schema_gen.py` |
| 7 | DDL: create tables, evolve schema | `table_manager.py`, `test_table_manager.py` |
| 8 | Case upsert | `populate.py`, `test_populate.py` |
| 9 | Type coercion (date, number) | `coerce.py`, `test_coerce.py`, `populate.py` |
| 10 | CommCareCase → row dict bridge | `case_adapter.py`, `test_case_adapter.py` |
| 11 | Cross-relationship JOIN queries | `test_queries.py` |
| 12 | Performance validation at scale | `test_performance.py` |

After these 12 tasks, the project DB system will be validated end-to-end: data dictionary → schema → DDL → population → typed queries → cross-case-type JOINs → performance at 10k+ rows. This provides the evidence needed to assess real-world suitability before integrating with the case search endpoint or change feed.
