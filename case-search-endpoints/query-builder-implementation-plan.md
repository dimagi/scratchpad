# Query Builder & Case Search Endpoints — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the case search endpoints feature — admin UI for creating named, versioned query endpoints that filter case data using a visual query builder.

**Architecture:** Django models store endpoint + version metadata. A service layer handles all business logic. A capability builder reads the data dictionary to generate field/operation metadata for the UI. Views are thin wrappers over the service layer. The query builder is a standalone Alpine.js component that serializes filter spec JSON.

**Tech Stack:** Django, HTMX, Alpine.js, Bootstrap 5, PostgreSQL (JSONField)

---

## Reference: Key Existing Code

| File | What to learn |
|------|---------------|
| `corehq/apps/case_search/models.py` | Existing models, import style |
| `corehq/apps/case_search/views.py:149-211` | `CSQLFixtureExpressionView` — pattern for HTMX views with `BaseProjectDataView` |
| `corehq/apps/case_search/urls.py` | Existing URL patterns |
| `corehq/apps/case_search/tests/test_views.py` | `HtmxViewTestCase`, `@flag_enabled`, `hx_action` pattern |
| `corehq/apps/data_dictionary/models.py:16-52` | `CaseType` — domain, name, is_deprecated |
| `corehq/apps/data_dictionary/models.py:80-200` | `CaseProperty` — DataType enum, deprecated field, `case_type` FK |
| `corehq/apps/data_dictionary/models.py:240-254` | `CasePropertyAllowedValue` — `allowed_values` related manager on CaseProperty |
| `corehq/toggles/__init__.py` | `StaticToggle` constructor: `StaticToggle(slug, label, tag, [namespaces])` |
| `corehq/apps/settings/views.py:553-558` | `BaseProjectDataView` — extends `BaseDomainView`, `section_name="Data"` |

## Reference: Design Documents

| Document | Content |
|----------|---------|
| `query_builder_tech_spec.md` | Data model, service layer, capability JSON, views/URLs, UI structure |
| `query_builder_design.md` | Filter spec format, component catalog, backend interface, input schema |

## Design Decisions (Pre-Resolved)

- **PASSWORD fields**: Excluded from the capability builder (not queryable)
- **Select field options**: Sourced from data dictionary `CasePropertyAllowedValue` records
- **Service file**: Named `endpoint_service.py` (not `service.py`)
- **View base class**: `BaseProjectDataView` (matches `CSQLFixtureExpressionView` pattern)

---

## Task 1: Feature Flag

**Files:**
- Modify: `corehq/toggles/__init__.py`

**Step 1: Add the toggle definition**

Add near the other `CASE_SEARCH_*` toggles (around line 650):

```python
CASE_SEARCH_ENDPOINTS = StaticToggle(
    'case_search_endpoints',
    'Case Search Endpoints: configurable query builder for case search',
    TAG_INTERNAL,
    [NAMESPACE_DOMAIN],
)
```

**Step 2: Verify toggle loads**

```bash
python manage.py shell -c "from corehq import toggles; print(toggles.CASE_SEARCH_ENDPOINTS.slug)"
```

Expected: `case_search_endpoints`

**Step 3: Commit**

```bash
git add corehq/toggles/__init__.py
git commit -m "feat: add CASE_SEARCH_ENDPOINTS feature flag"
```

---

## Task 2: Data Models

**Files:**
- Modify: `corehq/apps/case_search/models.py`
- Create: migration via `makemigrations`
- Test: `corehq/apps/case_search/tests/test_endpoint_models.py`

**Step 1: Write failing tests**

```python
# corehq/apps/case_search/tests/test_endpoint_models.py
from django.db import IntegrityError
from django.test import TestCase

from corehq.apps.case_search.models import (
    CaseSearchEndpoint,
    CaseSearchEndpointVersion,
)


class TestCaseSearchEndpoint(TestCase):

    def test_create_endpoint(self):
        endpoint = CaseSearchEndpoint.objects.create(
            domain='test-domain',
            name='find-patients',
            target_type='project_db',
            target_name='patient',
        )
        self.assertEqual(endpoint.domain, 'test-domain')
        self.assertEqual(endpoint.name, 'find-patients')
        self.assertTrue(endpoint.is_active)
        self.assertIsNone(endpoint.current_version)
        self.assertIsNotNone(endpoint.created_at)

    def test_unique_name_per_domain(self):
        CaseSearchEndpoint.objects.create(
            domain='test-domain',
            name='find-patients',
            target_type='project_db',
            target_name='patient',
        )
        with self.assertRaises(IntegrityError):
            CaseSearchEndpoint.objects.create(
                domain='test-domain',
                name='find-patients',
                target_type='project_db',
                target_name='patient',
            )

    def test_same_name_different_domains(self):
        CaseSearchEndpoint.objects.create(
            domain='domain-a',
            name='find-patients',
            target_type='project_db',
            target_name='patient',
        )
        endpoint_b = CaseSearchEndpoint.objects.create(
            domain='domain-b',
            name='find-patients',
            target_type='project_db',
            target_name='patient',
        )
        self.assertEqual(endpoint_b.domain, 'domain-b')


class TestCaseSearchEndpointVersion(TestCase):

    def setUp(self):
        self.endpoint = CaseSearchEndpoint.objects.create(
            domain='test-domain',
            name='find-patients',
            target_type='project_db',
            target_name='patient',
        )

    def test_create_version(self):
        version = CaseSearchEndpointVersion.objects.create(
            endpoint=self.endpoint,
            version_number=1,
            parameters=[{'name': 'province', 'type': 'text'}],
            query={'type': 'and', 'children': []},
        )
        self.assertEqual(version.version_number, 1)
        self.assertEqual(version.parameters, [{'name': 'province', 'type': 'text'}])
        self.assertIsNotNone(version.created_at)

    def test_unique_version_per_endpoint(self):
        CaseSearchEndpointVersion.objects.create(
            endpoint=self.endpoint,
            version_number=1,
            parameters=[],
            query={},
        )
        with self.assertRaises(IntegrityError):
            CaseSearchEndpointVersion.objects.create(
                endpoint=self.endpoint,
                version_number=1,
                parameters=[],
                query={},
            )

    def test_current_version_fk(self):
        version = CaseSearchEndpointVersion.objects.create(
            endpoint=self.endpoint,
            version_number=1,
            parameters=[],
            query={},
        )
        self.endpoint.current_version = version
        self.endpoint.save()
        self.endpoint.refresh_from_db()
        self.assertEqual(self.endpoint.current_version, version)

    def test_versions_not_deleted_on_deactivate(self):
        CaseSearchEndpointVersion.objects.create(
            endpoint=self.endpoint,
            version_number=1,
            parameters=[],
            query={},
        )
        self.endpoint.is_active = False
        self.endpoint.save()
        self.assertEqual(self.endpoint.versions.count(), 1)
```

**Step 2: Run tests — verify they fail**

```bash
pytest corehq/apps/case_search/tests/test_endpoint_models.py -v
```

Expected: `ImportError` — models don't exist yet.

**Step 3: Add models to `models.py`**

Append to `corehq/apps/case_search/models.py`:

```python
class CaseSearchEndpoint(models.Model):
    domain = models.CharField(max_length=255, db_index=True)
    name = models.CharField(max_length=255)
    target_type = models.CharField(max_length=50, default='project_db')
    target_name = models.CharField(max_length=255)
    current_version = models.ForeignKey(
        'CaseSearchEndpointVersion',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        unique_together = [('domain', 'name')]

    def __str__(self):
        return f'{self.domain}/{self.name}'


class CaseSearchEndpointVersion(models.Model):
    endpoint = models.ForeignKey(
        CaseSearchEndpoint,
        on_delete=models.CASCADE,
        related_name='versions',
    )
    version_number = models.IntegerField()
    parameters = models.JSONField(default=list)
    query = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = [('endpoint', 'version_number')]

    def __str__(self):
        return f'{self.endpoint}@v{self.version_number}'
```

**Step 4: Create migration**

```bash
python manage.py makemigrations case_search --name add_case_search_endpoint_models
```

**Step 5: Run tests — verify they pass**

```bash
pytest corehq/apps/case_search/tests/test_endpoint_models.py -v
```

Expected: All 7 tests PASS.

**Step 6: Commit**

```bash
git add corehq/apps/case_search/models.py \
       corehq/apps/case_search/migrations/ \
       corehq/apps/case_search/tests/test_endpoint_models.py
git commit -m "feat: add CaseSearchEndpoint and CaseSearchEndpointVersion models"
```

---

## Task 3: Service Layer

