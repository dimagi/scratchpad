# Query Builder: Technical Spec

## Overview

This document describes the technical implementation of the case search
endpoints feature: a UI for configuring named, versioned query endpoints
that filter case data using a visual query builder.

The query builder itself is backend-agnostic and reusable. The search
endpoints feature is one consumer of it.

Related design documents:
- `query_builder_design.md` — filter spec format, component catalog, backend interface
- `project_db_design.md` — project DB table schema
- `infrastructure_design.md` — database placement, multi-tenancy, backend selection

---

## App Location

All new code lives in the existing `corehq/apps/case_search/` app.
New files added:

```
corehq/apps/case_search/
├── endpoint_service.py        (new — business logic for endpoints)
├── endpoint_capability.py     (new — builds capability JSON from data dictionary)
├── api.py                     (new, future — MCP / programmatic access)
├── views/
│   └── endpoints.py           (new — endpoint views extracted from views.py)
├── templates/case_search/
│   ├── endpoint_list.html          (new)
│   ├── endpoint_edit.html          (new)
│   └── partials/
│       └── query_builder.html      (new — standalone, reusable)
└── tests/
    ├── test_endpoint_service.py    (new)
    ├── test_endpoint_capability.py (new)
    └── test_endpoint_views.py      (new)
```

Existing files modified:
- `models.py` — add `CaseSearchEndpoint`, `CaseSearchEndpointVersion`
- `urls.py` — add new URL patterns, importing endpoint views directly from `views/endpoints.py`
- `tests/test_views.py` — existing view tests unaffected

---

## Feature Flag

All views are gated behind the `CASE_SEARCH_ENDPOINTS` domain-level toggle.
Views return 404 if the flag is off for the domain.

---

## Data Model

### `CaseSearchEndpoint`

| Column           | Type         | Notes                                      |
|------------------|--------------|--------------------------------------------|
| `id`             | AutoField    | Primary key                                |
| `domain`         | CharField    | Project domain                             |
| `name`           | CharField    | Human-readable name, unique per domain     |
| `target_type`    | CharField    | Choices: `'project_db'` (more added later) |
| `target_name`    | CharField    | Case type name for `project_db` target     |
| `current_version`| FK (nullable)| Points to the active `CaseSearchEndpointVersion` |
| `created_at`     | DateTimeField| Auto-set on creation                       |
| `is_active`      | BooleanField | False = soft-deleted                       |

`target_type` + `target_name` are split from the start so future targets
(Elasticsearch, join views) can be added without a data migration.

### `CaseSearchEndpointVersion`

| Column           | Type         | Notes                                       |
|------------------|--------------|---------------------------------------------|
| `id`             | AutoField    | Primary key                                 |
| `endpoint`       | FK           | → `CaseSearchEndpoint`                      |
| `version_number` | IntegerField | Scoped per endpoint, starts at 1, increments on each save |
| `parameters`     | JSONField    | Admin-defined params: `[{name, type, required}, ...]` |
| `query`          | JSONField    | Filter spec tree (see `query_builder_design.md`) |
| `created_at`     | DateTimeField| Auto-set on creation                        |

`version_number` is computed as `MAX(version_number) + 1` for the endpoint
at save time. Version rows are never deleted — they remain referenceable
by pinned app versions.

---

## Service Layer

`service.py` contains all business logic. Views and future API endpoints
are thin wrappers that call these functions. Tests live here.

```python
def create_endpoint(domain, name, target_type, target_name, parameters, query)
    -> CaseSearchEndpoint

def save_new_version(endpoint, parameters, query)
    -> CaseSearchEndpointVersion

def list_endpoints(domain)
    -> QuerySet[CaseSearchEndpoint]

def get_endpoint(domain, endpoint_id)
    -> CaseSearchEndpoint

def get_version(endpoint, version_number)
    -> CaseSearchEndpointVersion

def deactivate_endpoint(endpoint)
    -> None

def get_capability(domain)
    -> dict   # capability JSON structure (see below)
```

This separation allows an `api.py` (for MCP or programmatic access) to
call the same functions and return JSON responses without any logic
duplication.

### Filter Spec Validation

`create_endpoint` and `save_new_version` validate the filter spec before
persisting. Validation is a separate function so it can be tested and
reused independently.

