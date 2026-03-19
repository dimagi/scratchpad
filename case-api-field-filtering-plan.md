# Case API Field Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `fields` and `exclude` query parameters to the Case API v2 so users can limit which fields are returned in case responses.

**Architecture:** A standalone utility module (`field_filters.py`) that parses query parameters into a field tree and returns a callable filter function. The filter is applied as post-processing on serialized case dicts in `views.py`. The params are left in the QueryDict so pagination cursors preserve them, and `_get_filter` in `get_list.py` is updated to skip them.

**Tech Stack:** Python, Django (QueryDict), pytest

**Spec:** `~/scratchpad/case-api-field-filtering-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `corehq/apps/hqcase/api/field_filters.py` | Create | Field tree building, limit/exclude algorithms, `extract_fields_params` |
| `corehq/apps/hqcase/tests/test_field_filters.py` | Create | Unit tests for field filter utility |
| `corehq/apps/hqcase/api/get_list.py` | Modify | Skip `fields`/`exclude` params in `_get_filter` |
| `corehq/apps/hqcase/views.py` | Modify | Wire `extract_fields_params` into all response paths |
| `corehq/apps/hqcase/tests/test_case_list_api.py` | Modify | Integration test: list + pagination preserves field filtering |
| `docs/api/cases-v2.rst` | Modify | Document new parameters |

---

### Task 1: Build field tree from flat field list

Build the internal field tree representation and the `_limit_fields` function.

**Files:**
- Create: `corehq/apps/hqcase/api/field_filters.py`
- Create: `corehq/apps/hqcase/tests/test_field_filters.py`

- [ ] **Step 1: Write failing tests for `_build_field_tree`**

```python
# corehq/apps/hqcase/tests/test_field_filters.py
from django.test import SimpleTestCase

from corehq.apps.hqcase.api.field_filters import _build_field_tree


class TestBuildFieldTree(SimpleTestCase):

    def test_top_level_fields(self):
        self.assertEqual(
            _build_field_tree(["case_id", "case_type"]),
            {"case_id": {}, "case_type": {}},
        )

    def test_dotted_fields(self):
        self.assertEqual(
            _build_field_tree(["properties.edd", "properties.age"]),
            {"properties": {"edd": {}, "age": {}}},
        )

    def test_mixed_top_and_dotted(self):
        self.assertEqual(
            _build_field_tree(["case_id", "properties.edd"]),
            {"case_id": {}, "properties": {"edd": {}}},
        )

    def test_deep_nesting(self):
        self.assertEqual(
            _build_field_tree(["a.b.c.d"]),
            {"a": {"b": {"c": {"d": {}}}}},
        )

    def test_whole_object_and_sub_field(self):
        # If both "properties" and "properties.edd" are specified,
        # the leaf (whole object) wins
        self.assertEqual(
            _build_field_tree(["properties", "properties.edd"]),
            {"properties": {}},
        )

    def test_empty_list(self):
        self.assertEqual(_build_field_tree([]), {})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest corehq/apps/hqcase/tests/test_field_filters.py::TestBuildFieldTree -v`
Expected: ImportError — `_build_field_tree` doesn't exist yet

- [ ] **Step 3: Implement `_build_field_tree`**

```python
# corehq/apps/hqcase/api/field_filters.py


def _build_field_tree(fields):
    """Build a nested dict (field tree) from a list of dot-separated field paths.

    A leaf ({}) means "include/exclude this entire value."
    A branch (non-empty dict) means "descend and apply sub-tree."
    """
    tree = {}
    for field in fields:
        parts = field.split(".")
        node = tree
        for part in parts[:-1]:
            if part in node and node[part] == {}:
                # Already a leaf (whole object selected) — don't override
                break
            node = node.setdefault(part, {})
        else:
            last = parts[-1]
            if last not in node or node[last] != {}:
                # Only set if not already a leaf at a higher level
                if last in node and isinstance(node[last], dict) and node[last]:
                    # Sub-fields already specified, but now the whole object
                    # is requested — leaf wins
                    node[last] = {}
                else:
                    node.setdefault(last, {})
    return tree
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest corehq/apps/hqcase/tests/test_field_filters.py::TestBuildFieldTree -v`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add corehq/apps/hqcase/api/field_filters.py corehq/apps/hqcase/tests/test_field_filters.py
git commit -m "Add _build_field_tree for Case API field filtering"
```

