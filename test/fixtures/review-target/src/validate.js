import { ValidationError } from './errors.js';

export const PAGE_SIZE_MIN = 1;
export const PAGE_SIZE_MAX = 50;
export const STATUSES = ['open', 'in-progress', 'closed'];

export function parsePage(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError('invalid_page', `page must be an integer >= 1, got ${raw}`);
  }
  return value;
}

export function parsePageSize(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new ValidationError('invalid_page_size', `pageSize must be an integer, got ${raw}`);
  }
  return Math.min(Math.max(value, PAGE_SIZE_MIN), PAGE_SIZE_MAX);
}

export function parseStatus(raw) {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (!STATUSES.includes(raw)) {
    throw new ValidationError('invalid_status', `status must be one of ${STATUSES.join('|')}, got ${raw}`);
  }
  return raw;
}
