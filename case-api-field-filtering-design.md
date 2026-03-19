# Design: Case API Field Filtering

## Problem

API users need to limit the fields returned from the Case API v2 to avoid
receiving sensitive information or unnecessary data.

## Solution

Two new mutually exclusive query parameters, `fields` and `exclude`, that
filter the serialized case JSON as a post-processing step. This operates on
the response dict without knowledge of the serialization or query logic.

### Parameters

**`fields`** — comma-separated list of field names to include. Only specified
fields appear in the response. Dot notation for nested fields
(`properties.edd`). An empty value (`?fields=`) returns `{}`.

**`exclude`** — comma-separated list of field names to remove from the
response. Dot notation supported. An empty value is equivalent to not
specifying the parameter.

Using both `fields` and `exclude` in the same request raises a `UserError`.

Both comma-separated values (`?fields=case_id,case_type`) and repeated
params (`?fields=case_id&fields=case_type`) are supported and treated
equivalently. Values are collected via `QueryDict.getlist()` then split
on commas and flattened.

Commas in field names are not supported.

### Dot-param Syntax for Grouped Fields

To avoid long repetitive paths, sub-fields can be specified with additional
query parameters using dot-separated keys:

```
?fields=case_id,external_id&fields.properties=edd,lmp,age
```

This is equivalent to:

```
?fields=case_id,external_id,properties.edd,properties.lmp,properties.age
```

The dot-param keys (`fields.*`, `exclude.*`) are additive with the base
parameter. `?fields.properties=edd` without a `fields` base param is valid
and means "only include `properties.edd`".

Nesting is arbitrary depth: `fields.indices.parent=case_id,case_type`.

Requesting a whole nested object is supported: `?fields=properties` includes
the entire `properties` dict.

### Examples

Given this case:

```json
{
    "case_id": "abc123",
    "case_type": "pregnant_mother",
    "case_name": "Hermes Adama",
    "properties": {
        "edd": "2013-12-09",
        "age": "22",
        "husband_name": ""
    },
    "indices": {}
}
```

**`?fields=case_id&fields.properties=edd,age`** returns:

```json
{
    "case_id": "abc123",
    "properties": {
        "edd": "2013-12-09",
        "age": "22"
    }
}
```

**`?exclude=case_name&exclude.properties=husband_name`** returns:

```json
{
    "case_id": "abc123",
    "case_type": "pregnant_mother",
    "properties": {
        "edd": "2013-12-09",
        "age": "22"
    },
    "indices": {}
}
```

## Internal Representation: Field Tree

Both `fields` and `exclude` parameters are parsed into a field tree — a
nested dict where:

- A key mapping to `{}` (empty dict) is a leaf: include/exclude the entire
  value at that key.
- A key mapping to a non-empty dict is a branch: descend into the nested
  object and apply the sub-tree.

Example for `?fields=case_id&fields.properties=edd,age`:

```python
{
    "case_id": {},
    "properties": {
        "edd": {},
        "age": {},
    },
}
```

### Limit Fields Algorithm

Walk the data dict, keeping only keys present in the field tree. At each
level, if the tree node is a leaf (`{}`), include the whole value. If it's
a branch, recurse into the nested dict.

### Exclude Fields Algorithm

Walk the data dict. At each level, if a key maps to a leaf in the tree,
drop it. If it maps to a branch, recurse. Keys not in the tree pass through
unchanged.

### Edge Cases

- **Fields that don't exist in the data** — silently ignored.
- **Path expects a dict but value is scalar** — e.g.,
  `fields.properties=edd` but `properties` is `null`. The path is silently
  ignored (no error, no value).
- **Both `fields` and `exclude` specified** — `UserError`.
- **Empty `fields=`** — returns `{}` (explicitly requested zero fields).
- **Empty `exclude=`** — equivalent to not specifying it.

## Interface

```python
def extract_fields_params(params):
    """Read 'fields'/'exclude' params from QueryDict, return filter function.

    Reads but does not pop params from the QueryDict. The params remain
    in the QueryDict so they are preserved in pagination cursors.

    Returns:
        A callable (dict -> dict) that applies field filtering.
        Returns the identity function if neither fields nor exclude
        was specified, so call sites don't need a None check.
    """
```

Usage at the call site:

```python
limit_fields = extract_fields_params(request.GET)
case_json = serialize_case(case)
return JsonResponse(limit_fields(case_json))
```

## Integration Points

The filter function is applied in `corehq/apps/hqcase/views.py` at each
response path:

- **Single case GET** (`_handle_case_get`) — applied to the serialized case
  dict.
- **Comma-separated case IDs GET** (`_handle_case_get` dispatching to
  `_get_bulk_cases`) — applied to each case in the `cases` list.
- **External ID GET** (`_handle_ext_get`) — same as single case GET,
  separate code path. Error responses (e.g. `MultipleObjectsReturned`)
  are not filtered.
- **List GET** (`_handle_list_view`) — applied to each case in the `cases`
  list. Envelope fields (`matching_records`, `next`) are not filtered.
- **Bulk fetch POST** (`_handle_bulk_fetch`) — applied to each case in
  `cases`. Error stubs (missing cases) are not filtered. `fields`/`exclude`
  come from query parameters on the URL, not the JSON request body.
- **Create/Update/Upsert** (`_handle_case_update`) — the response can be
  either `{"form_id": ..., "case": {...}}` (single) or
  `{"form_id": ..., "cases": [...]}` (bulk). The filter is applied to each
  case object. `form_id` is envelope and is not filtered.

### Pagination Cursor Compatibility

The list endpoint's cursor encodes the full QueryDict. Rather than popping
`fields`/`exclude` from the QueryDict (which would lose them in the cursor),
these params are left in place. `_get_filter` in `get_list.py` must be
updated to return `match_all()` for keys starting with `fields` or
`exclude`, following the same pattern already used for `limit`. This way
cursored requests automatically preserve field filtering without any cursor
manipulation.

## Module Location

`corehq/apps/hqcase/api/field_filters.py` — a standalone utility module in
the existing `hqcase/api/` package.

## Testing

### Unit Tests

Tests for the field filter utility (`field_filters.py`):

- `_limit_fields`: top-level fields, nested dot notation, nested dot-params,
  mixed, empty fields returns `{}`, nonexistent fields silently ignored,
  deeply nested paths, whole nested object (`?fields=properties`).
- `_exclude_fields`: same matrix verifying inverse behavior.
- `extract_fields_params`: both specified raises error, empty value handling,
  comma-separated vs repeated params, dot-param tree building.
- Edge cases: path through scalar value, path through null value.

### Integration Tests

- Single case GET with `fields` and `exclude`.
- Comma-separated case IDs GET with `fields`.
- External ID GET with `fields`.
- List GET — filter applies to each case, envelope preserved.
- List GET with pagination — second page preserves field filtering.
- Bulk fetch — filter applies to cases, error stubs untouched.
- Create/update response with field filtering (single and bulk).

## Alternatives Considered

**Parenthetical syntax** (`?fields=case_id,properties(edd,lmp,age)`) was
considered, following Google APIs precedent. Rejected because parentheses
require URL percent-encoding in strict clients, and a recursive descent
parser adds complexity. The dot-param approach achieves the same grouping
without special URL characters or custom parsing. Parenthetical syntax
could be added later as an alternative parser producing the same field tree.

## Documentation

Update the Cases v2 API docs (source: `docs/api/cases-v2.rst`) to document
the new `fields` and `exclude` parameters.
