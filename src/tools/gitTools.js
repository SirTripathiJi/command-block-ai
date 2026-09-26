const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { assertInsideRoot } = require('./fileTools');
const execFileAsync = promisify(execFile);
function createGitTools({ workspaceRoot, timeoutMs = 10000 }) {
  const root = path.resolve(workspaceRoot);
  const run = async args => { await assertInsideRoot(root, root); const { stdout } = await execFileAsync('git', args, { cwd: root, timeout: timeoutMs, maxBuffer: 1024 * 1024 }); return stdout; };
  return [
    { name: 'git_status', description: 'Read repository status', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, permissions: ['git:read'], execute: () => run(['status', '--short', '--branch']) },
    { name: 'git_diff', description: 'Read working tree diff', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, permissions: ['git:read'], execute: () => run(['diff', '--']) }
  ];
}
module.exports = { createGitTools };