**Files:**
- Create: `corehq/apps/case_search/endpoint_service.py`
- Test: `corehq/apps/case_search/tests/test_endpoint_service.py`

**Step 1: Write failing tests**

```python
# corehq/apps/case_search/tests/test_endpoint_service.py
from django.test import TestCase

from corehq.apps.case_search.endpoint_service import (
    create_endpoint,
    deactivate_endpoint,
    get_endpoint,
    get_version,
    list_endpoints,
    save_new_version,
)
from corehq.apps.case_search.models import (
    CaseSearchEndpoint,
    CaseSearchEndpointVersion,
)

DOMAIN = 'test-domain'
SAMPLE_QUERY = {
    'type': 'and',
    'children': [
        {
            'type': 'component',
            'component': 'exact_match',
            'field': 'province',
            'inputs': {
                'value': {'type': 'parameter', 'ref': 'search_province'},
            },
        },
    ],
}
SAMPLE_PARAMS = [{'name': 'search_province', 'type': 'text'}]


class TestCreateEndpoint(TestCase):

    def test_creates_endpoint_with_first_version(self):
        endpoint = create_endpoint(
            domain=DOMAIN,
            name='find-patients',
            target_type='project_db',
            target_name='patient',
            parameters=SAMPLE_PARAMS,
            query=SAMPLE_QUERY,
        )
        self.assertEqual(endpoint.name, 'find-patients')
        self.assertIsNotNone(endpoint.current_version)
        self.assertEqual(endpoint.current_version.version_number, 1)
        self.assertEqual(endpoint.current_version.parameters, SAMPLE_PARAMS)
        self.assertEqual(endpoint.current_version.query, SAMPLE_QUERY)

    def test_creates_active_endpoint(self):
        endpoint = create_endpoint(
            domain=DOMAIN,
            name='find-patients',
            target_type='project_db',
            target_name='patient',
            parameters=[],
            query={},
        )
        self.assertTrue(endpoint.is_active)


class TestSaveNewVersion(TestCase):

    def setUp(self):
        self.endpoint = create_endpoint(
            domain=DOMAIN,
            name='find-patients',
            target_type='project_db',
            target_name='patient',
            parameters=[],
            query={},
        )

    def test_increments_version_number(self):
        v2 = save_new_version(self.endpoint, SAMPLE_PARAMS, SAMPLE_QUERY)
        self.assertEqual(v2.version_number, 2)

    def test_updates_current_version(self):
        v2 = save_new_version(self.endpoint, SAMPLE_PARAMS, SAMPLE_QUERY)
        self.endpoint.refresh_from_db()
        self.assertEqual(self.endpoint.current_version, v2)

    def test_preserves_old_versions(self):
        save_new_version(self.endpoint, SAMPLE_PARAMS, SAMPLE_QUERY)
        self.assertEqual(self.endpoint.versions.count(), 2)

    def test_sequential_version_numbers(self):
        save_new_version(self.endpoint, [], {})
        v3 = save_new_version(self.endpoint, SAMPLE_PARAMS, SAMPLE_QUERY)
        self.assertEqual(v3.version_number, 3)


class TestListEndpoints(TestCase):

    def test_returns_active_endpoints_for_domain(self):
        create_endpoint(DOMAIN, 'ep-1', 'project_db', 'patient', [], {})
        create_endpoint(DOMAIN, 'ep-2', 'project_db', 'household', [], {})
        create_endpoint('other-domain', 'ep-3', 'project_db', 'patient', [], {})

        results = list(list_endpoints(DOMAIN))
        self.assertEqual(len(results), 2)
        names = {ep.name for ep in results}
        self.assertEqual(names, {'ep-1', 'ep-2'})

    def test_excludes_deactivated(self):
        endpoint = create_endpoint(DOMAIN, 'ep-1', 'project_db', 'patient', [], {})
        deactivate_endpoint(endpoint)

        results = list(list_endpoints(DOMAIN))
        self.assertEqual(len(results), 0)


class TestGetEndpoint(TestCase):

    def test_returns_active_endpoint(self):
        created = create_endpoint(DOMAIN, 'ep-1', 'project_db', 'patient', [], {})
        fetched = get_endpoint(DOMAIN, created.id)
        self.assertEqual(fetched.id, created.id)

    def test_raises_for_inactive(self):
        created = create_endpoint(DOMAIN, 'ep-1', 'project_db', 'patient', [], {})
        deactivate_endpoint(created)
        with self.assertRaises(CaseSearchEndpoint.DoesNotExist):
            get_endpoint(DOMAIN, created.id)

    def test_raises_for_wrong_domain(self):
        created = create_endpoint(DOMAIN, 'ep-1', 'project_db', 'patient', [], {})
        with self.assertRaises(CaseSearchEndpoint.DoesNotExist):
            get_endpoint('wrong-domain', created.id)


class TestGetVersion(TestCase):

    def test_returns_specific_version(self):
        endpoint = create_endpoint(DOMAIN, 'ep-1', 'project_db', 'patient', [], {})
        save_new_version(endpoint, SAMPLE_PARAMS, SAMPLE_QUERY)
        v1 = get_version(endpoint, 1)
        self.assertEqual(v1.version_number, 1)
        v2 = get_version(endpoint, 2)
        self.assertEqual(v2.version_number, 2)

    def test_raises_for_missing_version(self):
        endpoint = create_endpoint(DOMAIN, 'ep-1', 'project_db', 'patient', [], {})
        with self.assertRaises(CaseSearchEndpointVersion.DoesNotExist):
            get_version(endpoint, 999)


class TestDeactivateEndpoint(TestCase):

    def test_sets_inactive(self):
        endpoint = create_endpoint(DOMAIN, 'ep-1', 'project_db', 'patient', [], {})
        deactivate_endpoint(endpoint)
        endpoint.refresh_from_db()
        self.assertFalse(endpoint.is_active)

    def test_versions_preserved(self):
        endpoint = create_endpoint(DOMAIN, 'ep-1', 'project_db', 'patient', [], {})
        save_new_version(endpoint, SAMPLE_PARAMS, SAMPLE_QUERY)
        deactivate_endpoint(endpoint)
        self.assertEqual(endpoint.versions.count(), 2)
```

**Step 2: Run tests — verify they fail**

```bash
pytest corehq/apps/case_search/tests/test_endpoint_service.py -v
```

Expected: `ImportError` — module doesn't exist yet.

**Step 3: Implement service layer**

```python
# corehq/apps/case_search/endpoint_service.py
from django.db.models import Max

from corehq.apps.case_search.models import (
    CaseSearchEndpoint,
    CaseSearchEndpointVersion,
)


def create_endpoint(domain, name, target_type, target_name, parameters, query):
    endpoint = CaseSearchEndpoint.objects.create(
        domain=domain,
        name=name,
        target_type=target_type,
        target_name=target_name,
    )
    version = _create_version(endpoint, parameters, query)
    endpoint.current_version = version
    endpoint.save(update_fields=['current_version'])
    return endpoint


def save_new_version(endpoint, parameters, query):
    version = _create_version(endpoint, parameters, query)
    endpoint.current_version = version
    endpoint.save(update_fields=['current_version'])
    return version


def list_endpoints(domain):
    return CaseSearchEndpoint.objects.filter(
        domain=domain, is_active=True,
    ).select_related('current_version')


def get_endpoint(domain, endpoint_id):
    return CaseSearchEndpoint.objects.get(
        domain=domain, id=endpoint_id, is_active=True,
    )


def get_version(endpoint, version_number):
    return endpoint.versions.get(version_number=version_number)


def deactivate_endpoint(endpoint):
    endpoint.is_active = False
    endpoint.save(update_fields=['is_active'])


def _create_version(endpoint, parameters, query):
    last = endpoint.versions.aggregate(
        max_v=Max('version_number'),
    )['max_v'] or 0
    return CaseSearchEndpointVersion.objects.create(
        endpoint=endpoint,
        version_number=last + 1,
        parameters=parameters,
        query=query,
    )
```

**Step 4: Run tests — verify they pass**

```bash
pytest corehq/apps/case_search/tests/test_endpoint_service.py -v
```

Expected: All 14 tests PASS.

**Step 5: Commit**

```bash
git add corehq/apps/case_search/endpoint_service.py \
       corehq/apps/case_search/tests/test_endpoint_service.py
git commit -m "feat: add endpoint service layer with CRUD and versioning"
```

---

## Task 4: Capability Builder

**Files:**
- Create: `corehq/apps/case_search/endpoint_capability.py`
- Test: `corehq/apps/case_search/tests/test_endpoint_capability.py`

**Step 1: Write failing tests**

