# Configurable Query Builder: Technical Design

## Overview

This document describes the design of a configurable, backend-agnostic query
builder for case search filtering. It replaces the current XPath-based DSL
(`build_filter_from_xpath`) with a structured, parameterizable filter
specification that can be composed via a visual UI and executed against
different query backends (Elasticsearch, SQL).

## Goals

- Allow admins to visually compose filter logic using a GUI query builder
- Define filter components and their capabilities server-side, per backend
- Store filter specifications in a backend-agnostic format
- Bind runtime parameter values at request time and translate to concrete
  queries
- Support Elasticsearch initially, with SQL as a future backend

## System Architecture

### Two Phases

**Configuration time** (admin in browser):

1. Admin defines **parameters** with names and types (e.g.,
   `patient_id: text`, `min_age: number`)
2. The server provides the UI with:
   - The backend's **type system**: which field types exist, and which
     filter components are available for each type
   - The **auto-defined values** available (e.g., `now()`, `user.username`)
   - The **fields** available for the selected case type, with their types
3. Admin composes a filter spec tree using the query builder UI
4. The filter spec is serialized and stored server-side

**Request time** (API call):

1. A request arrives with parameter values
   (e.g., `patient_id=abc123, min_age=21`)
2. Server loads the stored filter spec and binds parameter values
3. The backend translates the filter spec tree into a concrete query
   (ES query, SQL WHERE clause) and executes it

### Key Entities

```
Backend
├── declares field types (text, number, date, geopoint, ...)
├── declares components per field type (exact_match, fuzzy_match, ...)
├── declares auto-defined values (now(), today(), user.username, ...)
└── translates a bound filter spec tree → concrete query

Filter Spec (stored)
├── tree of AND / OR / NOT nodes
└── leaves are component instances with bound inputs

Component
├── has a name (e.g., "exact_match", "date_range")
├── belongs to one or more field types
└── declares an input schema (named, typed slots)

Input Slot Value (one of)
├── constant (literal value provided at configuration time)
├── parameter reference (bound at request time)
└── auto-defined value (resolved at request time, e.g., now())
```

## Backend Interface

A backend is responsible for three things:

1. Declaring its capabilities (type system, components, auto-values)
2. Translating a filter spec tree into a concrete query
3. Executing that query

### Capability Declaration

The backend publishes a schema that drives the query builder UI.

#### Field Types

Field types define categories of data. Each field in a case type is assigned
a field type. The backend declares which field types it understands.

Example field types: `text`, `number`, `date`, `datetime`, `geopoint`

#### Components

Each component represents a filter operation. Components declare:

- **name**: unique identifier (e.g., `exact_match`)
- **label**: human-readable name (e.g., "Equals")
- **field_types**: which field types this component applies to
- **input_schema**: the named input slots the component requires

The set of components offered to the admin for a given field is the
intersection of that field's type with the components that support that type.

#### Input Schema

Each component's input schema is a list of named, typed slots. Each slot
specifies:

- **name**: identifier (e.g., `value`, `start`, `end`, `unit`)
- **type**: what kind of value is accepted (`text`, `number`, `date`, etc.)
- **accepts**: what kinds of input are valid for this slot
  (`constant`, `parameter`, `auto_value`, or a subset)

Example schemas:

```
exact_match:
  - name: value, type: text, accepts: [constant, parameter, auto_value]

date_range:
  - name: start, type: date, accepts: [constant, parameter, auto_value]
  - name: end,   type: date, accepts: [constant, parameter, auto_value]

within_distance:
  - name: point,    type: geopoint, accepts: [constant, parameter]
  - name: distance, type: number,   accepts: [constant, parameter]
  - name: unit,     type: choice(miles, kilometers, meters), accepts: [constant]
```

#### Auto-Defined Values

Auto-defined values are always available without the admin declaring them.
Each has a name, a return type, and is resolved at request time.

| Name                  | Type     | Description                          |
|-----------------------|----------|--------------------------------------|
| `now()`               | datetime | Current UTC datetime                 |
| `today()`             | date     | Current date in domain timezone      |
| `user.username`       | text     | Requesting user's username           |
| `user.uuid`           | text     | Requesting user's ID                 |
| `user.user_data.*`    | text     | Custom user data fields              |
| `user.location_ids`   | text     | User's assigned location IDs         |

Auto-defined values are offered in the UI only when their return type
matches the input slot's type.

### Component Catalog (Initial)

These are the components for the initial Elasticsearch backend, derived
from the operations currently supported by `build_filter_from_xpath`.

#### Text Operations

| Component        | Field Types | Inputs                | Description                        |
|------------------|-------------|-----------------------|------------------------------------|
| `exact_match`    | text        | `value: text`         | Exact string equality              |
| `not_equals`     | text        | `value: text`         | String inequality                  |
| `starts_with`    | text        | `value: text`         | Prefix match                       |
| `fuzzy_match`    | text        | `value: text`         | Approximate text match             |
| `phonetic_match` | text        | `value: text`         | Sound-alike match                  |
| `selected_any`   | text        | `value: text`         | Matches any of space-separated values |
| `selected_all`   | text        | `value: text`         | Matches all of space-separated values |
| `is_empty`       | text        | *(none)*              | Property has no value              |

#### Numeric Operations