---

### Task 2: Implement `_limit_fields`

The function that filters a data dict to include only specified fields.

**Files:**
- Modify: `corehq/apps/hqcase/api/field_filters.py`
- Modify: `corehq/apps/hqcase/tests/test_field_filters.py`

- [ ] **Step 1: Write failing tests for `_limit_fields`**

```python
from corehq.apps.hqcase.api.field_filters import _limit_fields


SAMPLE_CASE = {
    "case_id": "abc123",
    "case_type": "pregnant_mother",
    "case_name": "Hermes Adama",
    "properties": {
        "edd": "2013-12-09",
        "age": "22",
        "husband_name": "",
    },
    "indices": {},
}


class TestLimitFields(SimpleTestCase):

    def test_top_level_only(self):
        tree = {"case_id": {}, "case_type": {}}
        result = _limit_fields(SAMPLE_CASE, tree)
        self.assertEqual(result, {"case_id": "abc123", "case_type": "pregnant_mother"})

    def test_nested_fields(self):
        tree = {"case_id": {}, "properties": {"edd": {}, "age": {}}}
        result = _limit_fields(SAMPLE_CASE, tree)
        self.assertEqual(result, {
            "case_id": "abc123",
            "properties": {"edd": "2013-12-09", "age": "22"},
        })

    def test_whole_nested_object(self):
        tree = {"properties": {}}
        result = _limit_fields(SAMPLE_CASE, tree)
        self.assertEqual(result, {"properties": SAMPLE_CASE["properties"]})

    def test_nonexistent_fields_ignored(self):
        tree = {"case_id": {}, "nonexistent": {}}
        result = _limit_fields(SAMPLE_CASE, tree)
        self.assertEqual(result, {"case_id": "abc123"})

    def test_empty_tree_returns_empty(self):
        result = _limit_fields(SAMPLE_CASE, {})
        self.assertEqual(result, {})

    def test_nested_path_through_scalar(self):
        tree = {"case_id": {"nested": {}}}
        result = _limit_fields(SAMPLE_CASE, tree)
        self.assertEqual(result, {})

    def test_nested_path_through_none(self):
        data = {"case_id": "abc", "value": None}
        tree = {"value": {"nested": {}}}
        result = _limit_fields(data, tree)
        self.assertEqual(result, {})

    def test_deep_nesting(self):
        data = {"a": {"b": {"c": "deep", "d": "also_deep"}}}
        tree = {"a": {"b": {"c": {}}}}
        result = _limit_fields(data, tree)
        self.assertEqual(result, {"a": {"b": {"c": "deep"}}})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest corehq/apps/hqcase/tests/test_field_filters.py::TestLimitFields -v`
Expected: ImportError

- [ ] **Step 3: Implement `_limit_fields`**

```python
def _limit_fields(data, field_tree):
    """Return a copy of data containing only the fields in field_tree."""
    result = {}
    for key, subtree in field_tree.items():
        if key not in data:
            continue
        if not subtree:
            # Leaf — include the whole value
            result[key] = data[key]
        elif isinstance(data[key], dict):
            # Branch — recurse
            result[key] = _limit_fields(data[key], subtree)
        # else: path expects dict but value is scalar/None — skip
    return result
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest corehq/apps/hqcase/tests/test_field_filters.py::TestLimitFields -v`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add corehq/apps/hqcase/api/field_filters.py corehq/apps/hqcase/tests/test_field_filters.py
git commit -m "Add _limit_fields for Case API field filtering"
```

---

### Task 3: Implement `_exclude_fields`

The inverse function that removes specified fields from a data dict.

**Files:**
- Modify: `corehq/apps/hqcase/api/field_filters.py`
- Modify: `corehq/apps/hqcase/tests/test_field_filters.py`

- [ ] **Step 1: Write failing tests for `_exclude_fields`**

```python
from corehq.apps.hqcase.api.field_filters import _exclude_fields