```python
# corehq/apps/case_search/tests/test_endpoint_capability.py
from django.test import TestCase

from corehq.apps.case_search.endpoint_capability import (
    AUTO_VALUES,
    COMPONENT_INPUT_SCHEMAS,
    DATATYPE_TO_FIELD_TYPE,
    OPERATIONS_BY_FIELD_TYPE,
    get_capability,
)
from corehq.apps.data_dictionary.models import (
    CaseProperty,
    CasePropertyAllowedValue,
    CaseType,
)

DOMAIN = 'test-domain'


class TestDataTypeMappings(TestCase):

    def test_password_excluded(self):
        self.assertNotIn(CaseProperty.DataType.PASSWORD, DATATYPE_TO_FIELD_TYPE)

    def test_all_non_password_types_mapped(self):
        for dt in CaseProperty.DataType:
            if dt == CaseProperty.DataType.PASSWORD:
                continue
            self.assertIn(dt, DATATYPE_TO_FIELD_TYPE, f'{dt} not in DATATYPE_TO_FIELD_TYPE')

    def test_text_operations_present(self):
        ops = OPERATIONS_BY_FIELD_TYPE['text']
        self.assertIn('exact_match', ops)
        self.assertIn('fuzzy_match', ops)
        self.assertIn('is_empty', ops)

    def test_number_operations_present(self):
        ops = OPERATIONS_BY_FIELD_TYPE['number']
        self.assertIn('gt', ops)
        self.assertIn('lte', ops)

    def test_date_operations_present(self):
        ops = OPERATIONS_BY_FIELD_TYPE['date']
        self.assertIn('date_range', ops)
        self.assertIn('before', ops)

    def test_select_operations_present(self):
        ops = OPERATIONS_BY_FIELD_TYPE['select']
        self.assertIn('selected_any', ops)
        self.assertIn('selected_all', ops)

    def test_date_range_has_two_slots(self):
        slots = COMPONENT_INPUT_SCHEMAS['date_range']
        self.assertEqual(len(slots), 2)
        names = {s['name'] for s in slots}
        self.assertEqual(names, {'start', 'end'})

    def test_is_empty_has_no_slots(self):
        self.assertEqual(COMPONENT_INPUT_SCHEMAS['is_empty'], [])

    def test_all_operations_have_schemas(self):
        all_ops = set()
        for ops in OPERATIONS_BY_FIELD_TYPE.values():
            all_ops.update(ops)
        for op in all_ops:
            self.assertIn(op, COMPONENT_INPUT_SCHEMAS, f'{op} missing from COMPONENT_INPUT_SCHEMAS')


class TestGetCapability(TestCase):

    def setUp(self):
        self.case_type = CaseType.objects.create(
            domain=DOMAIN, name='patient',
        )

    def test_empty_domain(self):
        result = get_capability('empty-domain')
        self.assertEqual(result['case_types'], [])

    def test_case_type_with_fields(self):
        CaseProperty.objects.create(
            case_type=self.case_type,
            name='first_name',
            data_type=CaseProperty.DataType.PLAIN,
        )
        CaseProperty.objects.create(
            case_type=self.case_type,
            name='dob',
            data_type=CaseProperty.DataType.DATE,
        )
        result = get_capability(DOMAIN)
        self.assertEqual(len(result['case_types']), 1)
        ct = result['case_types'][0]
        self.assertEqual(ct['name'], 'patient')
        self.assertEqual(len(ct['fields']), 2)
        field_names = {f['name'] for f in ct['fields']}
        self.assertEqual(field_names, {'first_name', 'dob'})

    def test_field_type_mapping(self):
        CaseProperty.objects.create(
            case_type=self.case_type,
            name='age',
            data_type=CaseProperty.DataType.NUMBER,
        )
        result = get_capability(DOMAIN)
        field = result['case_types'][0]['fields'][0]
        self.assertEqual(field['type'], 'number')
        self.assertEqual(field['operations'], OPERATIONS_BY_FIELD_TYPE['number'])

    def test_password_fields_excluded(self):
        CaseProperty.objects.create(
            case_type=self.case_type,
            name='pin',
            data_type=CaseProperty.DataType.PASSWORD,
        )
        CaseProperty.objects.create(
            case_type=self.case_type,
            name='first_name',
            data_type=CaseProperty.DataType.PLAIN,
        )
        result = get_capability(DOMAIN)
        field_names = {f['name'] for f in result['case_types'][0]['fields']}
        self.assertNotIn('pin', field_names)
        self.assertIn('first_name', field_names)

    def test_deprecated_case_types_excluded(self):
        CaseType.objects.create(
            domain=DOMAIN, name='old_type', is_deprecated=True,
        )
        result = get_capability(DOMAIN)
        ct_names = {ct['name'] for ct in result['case_types']}
        self.assertNotIn('old_type', ct_names)

    def test_deprecated_properties_excluded(self):
        CaseProperty.objects.create(
            case_type=self.case_type,
            name='old_prop',
            data_type=CaseProperty.DataType.PLAIN,
            deprecated=True,
        )
        CaseProperty.objects.create(
            case_type=self.case_type,
            name='active_prop',
            data_type=CaseProperty.DataType.PLAIN,
        )
        result = get_capability(DOMAIN)
        field_names = {f['name'] for f in result['case_types'][0]['fields']}
        self.assertNotIn('old_prop', field_names)
        self.assertIn('active_prop', field_names)

    def test_select_field_includes_options(self):
        prop = CaseProperty.objects.create(
            case_type=self.case_type,
            name='status',
            data_type=CaseProperty.DataType.SELECT,
        )
        CasePropertyAllowedValue.objects.create(
            case_property=prop, allowed_value='active',
        )
        CasePropertyAllowedValue.objects.create(
            case_property=prop, allowed_value='closed',
        )
        result = get_capability(DOMAIN)
        field = result['case_types'][0]['fields'][0]
        self.assertEqual(field['type'], 'select')
        self.assertIn('options', field)
        self.assertEqual(set(field['options']), {'active', 'closed'})

    def test_non_select_field_has_no_options(self):
        CaseProperty.objects.create(
            case_type=self.case_type,
            name='first_name',
            data_type=CaseProperty.DataType.PLAIN,
        )
        result = get_capability(DOMAIN)
        field = result['case_types'][0]['fields'][0]
        self.assertNotIn('options', field)

    def test_auto_values_included(self):
        result = get_capability(DOMAIN)
        self.assertIn('auto_values', result)
        self.assertIn('date', result['auto_values'])
        self.assertIn('text', result['auto_values'])

    def test_component_schemas_included(self):
        result = get_capability(DOMAIN)
        self.assertIn('component_schemas', result)
        self.assertIn('date_range', result['component_schemas'])
        self.assertEqual(len(result['component_schemas']['date_range']), 2)

    def test_undefined_type_maps_to_text(self):
        CaseProperty.objects.create(
            case_type=self.case_type,
            name='misc',
            data_type=CaseProperty.DataType.UNDEFINED,
        )
        result = get_capability(DOMAIN)
        field = result['case_types'][0]['fields'][0]
        self.assertEqual(field['type'], 'text')
```

**Step 2: Run tests — verify they fail**

```bash
pytest corehq/apps/case_search/tests/test_endpoint_capability.py -v
```

Expected: `ImportError` — module doesn't exist.

**Step 3: Implement capability builder**

