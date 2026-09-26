const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadConfig } = require('../../src/config');
const { loadProvider } = require('../../src/llm/provider');
const { LLMClient } = require('../../src/llm/client');
const { buildOrchestrator } = require('../../src/index');

const enabled = process.env.RUN_LIVE_LLM_TESTS === '1';
const e2eEnabled = process.env.RUN_LIVE_LLM_E2E === '1';
const configured = Boolean(process.env.AI_API_KEY && process.env.LLM_PROVIDER);
const skipReason = !enabled ? 'set RUN_LIVE_LLM_TESTS=1 to enable opt-in live tests' : !configured ? 'real AI_API_KEY and LLM_PROVIDER are required' : false;
const e2eSkipReason = !e2eEnabled ? 'set RUN_LIVE_LLM_E2E=1 to enable the isolated live end-to-end test' : !configured ? 'real AI_API_KEY and LLM_PROVIDER are required' : false;

test('live provider smoke test returns the exact requested text', { skip: skipReason || false, timeout: 120000 }, async () => {
  const config = loadConfig(process.env);
  const provider = await loadProvider(config)(config);
  const llm = new LLMClient({ provider, config });
  const result = await llm.generate({ messages: [{ role: 'user', content: 'Reply with exactly OK.' }], tools: [] }, { timeoutMs: config.llmTimeoutMs });
  assert.equal(result.type, 'final');
  assert.equal(result.content.trim(), 'OK');
});

test('live end-to-end workflow modifies an isolated fixture and verifies it', { skip: e2eSkipReason || false, timeout: 600000 }, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-live-e2e-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.cp(path.join(__dirname, '..', 'fixtures', 'calculator'), workspace, { recursive: true });
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Harness Test', GIT_AUTHOR_EMAIL: 'harness-test@example.invalid', GIT_COMMITTER_NAME: 'Harness Test', GIT_COMMITTER_EMAIL: 'harness-test@example.invalid' };
  execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  execFileSync('git', ['add', '-A'], { cwd: workspace });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture baseline'], { cwd: workspace, env: gitEnv });
  const config = loadConfig({ ...process.env, WORKSPACE_ROOT: workspace, TEST_COMMAND: JSON.stringify(['node', '--test', 'tests/calculator.test.js']), MAX_FIX_ATTEMPTS: '1', MAX_AGENT_RETRIES: '0', MAX_CONCURRENCY: '1', MAX_EXECUTION_TIME_MS: '300000', STEP_TIMEOUT_MS: '120000', LLM_TIMEOUT_MS: '60000', LLM_MAX_RETRIES: '1' });
  const orchestrator = await buildOrchestrator(config);
  const result = await orchestrator.run('Fix the divide function in src/calculator.js: it multiplies instead of returning the quotient. Run the fixture tests, review the change, and verify the result.');
  assert.ok(['verified', 'completed'].includes(result.status), `Live workflow did not verify successfully (status ${result.status}).`);
  assert.equal((await fs.readFile(path.join(workspace, 'src/calculator.js'), 'utf8')).includes('return a / b'), true);
  assert.equal(result.testRuns.some(run => run.success && run.exitCode === 0), true);
});
