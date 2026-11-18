import { assertProjectAccess } from './access.js';
import { entries } from './data.js';
import { exportEntries } from './export.js';
import { paginate } from './pagination.js';
import { parsePage, parsePageSize, parseStatus } from './validate.js';

export function listEntries({ user, projectId, page = 1, pageSize = 20, status = null }) {
  assertProjectAccess(user, projectId);
  const pageNumber = parsePage(page);
  const size = parsePageSize(pageSize);
  const wanted = parseStatus(status);
  const matching = entries
    .filter((entry) => entry.projectId === projectId)
    .filter((entry) => wanted === null || entry.status === wanted)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return paginate(matching, pageNumber, size);
}

export function exportProject({ user, projectId }) {
  assertProjectAccess(user, projectId);
  return exportEntries(entries.filter((entry) => entry.projectId === projectId));
}