```python
def validate_filter_spec(query, capability)
    -> list[str]   # empty = valid; non-empty = list of error messages
```

Validation rules:

1. **Structure**: Root must be a boolean node (`and`, `or`) or a single
   `component` node. Boolean nodes must have a `children` list (or `child`
   for `not`). Component nodes must have `component`, `field`, and `inputs`.
2. **Field existence**: `field` must reference a field in the capability's
   case type.
3. **Component/field compatibility**: `component` must be in the field's
   `operations` list.
4. **Input completeness**: All required input slots for the component must
   be present. The required slots are derived from the component catalog
   (see below).
5. **Input type validity**: Each input slot value must have a valid `type`
   (`constant`, `parameter`, `auto_value`). Parameter refs must reference
   a declared parameter. Auto value refs must exist in `auto_values`.
6. **Version number conflicts**: On save, if `MAX(version_number) + 1`
   collides (concurrent save), catch `IntegrityError` and return a user-
   facing error: "Another version was saved. Please reload and try again."

Views return validation errors as JSON `{"errors": [...]}` with HTTP 400.

### Component Input Schema

Components declare their required input slots. This is used by both the
UI (to render the right number of inputs) and validation (to check
completeness).

```python
COMPONENT_INPUT_SCHEMAS = {
    'exact_match':    [{'name': 'value', 'type': 'text'}],
    'not_equals':     [{'name': 'value', 'type': 'text'}],
    'starts_with':    [{'name': 'value', 'type': 'text'}],
    'fuzzy_match':    [{'name': 'value', 'type': 'text'}],
    'phonetic_match': [{'name': 'value', 'type': 'text'}],
    'selected_any':   [{'name': 'value', 'type': 'text'}],
    'selected_all':   [{'name': 'value', 'type': 'text'}],
    'is_empty':       [],
    'equals':         [{'name': 'value', 'type': 'match_field'}],
    'gt':             [{'name': 'value', 'type': 'number'}],
    'gte':            [{'name': 'value', 'type': 'number'}],
    'lt':             [{'name': 'value', 'type': 'number'}],
    'lte':            [{'name': 'value', 'type': 'number'}],
    'before':         [{'name': 'value', 'type': 'match_field'}],
    'after':          [{'name': 'value', 'type': 'match_field'}],
    'date_range':     [{'name': 'start', 'type': 'match_field'},
                       {'name': 'end', 'type': 'match_field'}],
    'fuzzy_date':     [{'name': 'value', 'type': 'date'}],
    'within_distance':[{'name': 'point', 'type': 'geopoint'},
                       {'name': 'distance', 'type': 'number'},
                       {'name': 'unit', 'type': 'choice'}],
}
```

`match_field` means the slot type matches the field's type (e.g., `date`
field → `date` slot, `number` field → `number` slot). This allows the UI
to offer the right auto values and parameter type filtering.

---

## Field Capability JSON

`capability.py` builds the capability response from the data dictionary.
`get_capability(domain)` returns:

```json
{
  "case_types": [
    {
      "name": "patient",
      "fields": [
        {
          "name": "first_name",
          "type": "text",
          "operations": ["exact_match", "not_equals", "starts_with", "fuzzy_match", "phonetic_match", "is_empty"]
        },
        {
          "name": "dob",
          "type": "date",
          "operations": ["equals", "before", "after", "date_range", "fuzzy_date", "is_empty"]
        },
        {
          "name": "age",
          "type": "number",
          "operations": ["equals", "not_equals", "gt", "gte", "lt", "lte", "is_empty"]
        },
        {
          "name": "status",
          "type": "select",
          "operations": ["selected_any", "selected_all", "exact_match", "is_empty"],
          "options": ["active", "closed", "pending"]
        }
      ]
    }
  ],
  "auto_values": {
    "date":     [{ "ref": "today()",       "label": "Today" }],
    "datetime": [{ "ref": "now()",         "label": "Now" }],
    "text":     [{ "ref": "user.username", "label": "Current user's username" },
                 { "ref": "user.uuid",     "label": "Current user's ID" },
                 { "ref": "user.location_ids", "label": "User's location IDs" }]
  }
}
```

Key points:

