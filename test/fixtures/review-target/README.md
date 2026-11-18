# Fieldnotes

Fieldnotes is a small, local, dependency-free Node ESM library that lists and
exports *activity entries* for a fictional consulting organisation. Team members
belong to one or more projects; each project has a timeline of entries such as
meeting notes, status changes, and milestone updates.

The dataset in `src/data.js` is fictional example data. No person, email, or
project is real. The library performs no network, filesystem, or clock access —
results are fully deterministic for a given input.

## Layout

```
src/data.js        fictional users, projects, and activity entries
src/errors.js      structured error types (AppError and subclasses)
src/validate.js    input parsing/validation for list queries
src/access.js      project membership enforcement
src/pagination.js  page slicing over an ordered result set
src/export.js      record shaping for data export
src/app.js         listEntries / exportProject entry points
demo.mjs           runnable example: node demo.mjs
docs/              requirements and third-party notes
```

## Usage

```js
import { listEntries, exportProject } from './src/app.js';
import { users } from './src/data.js';

const ana = users.find((u) => u.id === 'u-ana');
listEntries({ user: ana, projectId: 'proj-alpha', page: 1, pageSize: 5 });
exportProject({ user: ana, projectId: 'proj-alpha' });
```

## Requirements

Normative product requirements live in `docs/REQUIREMENTS.md`. Behaviour that
contradicts a `MUST`/`MUST NOT` statement there is a defect, even when the code
"works" in the demo.