```python
# corehq/apps/case_search/endpoint_capability.py
from corehq.apps.data_dictionary.models import CaseProperty, CaseType


DATATYPE_TO_FIELD_TYPE = {
    CaseProperty.DataType.DATE: 'date',
    CaseProperty.DataType.PLAIN: 'text',
    CaseProperty.DataType.NUMBER: 'number',
    CaseProperty.DataType.SELECT: 'select',
    CaseProperty.DataType.BARCODE: 'text',
    CaseProperty.DataType.GPS: 'geopoint',
    CaseProperty.DataType.PHONE_NUMBER: 'text',
    CaseProperty.DataType.UNDEFINED: 'text',
    # PASSWORD intentionally excluded
}

OPERATIONS_BY_FIELD_TYPE = {
    'text': [
        'exact_match', 'not_equals', 'starts_with',
        'fuzzy_match', 'phonetic_match', 'is_empty',
    ],
    'number': [
        'equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'is_empty',
    ],
    'date': [
        'equals', 'before', 'after', 'date_range', 'fuzzy_date', 'is_empty',
    ],
    'select': [
        'selected_any', 'selected_all', 'exact_match', 'is_empty',
    ],
    'geopoint': [
        'within_distance',
    ],
}

AUTO_VALUES = {
    'date': [
        {'ref': 'today()', 'label': 'Today'},
    ],
    'datetime': [
        {'ref': 'now()', 'label': 'Now'},
    ],
    'text': [
        {'ref': 'user.username', 'label': "Current user's username"},
        {'ref': 'user.uuid', 'label': "Current user's ID"},
        {'ref': 'user.location_ids', 'label': "User's location IDs"},
    ],
}

COMPONENT_INPUT_SCHEMAS = {
    'exact_match':     [{'name': 'value', 'type': 'match_field'}],
    'not_equals':      [{'name': 'value', 'type': 'match_field'}],
    'starts_with':     [{'name': 'value', 'type': 'text'}],
    'fuzzy_match':     [{'name': 'value', 'type': 'text'}],
    'phonetic_match':  [{'name': 'value', 'type': 'text'}],
    'selected_any':    [{'name': 'value', 'type': 'text'}],
    'selected_all':    [{'name': 'value', 'type': 'text'}],
    'is_empty':        [],
    'equals':          [{'name': 'value', 'type': 'match_field'}],
    'gt':              [{'name': 'value', 'type': 'number'}],
    'gte':             [{'name': 'value', 'type': 'number'}],
    'lt':              [{'name': 'value', 'type': 'number'}],
    'lte':             [{'name': 'value', 'type': 'number'}],
    'before':          [{'name': 'value', 'type': 'match_field'}],
    'after':           [{'name': 'value', 'type': 'match_field'}],
    'date_range':      [{'name': 'start', 'type': 'match_field'},
                        {'name': 'end', 'type': 'match_field'}],
    'fuzzy_date':      [{'name': 'value', 'type': 'date'}],
    'within_distance': [{'name': 'point', 'type': 'geopoint'},
                        {'name': 'distance', 'type': 'number'},
                        {'name': 'unit', 'type': 'choice'}],
}


def get_capability(domain, target_type='project_db'):
    case_types = []
    for ct in CaseType.objects.filter(domain=domain, is_deprecated=False):
        fields = []
        properties = CaseProperty.objects.filter(
            case_type=ct, deprecated=False,
        ).exclude(data_type=CaseProperty.DataType.PASSWORD)

        for prop in properties:
            field_type = DATATYPE_TO_FIELD_TYPE.get(prop.data_type, 'text')
            field = {
                'name': prop.name,
                'type': field_type,
                'operations': OPERATIONS_BY_FIELD_TYPE.get(field_type, []),
            }
            if field_type == 'select':
                field['options'] = list(
                    prop.allowed_values.values_list('allowed_value', flat=True)
                )
            fields.append(field)
        case_types.append({'name': ct.name, 'fields': fields})

    return {
        'case_types': case_types,
        'auto_values': AUTO_VALUES,
        'component_schemas': COMPONENT_INPUT_SCHEMAS,
    }
```

**Step 4: Run tests — verify they pass**

```bash
pytest corehq/apps/case_search/tests/test_endpoint_capability.py -v
```

Expected: All 16 tests PASS.

**Step 5: Commit**

```bash
git add corehq/apps/case_search/endpoint_capability.py \
       corehq/apps/case_search/tests/test_endpoint_capability.py
git commit -m "feat: add capability builder for query builder field/operation metadata"
```

---

## Task 5: Filter Spec Validation

**Files:**
- Modify: `corehq/apps/case_search/endpoint_service.py`
- Test: `corehq/apps/case_search/tests/test_endpoint_service.py`

**Step 1: Write failing validation tests**

Append to `corehq/apps/case_search/tests/test_endpoint_service.py`:

```python
from corehq.apps.case_search.endpoint_capability import get_capability
from corehq.apps.case_search.endpoint_service import validate_filter_spec
from corehq.apps.data_dictionary.models import CaseProperty, CaseType


class TestValidateFilterSpec(TestCase):

    def setUp(self):
        self.case_type = CaseType.objects.create(
            domain=DOMAIN, name='patient',
        )
        CaseProperty.objects.create(
            case_type=self.case_type,
            name='province',
            data_type=CaseProperty.DataType.PLAIN,
        )
        CaseProperty.objects.create(
            case_type=self.case_type,
            name='dob',
            data_type=CaseProperty.DataType.DATE,
        )
        self.capability = get_capability(DOMAIN)

    def test_valid_simple_spec(self):
        spec = {
            'type': 'and',
            'children': [{
                'type': 'component',
                'component': 'exact_match',
                'field': 'province',
                'inputs': {
                    'value': {'type': 'constant', 'value': 'ON'},
                },
            }],
        }
        params = []
        errors = validate_filter_spec(spec, params, 'patient', self.capability)
        self.assertEqual(errors, [])

    def test_valid_date_range_spec(self):
        spec = {
            'type': 'component',
            'component': 'date_range',
            'field': 'dob',
            'inputs': {
                'start': {'type': 'constant', 'value': '2000-01-01'},
                'end': {'type': 'auto_value', 'ref': 'today()'},
            },
        }
        errors = validate_filter_spec(spec, [], 'patient', self.capability)
        self.assertEqual(errors, [])

    def test_invalid_root_type(self):
        spec = {'type': 'invalid'}
        errors = validate_filter_spec(spec, [], 'patient', self.capability)
        self.assertTrue(any('type' in e.lower() for e in errors))

    def test_unknown_field(self):
        spec = {
            'type': 'component',
            'component': 'exact_match',
            'field': 'nonexistent',
            'inputs': {
                'value': {'type': 'constant', 'value': 'x'},
            },
        }
        errors = validate_filter_spec(spec, [], 'patient', self.capability)
        self.assertTrue(any('nonexistent' in e for e in errors))

    def test_incompatible_component_for_field(self):
        spec = {
            'type': 'component',
            'component': 'date_range',
            'field': 'province',  # text field, date_range is not valid
            'inputs': {
                'start': {'type': 'constant', 'value': '2000-01-01'},
                'end': {'type': 'constant', 'value': '2020-01-01'},
            },
        }
        errors = validate_filter_spec(spec, [], 'patient', self.capability)
        self.assertTrue(any('date_range' in e for e in errors))

    def test_missing_required_input_slot(self):
        spec = {
            'type': 'component',
            'component': 'date_range',
            'field': 'dob',
            'inputs': {
                'start': {'type': 'constant', 'value': '2000-01-01'},
                # 'end' missing
            },
        }
        errors = validate_filter_spec(spec, [], 'patient', self.capability)
        self.assertTrue(any('end' in e for e in errors))

    def test_parameter_ref_must_exist(self):
        spec = {
            'type': 'component',
            'component': 'exact_match',
            'field': 'province',
            'inputs': {
                'value': {'type': 'parameter', 'ref': 'missing_param'},
            },
        }
        errors = validate_filter_spec(spec, [], 'patient', self.capability)
        self.assertTrue(any('missing_param' in e for e in errors))

    def test_parameter_ref_valid(self):
        spec = {
            'type': 'component',
            'component': 'exact_match',
            'field': 'province',
            'inputs': {
                'value': {'type': 'parameter', 'ref': 'search_province'},
            },
        }
        params = [{'name': 'search_province', 'type': 'text'}]
        errors = validate_filter_spec(spec, params, 'patient', self.capability)
        self.assertEqual(errors, [])

    def test_invalid_auto_value_ref(self):
        spec = {
            'type': 'component',
            'component': 'exact_match',
            'field': 'province',
            'inputs': {
                'value': {'type': 'auto_value', 'ref': 'nonexistent()'},
            },
        }
        errors = validate_filter_spec(spec, [], 'patient', self.capability)
        self.assertTrue(any('nonexistent' in e for e in errors))

    def test_nested_and_or(self):
        spec = {
            'type': 'and',
            'children': [
                {
                    'type': 'or',
                    'children': [{
                        'type': 'component',
                        'component': 'exact_match',
                        'field': 'province',
                        'inputs': {
                            'value': {'type': 'constant', 'value': 'ON'},
                        },
                    }],
                },
            ],
        }
        errors = validate_filter_spec(spec, [], 'patient', self.capability)
        self.assertEqual(errors, [])

    def test_empty_children_allowed(self):
        spec = {'type': 'and', 'children': []}
        errors = validate_filter_spec(spec, [], 'patient', self.capability)
        self.assertEqual(errors, [])
```

**Step 2: Run tests — verify they fail**

```bash
pytest corehq/apps/case_search/tests/test_endpoint_service.py::TestValidateFilterSpec -v
```

Expected: `ImportError` — `validate_filter_spec` doesn't exist.

**Step 3: Implement validation**

Add to `corehq/apps/case_search/endpoint_service.py`:

```python
from corehq.apps.case_search.endpoint_capability import COMPONENT_INPUT_SCHEMAS


def validate_filter_spec(spec, parameters, case_type_name, capability):
    """Validate a filter spec against capability metadata.

    Returns a list of error messages (empty = valid).
    """
    errors = []
    param_names = {p['name'] for p in parameters}
    auto_value_refs = {
        av['ref']
        for avs in capability.get('auto_values', {}).values()
        for av in avs
    }
    ct = next(
        (ct for ct in capability.get('case_types', []) if ct['name'] == case_type_name),
        None,
    )
    fields_by_name = {f['name']: f for f in ct['fields']} if ct else {}

    _validate_node(spec, fields_by_name, param_names, auto_value_refs, errors)
    return errors


def _validate_node(node, fields_by_name, param_names, auto_value_refs, errors):
    node_type = node.get('type')

    if node_type in ('and', 'or'):
        for child in node.get('children', []):
            _validate_node(child, fields_by_name, param_names, auto_value_refs, errors)
    elif node_type == 'not':
        child = node.get('child')
        if child:
            _validate_node(child, fields_by_name, param_names, auto_value_refs, errors)
        else:
            errors.append("'not' node must have a 'child'")
    elif node_type == 'component':
        _validate_component(node, fields_by_name, param_names, auto_value_refs, errors)
    else:
        errors.append(f"Invalid node type: '{node_type}'. Expected 'and', 'or', 'not', or 'component'.")


def _validate_component(node, fields_by_name, param_names, auto_value_refs, errors):
    field_name = node.get('field', '')
    component_name = node.get('component', '')
    inputs = node.get('inputs', {})

    # Check field exists
    field = fields_by_name.get(field_name)
    if not field:
        errors.append(f"Unknown field: '{field_name}'")
        return

    # Check component is valid for field
    if component_name not in field.get('operations', []):
        errors.append(
            f"'{component_name}' is not a valid operation for field '{field_name}' "
            f"(type: {field['type']})"
        )
        return

    # Check required input slots
    schema = COMPONENT_INPUT_SCHEMAS.get(component_name, [])
    for slot in schema:
        slot_name = slot['name']
        if slot_name not in inputs:
            errors.append(
                f"Missing required input '{slot_name}' for component '{component_name}'"
            )
            continue
        _validate_input_value(inputs[slot_name], slot_name, param_names, auto_value_refs, errors)


def _validate_input_value(value, slot_name, param_names, auto_value_refs, errors):
    value_type = value.get('type')
    if value_type == 'constant':
        pass  # any value accepted
    elif value_type == 'parameter':
        ref = value.get('ref', '')
        if ref not in param_names:
            errors.append(f"Parameter '{ref}' referenced in '{slot_name}' is not defined")
    elif value_type == 'auto_value':
        ref = value.get('ref', '')
        if ref not in auto_value_refs:
            errors.append(f"Unknown auto value '{ref}' in '{slot_name}'")
    else:
        errors.append(f"Invalid input type '{value_type}' in '{slot_name}'")
```

**Step 4: Wire validation into `create_endpoint` and `save_new_version`**

Update `create_endpoint` and `save_new_version` in `endpoint_service.py`:

```python
from corehq.apps.case_search.endpoint_capability import get_capability


class FilterSpecValidationError(Exception):
    def __init__(self, errors):
        self.errors = errors
        super().__init__(f"Validation errors: {errors}")


def create_endpoint(domain, name, target_type, target_name, parameters, query):
    capability = get_capability(domain, target_type)
    errors = validate_filter_spec(query, parameters, target_name, capability)
    if errors:
        raise FilterSpecValidationError(errors)
    # ... rest unchanged


def save_new_version(endpoint, parameters, query):
    capability = get_capability(endpoint.domain, endpoint.target_type)
    errors = validate_filter_spec(query, parameters, endpoint.target_name, capability)
    if errors:
        raise FilterSpecValidationError(errors)
    # ... rest unchanged
```

**Step 5: Run tests — verify they pass**

```bash
pytest corehq/apps/case_search/tests/test_endpoint_service.py -v
```

Expected: All tests PASS (14 existing + 11 new = 25).

**Step 6: Commit**

```bash
git add corehq/apps/case_search/endpoint_service.py \
       corehq/apps/case_search/tests/test_endpoint_service.py
git commit -m "feat: add filter spec validation with field/component/input checks"
```

---

## Task 6: Views and URLs

**Files:**
- Modify: `corehq/apps/case_search/views.py`
- Modify: `corehq/apps/case_search/urls.py`
- Modify: `corehq/apps/case_search/tests/test_views.py`

**Step 1: Write failing tests**

Append to `corehq/apps/case_search/tests/test_views.py`:

```python
import json

from django.test import TestCase
from django.urls import reverse

from corehq.apps.case_search.endpoint_service import (
    create_endpoint,
    get_version,
    save_new_version,
)
from corehq.apps.case_search.models import CaseSearchEndpoint
from corehq.apps.case_search.views import (
    CaseSearchEndpointDeactivateView,
    CaseSearchEndpointEditView,
    CaseSearchEndpointNewView,
    CaseSearchEndpointsView,
    CaseSearchEndpointVersionView,
)
from corehq.tests.util.htmx import HtmxViewTestCase
from corehq.util.test_utils import flag_enabled

DOMAIN = 'test-domain'
SAMPLE_QUERY = {'type': 'and', 'children': []}
SAMPLE_PARAMS = [{'name': 'province', 'type': 'text'}]


@flag_enabled('CASE_SEARCH_ENDPOINTS')
class TestCaseSearchEndpointsListView(HtmxViewTestCase):

    def get_url(self):
        return reverse(CaseSearchEndpointsView.urlname, args=[self.domain])

    def test_list_empty(self):
        response = self.client.get(self.get_url())
        self.assertEqual(response.status_code, 200)

    def test_list_with_endpoints(self):
        create_endpoint(self.domain, 'ep-1', 'project_db', 'patient', [], {})
        response = self.client.get(self.get_url())
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'ep-1')


@flag_enabled('CASE_SEARCH_ENDPOINTS')
class TestCaseSearchEndpointCreateView(HtmxViewTestCase):

    def get_url(self):
        return reverse(CaseSearchEndpointNewView.urlname, args=[self.domain])

    def test_get_renders_form(self):
        response = self.client.get(self.get_url())
        self.assertEqual(response.status_code, 200)

    def test_post_creates_endpoint(self):
        response = self.client.post(
            self.get_url(),
            data=json.dumps({
                'name': 'find-patients',
                'target_type': 'project_db',
                'target_name': 'patient',
                'parameters': SAMPLE_PARAMS,
                'query': SAMPLE_QUERY,
            }),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 200)
        endpoint = CaseSearchEndpoint.objects.get(
            domain=self.domain, name='find-patients',
        )
        self.assertIsNotNone(endpoint.current_version)
        self.assertEqual(endpoint.current_version.version_number, 1)

    def test_post_returns_400_on_invalid_spec(self):
        response = self.client.post(
            self.get_url(),
            data=json.dumps({
                'name': 'bad-endpoint',
                'target_type': 'project_db',
                'target_name': 'patient',
                'parameters': [],
                'query': {'type': 'invalid'},
            }),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 400)
        data = json.loads(response.content)
        self.assertIn('errors', data)


@flag_enabled('CASE_SEARCH_ENDPOINTS')
class TestCaseSearchEndpointEditView(HtmxViewTestCase):

    def setUp(self):
        super().setUp()
        self.endpoint = create_endpoint(
            self.domain, 'ep-1', 'project_db', 'patient', [], {},
        )

    def get_url(self):
        return reverse(
            CaseSearchEndpointEditView.urlname,
            args=[self.domain, self.endpoint.id],
        )

    def test_get_renders_edit_form(self):
        response = self.client.get(self.get_url())
        self.assertEqual(response.status_code, 200)

    def test_post_creates_new_version(self):
        response = self.client.post(
            self.get_url(),
            data=json.dumps({
                'parameters': SAMPLE_PARAMS,
                'query': SAMPLE_QUERY,
            }),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 200)
        self.endpoint.refresh_from_db()
        self.assertEqual(self.endpoint.current_version.version_number, 2)


@flag_enabled('CASE_SEARCH_ENDPOINTS')
class TestCaseSearchEndpointDeactivateView(HtmxViewTestCase):

    def setUp(self):
        super().setUp()
        self.endpoint = create_endpoint(
            self.domain, 'ep-1', 'project_db', 'patient', [], {},
        )

    def get_url(self):
        return reverse(
            CaseSearchEndpointDeactivateView.urlname,
            args=[self.domain, self.endpoint.id],
        )

    def test_post_deactivates(self):
        response = self.client.post(self.get_url())
        self.assertEqual(response.status_code, 302)
        self.endpoint.refresh_from_db()
        self.assertFalse(self.endpoint.is_active)


@flag_enabled('CASE_SEARCH_ENDPOINTS')
class TestEndpointRoundTrip(HtmxViewTestCase):
    """Test that a complex filter spec survives create → edit → version view."""

    COMPLEX_QUERY = {
        'type': 'and',
        'children': [
            {
                'type': 'component',
                'component': 'exact_match',
                'field': 'province',
                'inputs': {
                    'value': {'type': 'parameter', 'ref': 'search_province'},
                },
            },
            {
                'type': 'or',
                'children': [
                    {
                        'type': 'component',
                        'component': 'exact_match',
                        'field': 'status',
                        'inputs': {
                            'value': {'type': 'constant', 'value': 'active'},
                        },
                    },
                    {
                        'type': 'component',
                        'component': 'after',
                        'field': 'last_modified',
                        'inputs': {
                            'value': {'type': 'auto_value', 'ref': 'today()'},
                        },
                    },
                ],
            },
        ],
    }
    COMPLEX_PARAMS = [
        {'name': 'search_province', 'type': 'text'},
        {'name': 'min_age', 'type': 'number'},
    ]

    def test_create_and_retrieve_preserves_spec(self):
        endpoint = create_endpoint(
            self.domain, 'complex-ep', 'project_db', 'patient',
            self.COMPLEX_PARAMS, self.COMPLEX_QUERY,
        )
        version = get_version(endpoint, 1)
        self.assertEqual(version.query, self.COMPLEX_QUERY)
        self.assertEqual(version.parameters, self.COMPLEX_PARAMS)

    def test_new_version_preserves_old(self):
        endpoint = create_endpoint(
            self.domain, 'complex-ep', 'project_db', 'patient',
            self.COMPLEX_PARAMS, self.COMPLEX_QUERY,
        )
        new_query = {'type': 'and', 'children': []}
        save_new_version(endpoint, [], new_query)

        v1 = get_version(endpoint, 1)
        v2 = get_version(endpoint, 2)
        self.assertEqual(v1.query, self.COMPLEX_QUERY)
        self.assertEqual(v2.query, new_query)
```