class TestExcludeFields(SimpleTestCase):

    def test_top_level_exclusion(self):
        tree = {"case_name": {}}
        result = _exclude_fields(SAMPLE_CASE, tree)
        expected = {k: v for k, v in SAMPLE_CASE.items() if k != "case_name"}
        self.assertEqual(result, expected)

    def test_nested_exclusion(self):
        tree = {"properties": {"husband_name": {}}}
        result = _exclude_fields(SAMPLE_CASE, tree)
        self.assertEqual(result["properties"], {"edd": "2013-12-09", "age": "22"})
        # Other top-level keys unchanged
        self.assertEqual(result["case_id"], "abc123")

    def test_exclude_whole_nested_object(self):
        tree = {"properties": {}}
        result = _exclude_fields(SAMPLE_CASE, tree)
        self.assertNotIn("properties", result)
        self.assertEqual(result["case_id"], "abc123")

    def test_nonexistent_fields_ignored(self):
        tree = {"nonexistent": {}}
        result = _exclude_fields(SAMPLE_CASE, tree)
        self.assertEqual(result, SAMPLE_CASE)

    def test_empty_tree_returns_all(self):
        result = _exclude_fields(SAMPLE_CASE, {})
        self.assertEqual(result, SAMPLE_CASE)

    def test_nested_path_through_scalar(self):
        tree = {"case_id": {"nested": {}}}
        result = _exclude_fields(SAMPLE_CASE, tree)
        # case_id is scalar, can't descend — left unchanged
        self.assertEqual(result, SAMPLE_CASE)

    def test_deep_nesting(self):
        data = {"a": {"b": {"c": "deep", "d": "also_deep"}}}
        tree = {"a": {"b": {"c": {}}}}
        result = _exclude_fields(data, tree)
        self.assertEqual(result, {"a": {"b": {"d": "also_deep"}}})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest corehq/apps/hqcase/tests/test_field_filters.py::TestExcludeFields -v`
Expected: ImportError

- [ ] **Step 3: Implement `_exclude_fields`**

```python
def _exclude_fields(data, field_tree):
    """Return a copy of data with the fields in field_tree removed."""
    result = {}
    for key, value in data.items():
        if key not in field_tree:
            result[key] = value
        elif field_tree[key]:
            # Branch — recurse if value is a dict
            if isinstance(value, dict):
                result[key] = _exclude_fields(value, field_tree[key])
            else:
                # Path expects dict but value is scalar — leave unchanged
                result[key] = value
        # else: leaf — exclude this key entirely
    return result
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest corehq/apps/hqcase/tests/test_field_filters.py::TestExcludeFields -v`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add corehq/apps/hqcase/api/field_filters.py corehq/apps/hqcase/tests/test_field_filters.py
git commit -m "Add _exclude_fields for Case API field filtering"
```

---

### Task 4: Implement `extract_fields_params`

Parse `fields`/`exclude` and their dot-param variants from a QueryDict, return a filter callable.

**Files:**
- Modify: `corehq/apps/hqcase/api/field_filters.py`
- Modify: `corehq/apps/hqcase/tests/test_field_filters.py`

- [ ] **Step 1: Write failing tests for `extract_fields_params`**

