const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { PermissionError } = require('../utils/errors');
const execFileAsync = promisify(execFile);
function createCommandTool({ workspaceRoot, allowedCommands = [], timeoutMs = 10000, maxOutputBytes = 100000 }) {
  const root = path.resolve(workspaceRoot);
  return { name: 'run_command', description: 'Run a configured command in the workspace (shell syntax is disabled)', inputSchema: { command: 'string; required', args: 'string[]; optional' }, permissions: ['process:execute'], execute: async ({ command, args = [] } = {}) => {
    if (typeof command !== 'string' || !Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new TypeError('command and string args are required');
    const permitted = allowedCommands.some(entry => { const parts = entry.trim().split(/\s+/); return parts.length === args.length + 1 && parts[0] === command && parts.slice(1).every((part, i) => args[i] === part); });
    if (!permitted) throw new PermissionError(`Command is not allowlisted: ${command}`);
    try { const out = await execFileAsync(command, args, { cwd: root, timeout: timeoutMs, maxBuffer: maxOutputBytes, shell: false }); return { stdout: out.stdout.slice(0, maxOutputBytes), stderr: out.stderr.slice(0, maxOutputBytes), exitCode: 0 }; }
    catch (e) { if (e.code === 'ENOENT' || e.killed) throw e; return { stdout: String(e.stdout || '').slice(0, maxOutputBytes), stderr: String(e.stderr || '').slice(0, maxOutputBytes), exitCode: e.code ?? 1 }; }
  } };
}
module.exports = { createCommandTool };