**Step 2: Run tests — verify they fail**

```bash
pytest corehq/apps/case_search/tests/test_views.py::TestCaseSearchEndpointsListView -v
```

Expected: `ImportError` — views don't exist yet.

**Step 3: Add URL patterns**

Update `corehq/apps/case_search/urls.py`:

```python
from django.urls import re_path as url

from corehq.apps.case_search.views import (
    CaseSearchEndpointDeactivateView,
    CaseSearchEndpointEditView,
    CaseSearchEndpointNewView,
    CaseSearchEndpointsView,
    CaseSearchEndpointVersionView,
    CaseSearchCapabilityView,
    CaseSearchView,
    CSQLFixtureExpressionView,
    ProfileCaseSearchView,
)

urlpatterns = [
    url(r'^search/$', CaseSearchView.as_view(), name='case_search'),
    url(r'^profile/$', ProfileCaseSearchView.as_view(), name='profile_case_search'),
    url(r'^csql_fixture_configuration/$', CSQLFixtureExpressionView.as_view(),
        name='csql_fixture_configuration'),
    url(r'^endpoints/$', CaseSearchEndpointsView.as_view(),
        name=CaseSearchEndpointsView.urlname),
    url(r'^endpoints/new/$', CaseSearchEndpointNewView.as_view(),
        name=CaseSearchEndpointNewView.urlname),
    url(r'^endpoints/capability/$', CaseSearchCapabilityView.as_view(),
        name=CaseSearchCapabilityView.urlname),
    url(r'^endpoints/(?P<endpoint_id>\d+)/edit/$', CaseSearchEndpointEditView.as_view(),
        name=CaseSearchEndpointEditView.urlname),
    url(r'^endpoints/(?P<endpoint_id>\d+)/versions/(?P<version_number>\d+)/$',
        CaseSearchEndpointVersionView.as_view(),
        name=CaseSearchEndpointVersionView.urlname),
    url(r'^endpoints/(?P<endpoint_id>\d+)/deactivate/$',
        CaseSearchEndpointDeactivateView.as_view(),
        name=CaseSearchEndpointDeactivateView.urlname),
]
```

**Step 4: Add views**

Append to `corehq/apps/case_search/views.py`:

```python
import json

from django.http import JsonResponse
from django.shortcuts import redirect
from django.utils.decorators import method_decorator
from django.urls import reverse

from corehq import toggles
from corehq.apps.hqwebapp.decorators import use_bootstrap5
from corehq.apps.settings.views import BaseProjectDataView

from corehq.apps.case_search.endpoint_capability import get_capability
from corehq.apps.case_search.endpoint_service import (
    FilterSpecValidationError,
    create_endpoint,
    deactivate_endpoint,
    get_endpoint,
    get_version,
    list_endpoints,
    save_new_version,
)


@method_decorator([
    use_bootstrap5,
    toggles.CASE_SEARCH_ENDPOINTS.required_decorator(),
], name='dispatch')
class CaseSearchEndpointsView(BaseProjectDataView):
    urlname = 'case_search_endpoints'
    page_title = 'Case Search Endpoints'
    template_name = 'case_search/endpoint_list.html'

    @property
    def page_context(self):
        return {
            'endpoints': list_endpoints(self.domain),
        }


@method_decorator([
    use_bootstrap5,
    toggles.CASE_SEARCH_ENDPOINTS.required_decorator(),
], name='dispatch')
class CaseSearchEndpointNewView(BaseProjectDataView):
    urlname = 'case_search_endpoint_new'
    page_title = 'New Case Search Endpoint'
    template_name = 'case_search/endpoint_edit.html'

    @property
    def page_context(self):
        return {
            'capability': get_capability(self.domain),
            'endpoint': None,
            'mode': 'create',
        }

    def post(self, request, *args, **kwargs):
        data = json.loads(request.body)
        try:
            endpoint = create_endpoint(
                domain=self.domain,
                name=data['name'],
                target_type=data['target_type'],
                target_name=data['target_name'],
                parameters=data['parameters'],
                query=data['query'],
            )
        except FilterSpecValidationError as e:
            return JsonResponse({'errors': e.errors}, status=400)
        return JsonResponse({
            'id': endpoint.id,
            'redirect': reverse(self.urlname, args=[self.domain]),
        })


@method_decorator([
    use_bootstrap5,
    toggles.CASE_SEARCH_ENDPOINTS.required_decorator(),
], name='dispatch')
class CaseSearchEndpointEditView(BaseProjectDataView):
    urlname = 'case_search_endpoint_edit'
    page_title = 'Edit Case Search Endpoint'
    template_name = 'case_search/endpoint_edit.html'

    @property
    def page_context(self):
        endpoint = get_endpoint(self.domain, self.kwargs['endpoint_id'])
        return {
            'capability': get_capability(self.domain),
            'endpoint': endpoint,
            'current_version': endpoint.current_version,
            'mode': 'edit',
        }

    def post(self, request, *args, **kwargs):
        endpoint = get_endpoint(self.domain, self.kwargs['endpoint_id'])
        data = json.loads(request.body)
        try:
            version = save_new_version(
                endpoint,
                parameters=data['parameters'],
                query=data['query'],
            )
        except FilterSpecValidationError as e:
            return JsonResponse({'errors': e.errors}, status=400)
        return JsonResponse({
            'version_number': version.version_number,
            'redirect': reverse(
                CaseSearchEndpointsView.urlname, args=[self.domain],
            ),
        })


@method_decorator([
    use_bootstrap5,
    toggles.CASE_SEARCH_ENDPOINTS.required_decorator(),
], name='dispatch')
class CaseSearchEndpointVersionView(BaseProjectDataView):
    urlname = 'case_search_endpoint_version'
    page_title = 'Endpoint Version'
    template_name = 'case_search/endpoint_edit.html'

    @property
    def page_context(self):
        endpoint = get_endpoint(self.domain, self.kwargs['endpoint_id'])
        version = get_version(endpoint, int(self.kwargs['version_number']))
        return {
            'capability': get_capability(self.domain),
            'endpoint': endpoint,
            'current_version': version,
            'mode': 'readonly',
        }


@method_decorator([
    use_bootstrap5,
    toggles.CASE_SEARCH_ENDPOINTS.required_decorator(),
], name='dispatch')
class CaseSearchEndpointDeactivateView(BaseProjectDataView):
    urlname = 'case_search_endpoint_deactivate'

    def post(self, request, *args, **kwargs):
        endpoint = get_endpoint(self.domain, self.kwargs['endpoint_id'])
        deactivate_endpoint(endpoint)
        return redirect(
            reverse(CaseSearchEndpointsView.urlname, args=[self.domain]),
        )


@method_decorator([
    use_bootstrap5,
    toggles.CASE_SEARCH_ENDPOINTS.required_decorator(),
], name='dispatch')
class CaseSearchCapabilityView(BaseProjectDataView):
    urlname = 'case_search_capability'

    def get(self, request, *args, **kwargs):
        return JsonResponse(get_capability(self.domain))
```

