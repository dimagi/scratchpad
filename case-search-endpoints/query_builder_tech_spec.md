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
├── templates/case_search/
│   ├── endpoint_list.html          (new)
│   ├── endpoint_edit.html          (new)
│   └── partials/
│       └── query_builder.html      (new — standalone, reusable)
└── tests/
    ├── test_endpoint_service.py    (new)
    └── test_endpoint_capability.py (new)
```

Existing files modified:
- `models.py` — add `CaseSearchEndpoint`, `CaseSearchEndpointVersion`
- `views.py` — add new endpoint views
- `urls.py` — add new URL patterns
- `tests/test_views.py` — add endpoint view tests

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
| `parameters`     | JSONField    | Admin-defined params: `[{name, type}, ...]` |
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

All views are in `views.py` and call `service.py`. They contain no business
logic.

| URL | View | Notes |
|-----|------|-------|
| `GET /<domain>/case_search_endpoints/` | `CaseSearchEndpointsView` | Lists active endpoints |
| `GET/POST /<domain>/case_search_endpoints/new/` | `CaseSearchEndpointNewView` | Create endpoint + first version |
| `GET/POST /<domain>/case_search_endpoints/<id>/edit/` | `CaseSearchEndpointEditView` | Save new version |
| `GET /<domain>/case_search_endpoints/<id>/versions/<n>/` | `CaseSearchEndpointVersionView` | Read-only previous version |
| `POST /<domain>/case_search_endpoints/<id>/deactivate/` | `CaseSearchEndpointDeactivateView` | Soft delete |
| `GET /<domain>/case_search_endpoints/capability/` | `CaseSearchCapabilityView` | Returns capability JSON |

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
- Admin-defined parameters list `[{name, type}]`
- Selected case type (drives which fields are shown)

**UI structure:**

```
┌─ Target ──────────────────────────────────┐
│  Case type: [patient ▾]                   │
└───────────────────────────────────────────┘

┌─ Parameters ──────────────────────────────┐
│  [+ Add parameter]                        │
│  search_province  text   [×]              │
│  min_age          number [×]              │
└───────────────────────────────────────────┘

┌─ Filter ──────────────────────────────────┐
│  AND ▾                                    │
│  ├─ [field ▾]  [operation ▾]  [value ──]  │
│  ├─ OR ▾                                  │
│  │  ├─ [field ▾]  [operation ▾]  [value]  │
│  │  └─ [+ Add condition]                  │
│  └─ [+ Add condition]  [+ Add group]      │
└───────────────────────────────────────────┘
```

**Value slot:** For each leaf node input, the admin selects a value source:
- **Literal** — inline input appropriate to the slot type
- **Parameter** — dropdown of admin-defined parameters matching the slot type
- **Auto value** — dropdown of `auto_values[field.type]` entries

**Save:** HTMX POST serializes the Alpine state (parameters + filter tree)
as the JSON filter spec. Server validates and saves, returns the updated
list or inline validation errors.

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

1. **`PASSWORD` fields in query builder**: Should they be excluded from
   the field list entirely? They are a text type but searching by password
   is almost certainly unintended.

2. **`select` field options source**: Where do the possible values for a
   `SELECT` field come from? Options: (a) data dictionary allowed values
   if defined, (b) distinct values from case data, (c) free text. Needs
   a decision before implementing `capability.py`.

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