- Source for `case_types` is `CaseType.objects.filter(domain=domain, is_deprecated=False)`
- `fields` derived from non-deprecated `CaseProperty` records for each case type
- `operations` per field determined by `DataType` → field type mapping (see below)
- `options` for `select` fields: populated from distinct values in existing case data (or data dictionary allowed values if defined)
- `auto_values` grouped by field type — the UI offers only the entries matching the current input slot's type
- Auto values are defined statically on the backend

### DataType → Field Type Mapping

| `CaseProperty.DataType` | Field type | Notes |
|-------------------------|------------|-------|
| `PLAIN`                 | `text`     |       |
| `BARCODE`               | `text`     |       |
| `PHONE_NUMBER`          | `text`     |       |
| `PASSWORD`              | `text`     | Consider excluding from query builder |
| `UNDEFINED`             | `text`     |       |
| `DATE`                  | `date`     |       |
| `NUMBER`                | `number`   |       |
| `SELECT`                | `select`   |       |
| `GPS`                   | `geopoint` | `within_distance` requires PostGIS — not available yet |

Future targets (ES, join views) implement the same JSON contract, derived
differently. The `get_capability` function should accept a `target_type`
parameter to support this expansion.

---

## Views and URLs

All endpoint views live in `views/endpoints.py`. `urls.py` imports them
directly from there. They call `service.py` only — no business logic in views.

### URL table

| URL | View | Notes |
|-----|------|-------|
| `GET /<domain>/case_search_endpoints/` | `CaseSearchEndpointsView` | Lists active endpoints |
| `GET/POST /<domain>/case_search_endpoints/new/` | `CaseSearchEndpointNewView` | Create endpoint + first version |
| `GET/POST /<domain>/case_search_endpoints/<id>/edit/` | `CaseSearchEndpointEditView` | Edit current version; also serves historical read-only view via `?version=<n>` |
| `POST /<domain>/case_search_endpoints/<id>/deactivate/` | `CaseSearchEndpointDeactivateView` | Soft delete |
| `GET /<domain>/case_search_endpoints/capability/` | `CaseSearchCapabilityView` | Returns capability JSON |

The separate `CaseSearchEndpointVersionView` is no longer needed. When
`?version=<n>` is supplied and `n` is not the current version, the edit view
renders in read-only mode — all fields and the save button are disabled and
a banner indicates the user is viewing a historical version. The version
selector dropdown navigates between versions via URL replacement.

### Shared mixin

All endpoint views share a common decorator block and repeated lookups.
Extract these into `CaseSearchEndpointMixin` (modelled on `RoleContextMixin`
in `corehq/apps/users/views/role.py`):

```python
_ENDPOINT_DECORATORS = [
    use_bootstrap5,
    toggles.CASE_SEARCH_ENDPOINTS.required_decorator(),
]

class CaseSearchEndpointMixin:
    """Shared setup for case search endpoint views."""

    @property
    @memoized
    def capability(self):
        return get_capability(self.domain)

    @property
    @memoized
    def endpoint(self):
        return get_endpoint(self.domain, self.kwargs['endpoint_id'])

    def _initial_context(self, version, mode):
        """Returns the template context fields common to new/edit/readonly."""
        return {
            'capability': self.capability,
            'mode': mode,
            'initial_parameters': version.parameters if version else [],
            'initial_query': version.query if version else {'type': 'and', 'children': []},
            'initial_target_name': (
                self.endpoint.target_name if hasattr(self, 'endpoint') else ''
            ),
        }
```

Each view is then decorated once at class level:

```python
@method_decorator(_ENDPOINT_DECORATORS, name='dispatch')
class CaseSearchEndpointsView(CaseSearchEndpointMixin, BaseProjectDataView):
    ...
```

### Private helpers

Logic extracted out of view methods (following the `_update_role_from_view`
pattern) so it is independently testable:

```python
def _parse_endpoint_post(request) -> dict:
    """Parses and returns the JSON body from a new/edit POST request."""

def _endpoint_post_response(endpoint_or_version, domain) -> JsonResponse:
    """Builds the success JSON response after create or save-new-version."""
```

The capability view is an HTMX endpoint. The new/edit views embed the
capability JSON directly in the page (no separate HTMX fetch needed — it
is loaded once on page load).

---

## Query Builder UI