**Step 5: Create stub templates**

Create minimal stub templates so views can render without error. These will be fleshed out in Task 6.

`corehq/apps/case_search/templates/case_search/endpoint_list.html`:
```html
{% extends "hqwebapp/bootstrap5/base_section.html" %}
{% block page_content %}
<div id="endpoint-list">
  {% for ep in endpoints %}
    <div>{{ ep.name }}</div>
  {% empty %}
    <p>No endpoints configured.</p>
  {% endfor %}
</div>
{% endblock %}
```

`corehq/apps/case_search/templates/case_search/endpoint_edit.html`:
```html
{% extends "hqwebapp/bootstrap5/base_section.html" %}
{% block page_content %}
<div id="endpoint-edit">
  <p>Query builder placeholder (mode: {{ mode }})</p>
</div>
{% endblock %}
```

**Step 6: Run tests — verify they pass**

```bash
pytest corehq/apps/case_search/tests/test_views.py -v
```

Expected: All tests PASS (existing + new).

**Step 7: Commit**

```bash
git add corehq/apps/case_search/views.py \
       corehq/apps/case_search/urls.py \
       corehq/apps/case_search/tests/test_views.py \
       corehq/apps/case_search/templates/case_search/endpoint_list.html \
       corehq/apps/case_search/templates/case_search/endpoint_edit.html
git commit -m "feat: add case search endpoint views and URL configuration"
```

---

## Task 7: Endpoint List Template

**Files:**
- Modify: `corehq/apps/case_search/templates/case_search/endpoint_list.html`

**Step 1: Implement full list template**

```html
{% extends "hqwebapp/bootstrap5/base_section.html" %}
{% load i18n %}

{% block page_content %}
<div class="container">
  <div class="d-flex justify-content-between align-items-center mb-3">
    <h2>{% trans "Case Search Endpoints" %}</h2>
    <a href="{% url 'case_search_endpoint_new' domain %}"
       class="btn btn-primary">
      {% trans "New Endpoint" %}
    </a>
  </div>

  {% if endpoints %}
  <table class="table table-striped">
    <thead>
      <tr>
        <th>{% trans "Name" %}</th>
        <th>{% trans "Target" %}</th>
        <th>{% trans "Current Version" %}</th>
        <th>{% trans "Created" %}</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      {% for ep in endpoints %}
      <tr>
        <td>
          <a href="{% url 'case_search_endpoint_edit' domain ep.id %}">
            {{ ep.name }}
          </a>
        </td>
        <td>{{ ep.target_type }}: {{ ep.target_name }}</td>
        <td>
          {% if ep.current_version %}
            v{{ ep.current_version.version_number }}
          {% else %}
            —
          {% endif %}
        </td>
        <td>{{ ep.created_at|date:"N j, Y" }}</td>
        <td>
          <form method="post"
                action="{% url 'case_search_endpoint_deactivate' domain ep.id %}"
                onsubmit="return confirm('{% trans "Deactivate this endpoint?" %}')">
            {% csrf_token %}
            <button type="submit" class="btn btn-sm btn-outline-danger">
              {% trans "Deactivate" %}
            </button>
          </form>
        </td>
      </tr>
      {% endfor %}
    </tbody>
  </table>
  {% else %}
  <div class="alert alert-info">
    {% trans "No endpoints configured. Create one to get started." %}
  </div>
  {% endif %}
</div>
{% endblock %}
```

**Step 2: Verify existing tests still pass**

```bash
pytest corehq/apps/case_search/tests/test_views.py::TestCaseSearchEndpointsListView -v
```

Expected: PASS.

**Step 3: Commit**

```bash
git add corehq/apps/case_search/templates/case_search/endpoint_list.html
git commit -m "feat: implement endpoint list template"
```

---

## Task 8: Endpoint Edit Template

**Files:**
- Modify: `corehq/apps/case_search/templates/case_search/endpoint_edit.html`

**Step 1: Implement edit template**

```html
{% extends "hqwebapp/bootstrap5/base_section.html" %}
{% load i18n %}

{% block page_content %}
<div class="container" x-data="endpointEditor()" x-init="init()">

  {% if mode == 'create' %}
  <h2>{% trans "New Case Search Endpoint" %}</h2>
  <div class="mb-3">
    <label class="form-label">{% trans "Name" %}</label>
    <input type="text" class="form-control" x-model="endpointName">
  </div>
  <div class="mb-3">
    <label class="form-label">{% trans "Target Type" %}</label>
    <select class="form-select" x-model="targetType">
      <option value="project_db">Project DB</option>
    </select>
  </div>
  <div class="mb-3">
    <label class="form-label">{% trans "Case Type" %}</label>
    <select class="form-select" x-model="targetName">
      <template x-for="ct in capability.case_types" :key="ct.name">
        <option :value="ct.name" x-text="ct.name"></option>
      </template>
    </select>
  </div>
  {% else %}
  <h2>
    {{ endpoint.name }}
    {% if mode == 'readonly' %}
      <span class="badge bg-secondary">v{{ current_version.version_number }} (read-only)</span>
    {% endif %}
  </h2>
  {% endif %}

  {% include "case_search/partials/query_builder.html" %}

  <!-- Validation errors -->
  <template x-if="validationErrors.length > 0">
    <div class="alert alert-danger mt-3">
      <strong>{% trans "Validation errors:" %}</strong>
      <ul class="mb-0">
        <template x-for="err in validationErrors" :key="err">
          <li x-text="err"></li>
        </template>
      </ul>
    </div>
  </template>

  {% if mode != 'readonly' %}
  <div class="mt-3">
    <button class="btn btn-primary" @click="validationErrors = []; save()">
      {% if mode == 'create' %}
        {% trans "Create Endpoint" %}
      {% else %}
        {% trans "Save New Version" %}
      {% endif %}
    </button>
    <a href="{% url 'case_search_endpoints' domain %}" class="btn btn-outline-secondary">
      {% trans "Cancel" %}
    </a>
  </div>
  {% endif %}
</div>

{{ capability|json_script:"capability-data" }}
{{ current_version.parameters|default_if_none:"[]"|json_script:"parameters-data" }}
{{ current_version.query|default_if_none:"{}"|json_script:"query-data" }}

<script>
  document.addEventListener('alpine:init', () => {
    Alpine.data('endpointEditor', () => ({
      mode: '{{ mode }}',
      endpointName: '',
      targetType: 'project_db',
      targetName: '',
      validationErrors: [],
      capability: JSON.parse(document.getElementById('capability-data').textContent),
      parameters: JSON.parse(document.getElementById('parameters-data').textContent),
      filterTree: JSON.parse(document.getElementById('query-data').textContent),

      init() {
        {% if endpoint %}
        this.targetName = '{{ endpoint.target_name }}';
        {% endif %}
      },

      save() {
        const payload = {
          parameters: this.parameters,
          query: this.filterTree,
        };
        if (this.mode === 'create') {
          payload.name = this.endpointName;
          payload.target_type = this.targetType;
          payload.target_name = this.targetName;
        }
        const url = window.location.pathname;
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRFToken': document.querySelector('[name=csrfmiddlewaretoken]')?.value
              || document.cookie.match(/csrftoken=([^;]+)/)?.[1],
          },
          body: JSON.stringify(payload),
        })
        .then(r => r.json().then(data => ({status: r.status, data})))
        .then(({status, data}) => {
          if (status === 400 && data.errors) {
            this.validationErrors = data.errors;
          } else if (data.redirect) {
            window.location.href = data.redirect;
          }
        });
      },
    }));
  });
</script>
{% endblock %}
```

**Step 2: Verify existing tests still pass**

```bash
pytest corehq/apps/case_search/tests/test_views.py -v
```

Expected: PASS.

**Step 3: Commit**

```bash
git add corehq/apps/case_search/templates/case_search/endpoint_edit.html
git commit -m "feat: implement endpoint edit template with Alpine.js state"
```

---

## Task 9: Query Builder Partial

**Files:**
- Create: `corehq/apps/case_search/templates/case_search/partials/query_builder.html`

This is the standalone, reusable query builder component. It reads from the
parent Alpine scope (`capability`, `parameters`, `filterTree`, `targetName`)
and has no knowledge of the search endpoints context.

**Step 1: Implement the partial**