```python
from django.http import QueryDict

from corehq.apps.hqcase.api.core import UserError
from corehq.apps.hqcase.api.field_filters import extract_fields_params


class TestExtractFieldsParams(SimpleTestCase):

    def test_no_params_returns_identity(self):
        params = QueryDict("")
        fn = extract_fields_params(params)
        data = {"case_id": "abc", "case_type": "foo"}
        self.assertEqual(fn(data), data)

    def test_fields_basic(self):
        params = QueryDict("fields=case_id,case_type")
        fn = extract_fields_params(params)
        result = fn(SAMPLE_CASE)
        self.assertEqual(result, {"case_id": "abc123", "case_type": "pregnant_mother"})

    def test_exclude_basic(self):
        params = QueryDict("exclude=case_name")
        fn = extract_fields_params(params)
        result = fn(SAMPLE_CASE)
        self.assertNotIn("case_name", result)
        self.assertIn("case_id", result)

    def test_both_raises_error(self):
        params = QueryDict("fields=case_id&exclude=case_name")
        with self.assertRaises(UserError):
            extract_fields_params(params)

    def test_dot_param_fields(self):
        params = QueryDict("fields=case_id&fields.properties=edd,age")
        fn = extract_fields_params(params)
        result = fn(SAMPLE_CASE)
        self.assertEqual(result, {
            "case_id": "abc123",
            "properties": {"edd": "2013-12-09", "age": "22"},
        })

    def test_dot_param_without_base(self):
        params = QueryDict("fields.properties=edd")
        fn = extract_fields_params(params)
        result = fn(SAMPLE_CASE)
        self.assertEqual(result, {"properties": {"edd": "2013-12-09"}})

    def test_repeated_params(self):
        params = QueryDict("fields=case_id&fields=case_type")
        fn = extract_fields_params(params)
        result = fn(SAMPLE_CASE)
        self.assertEqual(result, {"case_id": "abc123", "case_type": "pregnant_mother"})

    def test_empty_fields_returns_empty(self):
        params = QueryDict("fields=")
        fn = extract_fields_params(params)
        result = fn(SAMPLE_CASE)
        self.assertEqual(result, {})

    def test_empty_exclude_returns_all(self):
        params = QueryDict("exclude=")
        fn = extract_fields_params(params)
        result = fn(SAMPLE_CASE)
        self.assertEqual(result, SAMPLE_CASE)

    def test_dot_param_exclude(self):
        params = QueryDict("exclude=case_name&exclude.properties=husband_name")
        fn = extract_fields_params(params)
        result = fn(SAMPLE_CASE)
        self.assertNotIn("case_name", result)
        self.assertNotIn("husband_name", result["properties"])
        self.assertIn("edd", result["properties"])

    def test_deep_dot_param(self):
        params = QueryDict("fields.a.b=c")
        data = {"a": {"b": {"c": "deep", "d": "other"}}, "x": "y"}
        fn = extract_fields_params(params)
        result = fn(data)
        self.assertEqual(result, {"a": {"b": {"c": "deep"}}})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest corehq/apps/hqcase/tests/test_field_filters.py::TestExtractFieldsParams -v`
Expected: ImportError

- [ ] **Step 3: Implement `extract_fields_params`**

