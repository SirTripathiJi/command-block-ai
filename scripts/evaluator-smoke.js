#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const OMIT_DIRS = new Set(['.git', 'node_modules', 'outputs', 'work', 'coverage', 'logs', '.cache', '__pycache__']);
const OMIT_FILES = new Set(['.DS_Store']);

async function copyCleanProject(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of (await fs.readdir(from, { withFileTypes: true })).sort((a,b)=>a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (OMIT_DIRS.has(entry.name) || OMIT_FILES.has(entry.name)) continue;
    if (entry.name === '.env' || (entry.name.startsWith('.env.') && entry.name !== '.env.example')) continue;
    if (entry.name.endsWith('.tmp') || entry.name.endsWith('.log') || entry.name.endsWith('.zip') || entry.name.endsWith('~')) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyCleanProject(source, target);
    else if (entry.isFile()) await fs.copyFile(source, target);
  }
}

function runMake(target, { cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('make', [target], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function redact(text, placeholder) { return String(text).split(placeholder).join('[REDACTED]'); }
function requireSuccess(name, result, placeholder) {
  if (result.code !== 0) throw new Error(`${name} failed in clean copy (exit ${result.code}).\n${redact(result.stderr, placeholder).slice(-2000)}`);
}

async function main() {
  const sourceRoot = path.resolve(__dirname, '..');
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-evaluation-'));
  const projectRoot = path.join(tempRoot, 'project');
  const placeholder = `evaluation-placeholder-${process.pid}`;
  const env = { ...process.env, AI_API_KEY: placeholder, LLM_PROVIDER_MODULE: '', WORKSPACE_ROOT: projectRoot, TEST_COMMAND: '', ALLOWED_COMMANDS: '' };
  try {
    await copyCleanProject(sourceRoot, projectRoot);
    requireSuccess('make setup', await runMake('setup', { cwd: projectRoot, env }), placeholder);
    requireSuccess('make test', await runMake('test', { cwd: projectRoot, env }), placeholder);
    const run = await runMake('run', { cwd: projectRoot, env, input: 'Evaluate the supplied software issue.\n' });
    const combined = run.stdout + run.stderr;
    if (run.code === 0 || !combined.includes('"outcome":"configuration_error"') || !combined.includes('LLM_PROVIDER_MODULE') || combined.includes(placeholder)) {
      throw new Error('make run did not produce the expected redacted configuration_error for an unconfigured provider.');
    }
    requireSuccess('make clean', await runMake('clean', { cwd: projectRoot, env }), placeholder);
    for (const required of ['src/index.js', 'tests/fixtures/api-bug/src/routes/users.js', 'package.json', 'package-lock.json', 'README.md', 'Makefile', '.env.example']) {
      await fs.access(path.join(projectRoot, required));
    }
    try { await fs.access(path.join(projectRoot, 'node_modules')); throw new Error('make clean left node_modules in the clean copy.'); }
    catch (error) { if (error.message.includes('left node_modules')) throw error; if (error.code !== 'ENOENT') throw error; }
    process.stdout.write('Clean-copy evaluation simulation passed: setup, deterministic tests, structured provider configuration error, redaction, and cleanup.\n');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
