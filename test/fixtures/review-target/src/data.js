// Fictional example data. No real people, addresses, or projects.

export const users = [
  { id: 'u-ana', name: 'Ana Example', projectIds: ['proj-alpha'] },
  { id: 'u-ben', name: 'Ben Example', projectIds: ['proj-beta'] },
  { id: 'u-cid', name: 'Cid Example', projectIds: ['proj-alpha', 'proj-beta'] },
];

export const projects = [
  { id: 'proj-alpha', name: 'Alpha' },
  { id: 'proj-beta', name: 'Beta' },
];

export const entries = [
  { id: 'e-01', projectId: 'proj-alpha', title: 'Kickoff notes', status: 'open', createdAt: '2026-09-01T09:00:00Z', authorEmail: 'ana@example.test', internalNote: 'client asked about budget' },
  { id: 'e-02', projectId: 'proj-alpha', title: 'Vendor shortlist', status: 'open', createdAt: '2026-09-02T10:30:00Z', authorEmail: 'cid@example.test', internalNote: 'prefers vendor K' },
  { id: 'e-03', projectId: 'proj-alpha', title: 'Sprint 1 review', status: 'closed', createdAt: '2026-09-05T15:00:00Z', authorEmail: 'ana@example.test', internalNote: 'scope dispute parked' },
  { id: 'e-04', projectId: 'proj-alpha', title: 'Schema draft', status: 'in-progress', createdAt: '2026-09-07T11:15:00Z', authorEmail: 'cid@example.test', internalNote: 'blocked on legal' },
  { id: 'e-05', projectId: 'proj-alpha', title: 'Access review', status: 'open', createdAt: '2026-09-09T08:45:00Z', authorEmail: 'ana@example.test', internalNote: 'follow up Friday' },
  { id: 'e-06', projectId: 'proj-alpha', title: 'Milestone M2', status: 'closed', createdAt: '2026-09-12T17:20:00Z', authorEmail: 'cid@example.test', internalNote: 'signed off' },
  { id: 'e-07', projectId: 'proj-alpha', title: 'Retrospective', status: 'in-progress', createdAt: '2026-09-15T13:00:00Z', authorEmail: 'ana@example.test', internalNote: 'morale low' },
  { id: 'e-08', projectId: 'proj-beta', title: 'Pilot launch', status: 'open', createdAt: '2026-09-03T09:30:00Z', authorEmail: 'ben@example.test', internalNote: 'champion is away' },
  { id: 'e-09', projectId: 'proj-beta', title: 'Data import', status: 'in-progress', createdAt: '2026-09-06T14:10:00Z', authorEmail: 'ben@example.test', internalNote: 'csv quirks' },
  { id: 'e-10', projectId: 'proj-beta', title: 'Training session', status: 'closed', createdAt: '2026-09-10T16:00:00Z', authorEmail: 'cid@example.test', internalNote: 'recordings internal' },
  { id: 'e-11', projectId: 'proj-beta', title: 'Feedback triage', status: 'open', createdAt: '2026-09-14T10:00:00Z', authorEmail: 'ben@example.test', internalNote: 'escalate billing' },
  { id: 'e-12', projectId: 'proj-beta', title: 'Quarterly report', status: 'in-progress', createdAt: '2026-09-18T12:00:00Z', authorEmail: 'cid@example.test', internalNote: 'draft only' },
];