```python
from corehq.apps.hqcase.api.core import UserError

FIELDS_PARAM = 'fields'
EXCLUDE_PARAM = 'exclude'


def extract_fields_params(params):
    """Read 'fields'/'exclude' params from QueryDict, return filter function.

    Reads but does not pop params from the QueryDict. The params remain
    in the QueryDict so they are preserved in pagination cursors.

    Returns a callable (dict -> dict) that applies field filtering.
    Returns the identity function if neither fields nor exclude was specified.
    """
    has_fields, fields_spec = _collect_field_spec(params, FIELDS_PARAM)
    has_exclude, exclude_spec = _collect_field_spec(params, EXCLUDE_PARAM)

    if has_fields and has_exclude:
        raise UserError("You cannot specify both 'fields' and 'exclude'")

    if has_fields:
        tree = _build_field_tree(fields_spec)
        return lambda data: _limit_fields(data, tree)
    if has_exclude:
        tree = _build_field_tree(exclude_spec)
        return lambda data: _exclude_fields(data, tree)
    return _identity


def _identity(data):
    return data


def _collect_field_spec(params, prefix):
    """Collect field paths from a QueryDict for the given prefix.

    Reads 'prefix' and all 'prefix.*' keys. Values are comma-separated.
    Returns (key_present, fields) where key_present is True if any
    matching keys exist in the QueryDict (even if values are empty).
    """
    fields = []
    key_present = False
    for key in list(params.keys()):
        if key == prefix:
            key_present = True
            for value in params.getlist(key):
                fields.extend(part.strip() for part in value.split(",") if part.strip())
        elif key.startswith(prefix + "."):
            key_present = True
            nesting = key[len(prefix) + 1:]  # e.g. "properties" from "fields.properties"
            for value in params.getlist(key):
                for part in value.split(","):
                    part = part.strip()
                    if part:
                        fields.append(f"{nesting}.{part}")
    return key_present, fields
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest corehq/apps/hqcase/tests/test_field_filters.py::TestExtractFieldsParams -v`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add corehq/apps/hqcase/api/field_filters.py corehq/apps/hqcase/tests/test_field_filters.py
git commit -m "Add extract_fields_params for Case API field filtering"
```

---

### Task 5: Update `_get_filter` to skip field filtering params

Make `_get_filter` in `get_list.py` return `match_all()` for `fields`, `exclude`, and their dot-param variants so they don't raise `UserError`.

**Files:**
- Modify: `corehq/apps/hqcase/api/get_list.py:143-156`
- Modify: `corehq/apps/hqcase/tests/test_case_list_api.py`

- [ ] **Step 1: Write failing test**

Add to the `test_case_list_queries` generated cases in `test_case_list_api.py`:

```python
# Add these entries to the @generate_cases list for test_case_list_queries:
("case_type=person&fields=case_id,case_type", ['mattie', 'rooster', 'laboeuf', 'chaney', 'ned']),
("case_type=person&fields.properties=alias", ['mattie', 'rooster', 'laboeuf', 'chaney', 'ned']),
("case_type=person&exclude=properties", ['mattie', 'rooster', 'laboeuf', 'chaney', 'ned']),
```

And add to the `test_bad_requests` generated cases to verify that *other* invalid params are still rejected:

```python
# This should still fail — the skip only applies to fields/exclude
("not_fields=blah", "'not_fields' is not a valid parameter."),
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest corehq/apps/hqcase/tests/test_case_list_api.py -v -k "fields or exclude or not_fields"`
Expected: The `fields`/`exclude` tests fail with `UserError("'fields' is not a valid parameter.")`

- [ ] **Step 3: Update `_get_filter`**

In `corehq/apps/hqcase/api/get_list.py`, modify `_get_filter` (line 143) to add a check before the `else` clause:

```python
def _get_filter(domain, key, val):
    if key == 'limit':
        return filters.match_all()
    elif _is_field_filter_param(key):
        return filters.match_all()
    elif key == 'query':
        return _get_query_filter(domain, val)
    elif key in SIMPLE_FILTERS:
        if key == INCLUDE_DEPRECATED:
            return SIMPLE_FILTERS[key](domain, val)
        return SIMPLE_FILTERS[key](val)
    elif '.' in key and key.split(".")[0] in COMPOUND_FILTERS:
        prefix, qualifier = key.split(".", maxsplit=1)
        return COMPOUND_FILTERS[prefix](qualifier, val)
    else:
        raise UserError(f"'{key}' is not a valid parameter.")