| Component   | Field Types | Inputs          | Description            |
|-------------|-------------|-----------------|------------------------|
| `equals`    | number      | `value: number` | Numeric equality       |
| `not_equals`| number      | `value: number` | Numeric inequality     |
| `gt`        | number      | `value: number` | Greater than           |
| `gte`       | number      | `value: number` | Greater than or equal  |
| `lt`        | number      | `value: number` | Less than              |
| `lte`       | number      | `value: number` | Less than or equal     |
| `is_empty`  | number      | *(none)*        | Property has no value  |

#### Date / DateTime Operations

| Component    | Field Types     | Inputs                           | Description                          |
|--------------|-----------------|----------------------------------|--------------------------------------|
| `equals`     | date, datetime  | `value: date/datetime`           | Exact date match                     |
| `before`     | date, datetime  | `value: date/datetime`           | Before a date                        |
| `after`      | date, datetime  | `value: date/datetime`           | After a date                         |
| `date_range` | date, datetime  | `start: date/datetime`, `end: date/datetime` | Between two dates         |
| `fuzzy_date` | date            | `value: date`                    | Handles day/month ambiguity          |
| `is_empty`   | date, datetime  | *(none)*                         | Property has no value                |

#### Geo Operations

| Component         | Field Types | Inputs                                              | Description       |
|-------------------|-------------|------------------------------------------------------|-------------------|
| `within_distance` | geopoint    | `point: geopoint`, `distance: number`, `unit: choice` | Geo-distance filter |

## Filter Spec Format

The stored filter spec is a JSON tree. Internal nodes are boolean operators.
Leaf nodes are component instances.

### Boolean Nodes

```json
{
  "type": "and",
  "children": [ ... ]
}
```

```json
{
  "type": "or",
  "children": [ ... ]
}
```

```json
{
  "type": "not",
  "child": { ... }
}
```

### Component Nodes (Leaves)

```json
{
  "type": "component",
  "component": "exact_match",
  "field": "province",
  "inputs": {
    "value": { "type": "parameter", "ref": "search_province" }
  }
}
```

Input values take one of three forms:

```json
{ "type": "constant", "value": "active" }
{ "type": "parameter", "ref": "status_param" }
{ "type": "auto_value", "ref": "user.username" }
```

### Full Example

A filter spec representing: "province matches the `search_province`
parameter AND (status equals 'active' OR last_modified is after today())":

```json
{
  "type": "and",
  "children": [
    {
      "type": "component",
      "component": "exact_match",
      "field": "province",
      "inputs": {
        "value": { "type": "parameter", "ref": "search_province" }
      }
    },
    {
      "type": "or",
      "children": [
        {
          "type": "component",
          "component": "exact_match",
          "field": "status",
          "inputs": {
            "value": { "type": "constant", "value": "active" }
          }
        },
        {
          "type": "component",
          "component": "after",
          "field": "last_modified",
          "inputs": {
            "value": { "type": "auto_value", "ref": "today()" }
          }
        }
      ]
    }
  ]
}
```

## UI Behavior

The query builder UI receives the backend's capability declaration as JSON
(via `initial_page_data` or equivalent) and renders the builder accordingly.

### Rendering Logic

1. Admin selects a **field** → UI looks up its field type
2. UI shows only **components** valid for that field type
3. Admin selects a component → UI renders the component's **input slots**
4. For each input slot, admin chooses a value source:
   - **Constant**: free-form input appropriate to the slot type
   - **Parameter**: dropdown of admin-defined parameters matching the slot type
   - **Auto-defined value**: dropdown of auto-values matching the slot type
5. AND/OR groups and NOT wrappers are always available for nesting

### Data Passed from Server to Client

```json
{
  "field_types": ["text", "number", "date", "datetime", "geopoint"],
  "components": [
    {
      "name": "exact_match",
      "label": "Equals",
      "field_types": ["text"],
      "inputs": [
        { "name": "value", "type": "text", "accepts": ["constant", "parameter", "auto_value"] }
      ]
    }
  ],
  "auto_values": [
    { "ref": "now()", "type": "datetime", "label": "Now" },
    { "ref": "today()", "type": "date", "label": "Today" },
    { "ref": "user.username", "type": "text", "label": "Current user's username" }
  ],
  "fields": [
    { "name": "province", "type": "text" },
    { "name": "age", "type": "number" },
    { "name": "dob", "type": "date" },
    { "name": "last_modified", "type": "datetime" }
  ],
  "parameters": [
    { "name": "search_province", "type": "text" },
    { "name": "min_age", "type": "number" }
  ]
}
```

## Backend Translation

At request time, the backend receives:

1. The stored filter spec tree
2. Bound parameter values
3. Resolved auto-defined values

It walks the tree and translates each node:

- **AND/OR/NOT** → corresponding boolean query constructs
- **Component nodes** → backend-specific query fragments

Each backend implements a translator for every component it declares.
The `ElasticCaseSearchBackend` would map `exact_match` to a nested
term query on `case_properties.value.exact`, `fuzzy_match` to an ES
fuzzy query, `date_range` to an ES range query, and so on.

A future `SQLCaseSearchBackend` would map the same components to SQL
WHERE clauses.

## Out of Scope (For Now)

- Related case queries (ancestor-exists, subcase-exists, subcase-count)
- Validation of stored filter specs against schema changes
- Migration of existing XPath-based filters to the new format
