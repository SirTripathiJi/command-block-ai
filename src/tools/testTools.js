const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const { resolveWorkspacePath, assertInsideRoot } = require('./fileTools');
const { PermissionError, ValidationError } = require('../utils/errors');
const execFileAsync = promisify(execFile);
async function detectTestCommand(root) {
  try { const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); if (pkg.scripts?.test) return ['npm', 'test']; } catch {}
  try { await fs.access(path.join(root, 'pytest.ini')); return ['pytest']; } catch {}
  try { await fs.access(path.join(root, 'pyproject.toml')); return ['pytest']; } catch {}
  try { await fs.access(path.join(root, 'go.mod')); return ['go', 'test', './...']; } catch {}
  return null;
}
function createRunTestsTool({ workspaceRoot, testCommand, timeoutMs = 120000, maxOutputBytes = 100000 }) {
  const root = path.resolve(workspaceRoot);
  return { name: 'run_tests', description: 'Run the configured or safely detected repository test command in the workspace.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, permissions: ['process:test'], execute: async () => {
    const startedAt = Date.now(); const startedIso = new Date(startedAt).toISOString();
    const evidence = result => ({ ...result, startedAt: startedIso, endedAt: new Date().toISOString(), durationMs: Date.now() - startedAt });
    await assertInsideRoot(root, root);
    const command = testCommand || await detectTestCommand(root);
    if (!command || !Array.isArray(command) || command.length < 1 || command.some(part => typeof part !== 'string' || !part || part.startsWith('-') && command[0] === '')) throw Object.assign(new ValidationError('No supported test command detected; configure TEST_COMMAND as a JSON string array.'), { code: 'NO_TEST_COMMAND' });
    const executable = command[0];
    if (['sh', 'bash', 'zsh', 'cmd', 'powershell', 'pwsh', 'rm', 'sudo', 'curl', 'wget'].includes(path.basename(executable).toLowerCase())) throw new PermissionError(`Dangerous test executable is not allowed: ${executable}`);
    if (path.isAbsolute(executable) || executable.includes('/') || executable.includes('\\') || /[;&|`$<>\n]/.test(executable)) throw new PermissionError('Test executable must be a bare allowlisted command name');
    const args = command.slice(1);
    try {
      const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
      const result = await execFileAsync(executable, args, { cwd: root, env: childEnv, shell: false, timeout: timeoutMs, maxBuffer: maxOutputBytes, windowsHide: true });
      return evidence({ success: true, exitCode: 0, command, stdout: String(result.stdout || '').slice(0, maxOutputBytes), stderr: String(result.stderr || '').slice(0, maxOutputBytes) });
    } catch (error) {
      if (error.killed || error.code === 'ETIMEDOUT') return evidence({ success: false, exitCode: null, command, timedOut: true, stdout: String(error.stdout || '').slice(0, maxOutputBytes), stderr: String(error.stderr || '').slice(0, maxOutputBytes), error: { code: 'TIMEOUT', message: `Test command exceeded ${timeoutMs}ms` } });
      if (error.code === 'ENOENT') return evidence({ success: false, exitCode: null, command, stdout: '', stderr: '', error: { code: 'COMMAND_NOT_FOUND', message: `Test command executable not found: ${executable}` } });
      return evidence({ success: false, exitCode: typeof error.code === 'number' ? error.code : 1, command, stdout: String(error.stdout || '').slice(0, maxOutputBytes), stderr: String(error.stderr || '').slice(0, maxOutputBytes) });
    }
  } };
}
module.exports = { createRunTestsTool, detectTestCommand };