def _is_field_filter_param(key):
    return key in ('fields', 'exclude') or key.startswith(('fields.', 'exclude.'))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest corehq/apps/hqcase/tests/test_case_list_api.py -v`
Expected: All PASS (including existing tests)

- [ ] **Step 5: Commit**

```bash
git add corehq/apps/hqcase/api/get_list.py corehq/apps/hqcase/tests/test_case_list_api.py
git commit -m "Skip fields/exclude params in get_list query builder"
```

---

### Task 6: Wire field filtering into views.py

Integrate `extract_fields_params` into all response paths in `views.py`.

**Files:**
- Modify: `corehq/apps/hqcase/views.py`

- [ ] **Step 1: Add import**

At the top of `views.py`, add:

```python
from .api.field_filters import extract_fields_params
```

- [ ] **Step 2: Wire into `_get_single_case`**

Change `_get_single_case` (line 138) to accept and apply the filter:

```python
def _get_single_case(request, case_id):
    try:
        case = case_search_adapter.get(case_id)
        if case['domain'] != request.domain:
            raise NotFoundError()
        if not user_can_access_case(request.domain, request.couch_user, case, es_case=True):
            raise PermissionDenied()
    except NotFoundError:
        return JsonResponse({'error': f"Case '{case_id}' not found"}, status=404)
    except PermissionDenied:
        return JsonResponse({'error': f"Insufficent permission for Case '{case_id}'"}, status=403)
    filter_fields = extract_fields_params(request.GET)
    return JsonResponse(filter_fields(serialize_es_case(case)))
```

- [ ] **Step 3: Wire into `_get_bulk_cases`**

Change `_get_bulk_cases` (line 129) to apply the filter, skipping error stubs:

```python
def _get_bulk_cases(request, case_ids=None, external_ids=None):
    try:
        res = get_bulk(request.domain, request.couch_user, case_ids, external_ids)
    except UserError as e:
        return JsonResponse({'error': str(e)}, status=400)

    filter_fields = extract_fields_params(request.GET)
    res['cases'] = [
        filter_fields(case) if 'error' not in case else case
        for case in res['cases']
    ]
    return JsonResponse(res)
```

- [ ] **Step 4: Wire into `_handle_ext_get`**

Change the success return in `_handle_ext_get` (line 187):

```python
    filter_fields = extract_fields_params(request.GET)
    return JsonResponse(filter_fields(serialize_case(case)))
```

- [ ] **Step 5: Wire into `_handle_list_view`**

Change `_handle_list_view` (line 204):

```python
def _handle_list_view(request):
    try:
        res = get_list(request.domain, request.couch_user, request.GET)
    except UserError as e:
        return JsonResponse({'error': str(e)}, status=400)

    filter_fields = extract_fields_params(request.GET)
    res['cases'] = [filter_fields(case) for case in res['cases']]

    if 'next' in res:
        res['next'] = reverse('case_api', args=[request.domain], params=res['next'], absolute=True)
    return JsonResponse(res)
```

- [ ] **Step 6: Wire into `_handle_case_update`**

Change `_handle_case_update` (line 272):

```python
def _handle_case_update(request, data, is_creation):
    try:
        xform, case_or_cases = handle_case_update(
            domain=request.domain,
            data=data,
            user=request.couch_user,
            device_id=request.META.get('HTTP_USER_AGENT'),
            is_creation=is_creation,
        )
    except PermissionDenied as e:
        return JsonResponse({'error': str(e)}, status=403)
    except UserError as e:
        return JsonResponse({'error': str(e)}, status=400)
    except SubmissionError as e:
        return JsonResponse({
            'error': str(e),
            'form_id': e.form_id,
        }, status=400)

    filter_fields = extract_fields_params(request.GET)
    if isinstance(case_or_cases, list):
        return JsonResponse({
            'form_id': xform.form_id,
            'cases': [filter_fields(serialize_case(case)) for case in case_or_cases],
        })
    return JsonResponse({
        'form_id': xform.form_id,
        'case': filter_fields(serialize_case(case_or_cases)),
    })
