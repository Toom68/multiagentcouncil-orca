import { listEntries, exportProject } from './src/app.js';
import { users } from './src/data.js';

const ana = users.find((u) => u.id === 'u-ana');
const ben = users.find((u) => u.id === 'u-ben');
const cid = users.find((u) => u.id === 'u-cid');

console.log('ana / proj-alpha / page 1 of 3:');
console.log(JSON.stringify(listEntries({ user: ana, projectId: 'proj-alpha', page: 1, pageSize: 3 }), null, 2));

console.log('ben / proj-beta / open only:');
console.log(JSON.stringify(listEntries({ user: ben, projectId: 'proj-beta', page: 1, pageSize: 10, status: 'open' }), null, 2));

console.log('cid / proj-beta export:');
console.log(JSON.stringify(exportProject({ user: cid, projectId: 'proj-beta' }), null, 2));
