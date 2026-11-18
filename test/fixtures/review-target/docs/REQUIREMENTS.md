# Fieldnotes requirements

Normative requirements for the Fieldnotes library. `MUST`/`MUST NOT` are
binding; `SHOULD` is preferred. Each requirement has a stable id for citation.

## Functional

### FR-1 Listing

`listEntries({ user, projectId, page, pageSize, status })` returns the caller's
page of activity entries for one project, ordered by `createdAt` ascending with
`id` ascending as tie-breaker.

### FR-2 Pagination

Pages are **1-indexed**. Page 1 MUST contain the first `pageSize` matching
entries in the order defined by FR-1. Pagination MUST partition the matching
set: every matching entry appears in exactly one page. `page` MUST be an
integer `>= 1`; other values MUST be rejected with a `ValidationError` whose
`code` is `invalid_page`.

### FR-3 Project access

A user MUST only be able to list or export entries for projects whose id
appears in `user.projectIds`. A request naming any other project MUST fail
with an `AccessDeniedError` (`code` `access_denied`) and MUST NOT return entry
data. Membership in an unrelated project MUST NOT grant access.

### FR-4 `pageSize` validation

`pageSize` MUST be an integer between 1 and 50 inclusive. Any other value —
including non-integers, 0, negatives, and values above 50 — MUST be rejected
with a `ValidationError` (`code` `invalid_page_size`). The library MUST NOT
silently clamp, round, or default an out-of-range value.

### FR-5 `status` filter

When provided, `status` MUST be one of `open`, `in-progress`, `closed`; any
other value MUST be rejected with a `ValidationError` (`code` `invalid_status`).
When omitted, all statuses match.

### FR-6 Export privacy

`exportProject` MUST emit records containing only `id`, `projectId`, `title`,
`status`, `createdAt`. The internal-only fields `authorEmail` and
`internalNote` MUST NOT appear anywhere in exported output; exports may be
shared outside the member's organisation.

### FR-7 Structured errors

All caller-facing failures MUST be `AppError` subclasses carrying a machine-
readable `code`. A failure MUST surface as a thrown error, never as silent
fallback data (empty pages, substituted defaults, partial records).

## Non-functional

### NFR-1 Determinism

Identical inputs MUST produce identical outputs. No wall-clock, randomness,
network, environment, or filesystem access is permitted inside `src/`.

### NFR-2 Dependencies

No third-party dependencies. Pure ESM on Node >= 18.

### NFR-3 Immutability

The library MUST NOT mutate the dataset or inputs; returned structures MUST be
fresh objects, not references into `src/data.js` internals.

## Out of scope

Authentication, persistence, writing entries, HTTP serving, i18n, and any
real-user data. This repository is a review fixture; all data is fictional.
