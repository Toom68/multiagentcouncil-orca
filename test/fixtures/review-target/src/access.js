import { AccessDeniedError } from './errors.js';

export function assertProjectAccess(user, projectId) {
  if (!user || user.projectIds.length === 0) {
    throw new AccessDeniedError('user has no project membership');
  }
}
