const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../../src/config');
const { LLMClient, normalizeResponse } = require('../../src/llm/client');
const { ConfigurationError } = require('../../src/utils/errors');

const request = { messages: [{ role: 'user', content: 'hello' }], tools: [] };
function client(provider, overrides = {}) {
  return new LLMClient({ provider, config: { apiKey: 'placeholder', model: 'fixture', llmModel: 'fixture', temperature: 0, maxTokens: 64, llmTimeoutMs: 100, llmMaxRetries: 1, ...overrides } });
}

test('LLM timeout and retry configuration is validated and bounded', () => {
  const config = loadConfig({});
  assert.equal(config.llmTimeoutMs, 30000);
  assert.equal(config.llmMaxRetries, 2);
  assert.equal(loadConfig({ LLM_TIMEOUT_MS: '5', LLM_MAX_RETRIES: '0' }).llmTimeoutMs, 5);
  for (const [key, value] of [['LLM_TIMEOUT_MS', '0'], ['LLM_TIMEOUT_MS', '300001'], ['LLM_MAX_RETRIES', '-1'], ['LLM_MAX_RETRIES', '11']]) assert.throws(() => loadConfig({ [key]: value }), ConfigurationError);
});

test('two provider adapters satisfy the same normalized runtime contract', async () => {
  for (const adapter of [
    { generate: async () => ({ type: 'final', content: 'adapter one' }) },
    { generate: async () => ({ type: 'message', content: 'adapter two' }) }
  ]) assert.equal((await client(adapter).generate(request)).type, 'final');
});

test('transient failures retry within the configured bound and persistent errors stop', async () => {
  let calls = 0;
  const activity = [];
  const result = await client({ generate: async () => { calls++; if (calls === 1) throw Object.assign(new Error('temporary'), { code: 'ECONNRESET' }); return { type: 'final', content: 'ok' }; } }).generate(request, { onEvent: event => activity.push(event) });
  assert.equal(result.content, 'ok'); assert.equal(calls, 2); assert.equal(activity.filter(item => item.type === 'retry').length, 1);
  calls = 0;
  await assert.rejects(client({ generate: async () => { calls++; throw Object.assign(new Error('down'), { status: 503 }); } }).generate(request), error => error.code === 'llm_retry_exhausted');
  assert.equal(calls, 2);
});

test('timeout aborts the adapter signal and returns a safe timeout code', async () => {
  let aborted = false;
  await assert.rejects(client({ generate: (_request, options) => new Promise(resolve => options.signal.addEventListener('abort', () => { aborted = true; resolve({ type: 'final', content: 'late' }); })) }, { llmTimeoutMs: 10, llmMaxRetries: 0 }).generate(request), error => error.code === 'provider_timeout');
  assert.equal(aborted, true);
});

test('malformed requests and responses fail at the client boundary', async () => {
  let calls = 0; const llm = client({ generate: async () => { calls++; return { type: 'tool_call', tool: 'bad name', arguments: {} }; } });
  await assert.rejects(llm.generate({ messages: [{ role: 'unknown', content: 'x' }] }), error => error.code === 'invalid_llm_request');
  await assert.rejects(llm.generate(request), error => error.code === 'invalid_llm_response');
  assert.equal(calls, 1);
  assert.throws(() => normalizeResponse({ type: 'tool_call', toolCalls: [{ name: 'one', arguments: {} }, { name: 'two', arguments: {} }] }), error => error.code === 'invalid_llm_response');
});

test('provider errors and task activity never expose credentials or prompts', async () => {
  const secret = 'fixture-super-secret'; const prompt = 'private prompt text';
  await assert.rejects(client({ generate: async () => { throw new Error(`${secret} ${prompt}`); } }, { apiKey: secret }).generate({ messages: [{ role: 'user', content: prompt }] }), error => !error.message.includes(secret) && !error.message.includes(prompt));
});