```

- [ ] **Step 7: Run existing tests to verify nothing breaks**

Run: `pytest corehq/apps/hqcase/tests/ -v`
Expected: All existing tests PASS

- [ ] **Step 8: Commit**

```bash
git add corehq/apps/hqcase/views.py
git commit -m "Wire field filtering into Case API response paths"
```

---

### Task 7: Integration tests

Add integration tests covering the field filtering pipeline end-to-end.
Note: `get_list` returns unfiltered dicts — field filtering is applied in
`views.py`. These tests verify cursor preservation (in `test_case_list_api.py`)
and the full filter pipeline (in `test_field_filters.py`).

**Files:**
- Modify: `corehq/apps/hqcase/tests/test_case_list_api.py`
- Modify: `corehq/apps/hqcase/tests/test_field_filters.py`

- [ ] **Step 1: Test cursor preserves fields/exclude params**

Add to `TestCaseListAPI` in `test_case_list_api.py`:

```python
def test_fields_preserved_in_cursor(self):
    params = QueryDict("case_type=person&limit=2&fields=case_id,external_id")
    res = get_list(self.domain, self.couch_user, params)
    cursor = b64decode(res['next']['cursor']).decode('utf-8')
    self.assertIn('fields=', cursor)

def test_dot_param_fields_preserved_in_cursor(self):
    params = QueryDict("case_type=person&limit=2&fields=case_id&fields.properties=alias")
    res = get_list(self.domain, self.couch_user, params)
    cursor = b64decode(res['next']['cursor']).decode('utf-8')
    self.assertIn('fields=case_id', cursor)
    self.assertIn('fields.properties=alias', cursor)
```

- [ ] **Step 2: Test the full filter pipeline via `extract_fields_params`**

Add to `test_field_filters.py`, a class that exercises `extract_fields_params`
applied to realistic case data, simulating how `views.py` uses it:

```python
class TestFieldFilterPipeline(SimpleTestCase):
    """Integration-style tests: extract params then apply to case dicts."""

    CASE = {
        "case_id": "abc123",
        "case_type": "person",
        "case_name": "Test",
        "properties": {"edd": "2013-12-09", "age": "22", "secret": "hidden"},
        "indices": {"parent": {"case_id": "def456", "case_type": "household"}},
    }

    def test_fields_on_case_list_envelope(self):
        """Envelope fields are not filtered — only case dicts are."""
        params = QueryDict("fields=case_id")
        filter_fn = extract_fields_params(params)
        envelope = {
            "matching_records": 5,
            "cases": [self.CASE],
            "next": {"cursor": "abc"},
        }
        # Apply filter to each case (as views.py does), not the envelope
        filtered_cases = [filter_fn(c) for c in envelope["cases"]]
        self.assertEqual(filtered_cases, [{"case_id": "abc123"}])
        # Envelope keys untouched
        self.assertIn("matching_records", envelope)
        self.assertIn("next", envelope)

    def test_bulk_error_stubs_not_filtered(self):
        """Error stubs should pass through unfiltered."""
        params = QueryDict("fields=case_id")
        filter_fn = extract_fields_params(params)
        cases = [
            self.CASE,
            {"case_id": "missing1", "error": "not found"},
        ]
        filtered = [
            filter_fn(c) if "error" not in c else c
            for c in cases
        ]
        self.assertEqual(filtered[0], {"case_id": "abc123"})
        self.assertEqual(filtered[1], {"case_id": "missing1", "error": "not found"})

    def test_fields_on_update_response(self):
        """Update response: form_id is envelope, case is filtered."""
        params = QueryDict("fields=case_id,case_type")
        filter_fn = extract_fields_params(params)
        response = {
            "form_id": "form-xyz",
            "case": filter_fn(self.CASE),
        }
        self.assertEqual(response["form_id"], "form-xyz")
        self.assertEqual(response["case"], {"case_id": "abc123", "case_type": "person"})

    def test_exclude_nested_fields(self):
        params = QueryDict("exclude.properties=secret")
        filter_fn = extract_fields_params(params)
        result = filter_fn(self.CASE)
        self.assertNotIn("secret", result["properties"])
        self.assertIn("edd", result["properties"])
        # Top-level fields unchanged
        self.assertIn("case_id", result)
        self.assertIn("indices", result)