`query_builder.html` is a standalone template included via `{% include %}`.
It has no knowledge of the search endpoints context and can be reused
elsewhere. The capability JSON and any existing query spec are passed in
as template variables.

**Tech stack:** HTMX for server interactions, Alpine.js for local UI state,
Bootstrap 5 for styling.

**Alpine.js state:**
- Filter tree (AND/OR/NOT nodes + leaf component instances)
- Admin-defined parameters list `[{name, type, required}]`
- Selected case type (drives which fields are shown)
- Read-only mode flag (set when viewing a non-current version)

**UI structure:**

```
┌─ Endpoint Details ────────────────────────────────────────┐
│  Version: [v2 (current) ▾]  Name: [______]                │
│  Target Type: [Project DB ▾]  Case Type: [patient ▾]      │
└───────────────────────────────────────────────────────────┘

┌─ Parameters ──────────────────────────────────────────────┐
│  [+ Add parameter]                                        │
│  [T] search_province  text    Required [toggle on]  [×]   │
│  [#] min_age          number  Required [toggle off] [×]   │
└───────────────────────────────────────────────────────────┘

┌─ Filter ──────────────────────────────────────────────────┐
│  AND ▾                                                    │
│  ├─ [field ▾]  [operation ▾]  [" | ⬡ | ⚡]  [value ──]   │
│  ├─ OR ▾                                                  │
│  │  ├─ [field ▾]  [operation ▾]  [" | ⬡ | ⚡]  [value]   │
│  │  └─ [+ Add condition]                                  │
│  └─ [+ Add condition]  [+ Add group]                      │
└───────────────────────────────────────────────────────────┘
```

The version selector dropdown in Endpoint Details lists all versions for the endpoint (`v1`, `v2 (current)`, etc.). Selecting a non-current version reloads the page at `?version=<n>` in read-only mode. The value source toggle (`"` = constant, `⬡` = parameter, `⚡` = auto-value) renders as three icon buttons with tooltips.

**Value slots:** Each leaf node renders input fields for every slot in the
component's `COMPONENT_INPUT_SCHEMAS` entry. Components with multiple
slots (e.g., `date_range` → `start` + `end`) render multiple input rows.

For each input slot, the admin selects a value source:
- **Literal** — inline input appropriate to the slot type
- **Parameter** — dropdown of admin-defined parameters matching the slot type
- **Auto value** — dropdown of `auto_values[field.type]` entries

**Data injection:** Capability JSON and existing query spec are injected
into the template using Django's `json_script` template tag (not
`{{ var|safe }}`) to prevent XSS from user-controlled field names:

```html
{{ capability|json_script:"capability-data" }}
{{ current_query|json_script:"query-data" }}

<script>
  const capability = JSON.parse(
    document.getElementById('capability-data').textContent
  );
</script>
```

**Save:** HTMX POST serializes the Alpine state (parameters + filter tree)
as the JSON filter spec. Server validates and saves, returns the updated
list or inline validation errors (HTTP 400 with `{"errors": [...]}`).

---

## Versioning Behavior

- "Update" always creates a new `CaseSearchEndpointVersion` — existing
  versions are immutable
- `current_version` on the endpoint is updated to the new version
- Previous versions are accessible read-only via the version URL
- Apps can pin to a specific `version_number` to avoid picking up changes
- Deactivating an endpoint sets `is_active = False` — version rows are
  never deleted

---

## Open Questions

1. ~~**`PASSWORD` fields in query builder**~~: **Resolved** — excluded
   from capability builder. Not queryable.

2. ~~**`select` field options source**~~: **Resolved** — data dictionary
   `CasePropertyAllowedValue` records (option a).

3. **Delete vs. deactivate**: The list view shows a deactivate action.
   Should there also be a hard delete for endpoints that have never been
   used / have no pinned references? Out of scope for now but worth
   deciding before launch.

4. **API authentication**: When `api.py` is built for MCP access, what
   auth mechanism does it use? (API key, OAuth, etc.) — not relevant for
   the HTML views but needs to be decided before the MCP is built.

## Out of Scope

- Query execution (the endpoint that runs a stored query against the target)
- ES and join view targets
- API endpoints (`api.py`) — structure is in place, implementation deferred
- Permission model beyond the feature flag
- Migration of existing XPath-based case search filters
