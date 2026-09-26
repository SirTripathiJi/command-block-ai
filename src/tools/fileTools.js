const fs = require('node:fs/promises');
const path = require('node:path');
const { PermissionError } = require('../utils/errors');
function resolveWorkspacePath(root, relativePath = '.') {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) throw new PermissionError('Only relative workspace paths are allowed');
  const absolute = path.resolve(root, relativePath);
  const rel = path.relative(path.resolve(root), absolute);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new PermissionError('Path escapes the workspace');
  return absolute;
}
async function assertInsideRoot(root, target) {
  const realRoot = await fs.realpath(root);
  let realTarget;
  try { realTarget = await fs.realpath(target); } catch (e) { if (e.code === 'ENOENT') return target; throw e; }
  const rel = path.relative(realRoot, realTarget);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new PermissionError('Path resolves outside the workspace');
  return realTarget;
}
function createFileTools({ workspaceRoot }) {
  const root = path.resolve(workspaceRoot);
  return [
    { name: 'list_files', description: 'List entries in a workspace directory (limited to 2,000 entries)', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Relative directory path inside the workspace' } }, additionalProperties: false }, permissions: ['filesystem:read'], execute: async ({ path: p = '.' } = {}) => { const target = await assertInsideRoot(root, resolveWorkspacePath(root, p)); return (await fs.readdir(target, { withFileTypes: true })).sort((a,b)=>a.name < b.name ? -1 : a.name > b.name ? 1 : 0).slice(0,2000).map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })); } },
    { name: 'read_file', description: 'Read a UTF-8 file inside the workspace (maximum 1 MiB)', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Relative file path inside the workspace' } }, required: ['path'], additionalProperties: false }, permissions: ['filesystem:read'], execute: async ({ path: p } = {}) => { if (!p) throw new TypeError('path is required'); const target = await assertInsideRoot(root, resolveWorkspacePath(root, p)); const stat = await fs.stat(target); if (stat.size > 1024 * 1024) throw Object.assign(new Error('File exceeds the 1 MiB read limit'), { code: 'OUTPUT_LIMIT' }); return fs.readFile(target, 'utf8'); } }
  ];
}
module.exports = { resolveWorkspacePath, assertInsideRoot, createFileTools };
