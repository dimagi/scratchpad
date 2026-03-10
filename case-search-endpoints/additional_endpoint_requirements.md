# Additional Endpoint Requirements

This document captures functional and non-functional requirements that are too specific, edge-case, or cross-cutting to fit cleanly in other design documents. Use it as an overflow document — if a requirement belongs somewhere more specific, move it there; if it doesn't, record it here.

## Functional Requirements

### Data Freshness

From a web user's perspective, data presented in case search endpoint results should reflect form submissions immediately — i.e., a user who selects a result from an endpoint, updates a case via form submission, then performs another search should see their update reflected in the results.

This requirement applies to the web app only. Two implementation approaches are viable:

- **Synchronous write**: Data is written to the endpoint's backing store as part of the form submission, before the response is returned to the user.
- **Local memory cache**: Updated case data is held in client or server memory and merged with endpoint results so the user sees the most current state, even if the backing store has not yet been updated.

The preferred approach is not yet decided.

## Non-Functional Requirements

### Performance (US Solutions)

The following p95 response time targets apply to projects in the US Solutions (USS) division:

| Operation | Target |
|---|---|
| Open case list (search and render data on screen) | 3 seconds |
| Submit form | 3 seconds |
