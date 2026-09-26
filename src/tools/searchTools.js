const fs = require('node:fs/promises');
const path = require('node:path');
const { resolveWorkspacePath, assertInsideRoot } = require('./fileTools');
async function walk(dir, results = []) {
  for (const e of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b)=>a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '.venv') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, results); else if (e.isFile()) results.push(p);
  }
  return results;
}
function createSearchTool({ workspaceRoot, maxFiles = 2000, maxFileBytes = 1024 * 1024, maxMatches = 2000 }) {
  const root = path.resolve(workspaceRoot);
  return { name: 'search_code', description: 'Search text in workspace files', inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, path: { type: 'string', description: 'Relative directory or file path' } }, required: ['query'], additionalProperties: false }, permissions: ['filesystem:read'], execute: async ({ query, path: p = '.' } = {}) => {
    if (typeof query !== 'string' || !query) throw new TypeError('query is required');
    const realRoot = await fs.realpath(root);
    const start = await assertInsideRoot(root, resolveWorkspacePath(root, p));
    const stat = await fs.stat(start); const files = stat.isDirectory() ? await walk(start) : [start];
    const matches = [];
    for (const file of files.slice(0, maxFiles)) {
      try { if ((await fs.stat(file)).size > maxFileBytes) continue; const content = await fs.readFile(file, 'utf8'); if (content.includes('\0')) continue;
        for (const [i,line] of content.split(/\r?\n/).entries()) { if (line.includes(query)) matches.push({ path: path.relative(realRoot, file), line: i + 1, text: line.slice(0, 500) }); if(matches.length>=maxMatches)return matches; }
      } catch (e) { if (!['EISDIR', 'EACCES'].includes(e.code)) throw e; }
    }
    return matches;
  } };
}
module.exports = { createSearchTool };