```

- [ ] **Step 3: Run tests**

Run: `pytest corehq/apps/hqcase/tests/test_field_filters.py::TestFieldFilterPipeline corehq/apps/hqcase/tests/test_case_list_api.py -v -k "cursor or Pipeline"`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add corehq/apps/hqcase/tests/test_field_filters.py corehq/apps/hqcase/tests/test_case_list_api.py
git commit -m "Add integration tests for field filtering pipeline"
```

---

### Task 8: Update API documentation

Document the new `fields` and `exclude` parameters in the API docs.

**Files:**
- Modify: `docs/api/cases-v2.rst`

- [ ] **Step 1: Read current docs structure**

Read `docs/api/cases-v2.rst` to find the right section for documenting query parameters.

- [ ] **Step 2: Add documentation for fields/exclude**

Add a new section after the existing query parameters documentation:

```rst
Limiting Response Fields
~~~~~~~~~~~~~~~~~~~~~~~~

Two optional, mutually exclusive query parameters allow you to control which
fields appear in the response:

``fields``
    A comma-separated list of field names to include. Only specified fields
    will appear in the response. Use dot notation for nested fields.

``exclude``
    A comma-separated list of field names to remove from the response. Use
    dot notation for nested fields.

Using both ``fields`` and ``exclude`` in the same request will return an
error.

**Dot-param syntax** for grouping sub-fields under a parent:

.. code-block:: text

    ?fields=case_id,external_id&fields.properties=edd,lmp,age

This is equivalent to:

.. code-block:: text

    ?fields=case_id,external_id,properties.edd,properties.lmp,properties.age

Examples
^^^^^^^^

Include only specific fields:

.. code-block:: text

    GET /a/<domain>/api/case/v2/?case_type=patient&fields=case_id&fields.properties=edd,age

.. code-block:: json

    {
        "matching_records": 1,
        "cases": [
            {
                "case_id": "abc123",
                "properties": {
                    "edd": "2013-12-09",
                    "age": "22"
                }
            }
        ]
    }

Exclude specific fields:

.. code-block:: text

    GET /a/<domain>/api/case/v2/<case_id>?exclude=case_name&exclude.properties=husband_name

These parameters work on all GET endpoints and on the case object returned
by POST/PUT (create/update) endpoints. For list and bulk responses, the
filtering applies to each individual case object; envelope fields
(``matching_records``, ``next``) are not affected.

Field filtering is preserved across paginated requests.
```

- [ ] **Step 3: Commit**

```bash
git add docs/api/cases-v2.rst
git commit -m "Document fields/exclude parameters in Case API v2 docs"
```

---

### Task 9: Lint and final verification

- [ ] **Step 1: Run linter on changed files**

```bash
ruff check corehq/apps/hqcase/api/field_filters.py corehq/apps/hqcase/views.py corehq/apps/hqcase/api/get_list.py corehq/apps/hqcase/tests/test_field_filters.py corehq/apps/hqcase/tests/test_case_list_api.py
```

- [ ] **Step 2: Run formatter on new files**

```bash
ruff check --select I --fix corehq/apps/hqcase/api/field_filters.py corehq/apps/hqcase/tests/test_field_filters.py
ruff format corehq/apps/hqcase/api/field_filters.py corehq/apps/hqcase/tests/test_field_filters.py
```

- [ ] **Step 3: Run full test suite for hqcase**

```bash
pytest corehq/apps/hqcase/tests/ -v
```

- [ ] **Step 4: Commit any lint fixes**

```bash
git add -u
git commit -m "Fix lint issues in field filtering code"
```