```html
{# Standalone query builder partial — reusable, no endpoint context #}
{# Expects parent Alpine scope to provide: capability, parameters, filterTree, targetName, mode #}
{% load i18n %}

<div class="card mb-3">
  <div class="card-header">{% trans "Parameters" %}</div>
  <div class="card-body">
    <template x-for="(param, idx) in parameters" :key="idx">
      <div class="row mb-2 align-items-center">
        <div class="col-5">
          <input type="text" class="form-control form-control-sm"
                 placeholder="{% trans 'Parameter name' %}"
                 x-model="param.name" :disabled="mode === 'readonly'">
        </div>
        <div class="col-4">
          <select class="form-select form-select-sm"
                  x-model="param.type" :disabled="mode === 'readonly'">
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
          </select>
        </div>
        <div class="col-3" x-show="mode !== 'readonly'">
          <button class="btn btn-sm btn-outline-danger"
                  @click="parameters.splice(idx, 1)">
            &times;
          </button>
        </div>
      </div>
    </template>
    <button class="btn btn-sm btn-outline-primary"
            x-show="mode !== 'readonly'"
            @click="parameters.push({name: '', type: 'text'})">
      {% trans "+ Add Parameter" %}
    </button>
  </div>
</div>

<div class="card mb-3">
  <div class="card-header">{% trans "Filters" %}</div>
  <div class="card-body">
    <template x-data x-ref="filterRoot">
      <div x-data="filterGroup(filterTree)">
        <template x-ref="groupTemplate">
          {% include "case_search/partials/_filter_group.html" %}
        </template>
      </div>
    </template>
  </div>
</div>
```

**Step 2: Create the recursive filter group sub-partial**

`corehq/apps/case_search/templates/case_search/partials/_filter_group.html`:

```html
{# Recursive filter group — renders AND/OR node with children #}
{# x-data context: node (the boolean node), parent scope has capability, parameters, targetName, mode #}
{% load i18n %}

<div class="border rounded p-2 mb-2 bg-light">
  <div class="d-flex align-items-center mb-2">
    <select class="form-select form-select-sm w-auto"
            x-model="node.type" :disabled="mode === 'readonly'"
            style="max-width: 100px;">
      <option value="and">AND</option>
      <option value="or">OR</option>
    </select>
  </div>

  <template x-for="(child, idx) in node.children" :key="idx">
    <div class="ms-3 mb-2">
      <!-- Group node (recursive) -->
      <template x-if="child.type === 'and' || child.type === 'or'">
        <div x-data="{ node: child }">
          {% include "case_search/partials/_filter_group.html" %}
          <button class="btn btn-sm btn-outline-danger mt-1"
                  x-show="mode !== 'readonly'"
                  @click="node.children.splice(idx, 1)">
            {% trans "Remove group" %}
          </button>
        </div>
      </template>

      <!-- Leaf node (component) -->
      <template x-if="child.type === 'component'">
        <div class="row g-2 align-items-center">
          <!-- Field selector -->
          <div class="col-3">
            <select class="form-select form-select-sm"
                    x-model="child.field" :disabled="mode === 'readonly'">
              <option value="">{% trans "— field —" %}</option>
              <template x-for="f in (capability.case_types.find(ct => ct.name === targetName)?.fields || [])"
                        :key="f.name">
                <option :value="f.name" x-text="f.name"></option>
              </template>
            </select>
          </div>

          <!-- Operation selector -->
          <div class="col-3">
            <select class="form-select form-select-sm"
                    x-model="child.component" :disabled="mode === 'readonly'">
              <option value="">{% trans "— operation —" %}</option>
              <template x-for="op in (capability.case_types.find(ct => ct.name === targetName)?.fields.find(f => f.name === child.field)?.operations || [])"
                        :key="op">
                <option :value="op" x-text="op.replace(/_/g, ' ')"></option>
              </template>
            </select>
          </div>

          <!-- Input slots — iterates component schema for multi-slot support -->
          <div class="col-4" x-show="child.component !== 'is_empty'">
            <template x-for="slot in (capability.component_schemas?.[child.component] || [])" :key="slot.name">
              <div class="input-group input-group-sm mb-1">
                <span class="input-group-text" x-text="slot.name"
                      x-show="(capability.component_schemas?.[child.component] || []).length > 1"
                      style="min-width: 60px; font-size: 0.75rem;"></span>
                <select class="form-select form-select-sm"
                        :disabled="mode === 'readonly'"
                        x-model="(child.inputs[slot.name] || {}).type"
                        @change="if (!child.inputs[slot.name]) child.inputs[slot.name] = {type: $event.target.value}"
                        style="max-width: 90px;">
                  <option value="constant">{% trans "Value" %}</option>
                  <option value="parameter">{% trans "Param" %}</option>
                  <option value="auto_value">{% trans "Auto" %}</option>
                </select>

                <!-- Constant input -->
                <template x-if="child.inputs[slot.name]?.type === 'constant'">
                  <input type="text" class="form-control form-control-sm"
                         x-model="child.inputs[slot.name].value"
                         :disabled="mode === 'readonly'">
                </template>

                <!-- Parameter reference -->
                <template x-if="child.inputs[slot.name]?.type === 'parameter'">
                  <select class="form-select form-select-sm"
                          x-model="child.inputs[slot.name].ref"
                          :disabled="mode === 'readonly'">
                    <template x-for="p in parameters" :key="p.name">
                      <option :value="p.name" x-text="p.name"></option>
                    </template>
                  </select>
                </template>

                <!-- Auto value reference -->
                <template x-if="child.inputs[slot.name]?.type === 'auto_value'">
                  <select class="form-select form-select-sm"
                          x-model="child.inputs[slot.name].ref"
                          :disabled="mode === 'readonly'">
                    <template x-for="av in Object.values(capability.auto_values || {}).flat()"
                              :key="av.ref">
                      <option :value="av.ref" x-text="av.label"></option>
                    </template>
                  </select>
                </template>
              </div>
            </template>
          </div>

          <!-- Remove condition -->
          <div class="col-2" x-show="mode !== 'readonly'">
            <button class="btn btn-sm btn-outline-danger"
                    @click="node.children.splice(idx, 1)">
              &times;
            </button>
          </div>
        </div>
      </template>
    </div>
  </template>

  <!-- Add buttons -->
  <div class="ms-3" x-show="mode !== 'readonly'">
    <button class="btn btn-sm btn-outline-primary"
            @click="node.children.push({type: 'component', component: '', field: '', inputs: {value: {type: 'constant', value: ''}}})">
      {% trans "+ Add condition" %}
    </button>
    <button class="btn btn-sm btn-outline-secondary"
            @click="node.children.push({type: 'and', children: []})">
      {% trans "+ Add group" %}
    </button>
  </div>
</div>
```

**Step 2: Verify all view tests still pass**

```bash
pytest corehq/apps/case_search/tests/test_views.py -v
```

Expected: PASS.

**Step 3: Commit**

```bash
git add corehq/apps/case_search/templates/case_search/partials/
git commit -m "feat: add standalone query builder Alpine.js partial"
```

---

## Open Questions (Deferred)

These are flagged in `query_builder_tech_spec.md` and do not block implementation:

1. **Delete vs. deactivate** — currently deactivate-only. Hard delete can be added later if needed.
2. **API authentication** — `api.py` (MCP access) is out of scope for this plan.
3. **`geopoint` fields** — `within_distance` requires PostGIS extensions that are
   not installed in production (flagged in `infrastructure_design.md`). The component
   is declared in the capability builder but unusable until extensions are provisioned.
4. **Alpine.js recursive template reactivity** — Django `{% include %}` for
   recursive filter groups may have scoping issues with Alpine.js. Likely needs
   debugging during implementation. If broken, alternative: flatten recursion in JS
   and use a single template with depth tracking.

---

## Task Summary

| Task | What | Files |
|------|------|-------|
| 1 | Feature flag | `toggles/__init__.py` |
| 2 | Data models + migration | `models.py`, migration, `test_endpoint_models.py` |
| 3 | Service layer | `endpoint_service.py`, `test_endpoint_service.py` |
| 4 | Capability builder + component schemas | `endpoint_capability.py`, `test_endpoint_capability.py` |
| 5 | Filter spec validation | `endpoint_service.py`, `test_endpoint_service.py` |
| 6 | Views + URLs + validation errors | `views.py`, `urls.py`, `test_views.py`, stub templates |
| 7 | List template | `endpoint_list.html` |
| 8 | Edit template (`json_script`) | `endpoint_edit.html` |
| 9 | Query builder partial (multi-slot) | `partials/query_builder.html`, `partials/_filter_group.html` |
