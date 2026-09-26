const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { OpenAICompatibleProvider, createProvider } = require('../../src/llm/openaiCompatibleProvider');
const { LLMClient } = require('../../src/llm/client');
const { loadConfig } = require('../../src/config');
const { loadProvider } = require('../../src/llm/provider');
const { parsePlannerJson } = require('../../src/core/taskPlanner');

const config = (extra = {}) => ({ apiKey: 'fake-test-key', llmModel: 'fixture-model', llmEndpoint: 'https://api.example.test/v1', llmTimeoutMs: 500, llmMaxRetries: 1, temperature: 0, maxTokens: 100, ...extra });
const tools = [{ name: 'read_file', description: 'Read one file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }];
function response(status, body) { return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => typeof body === 'string' ? body : JSON.stringify(body) }; }
function completion(message) { return response(200, { choices: [{ message }] }); }

test('OpenAI-compatible adapter formats a normal request and normalizes text', async () => {
  let captured;
  const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test/v1', model: 'fixture', apiKey: 'fake', fetchImpl: async (url, init) => { captured = { url, init, body: JSON.parse(init.body) }; return completion({ role: 'assistant', content: 'OK' }); } });
  const result = await provider.generate({ messages: [{ role: 'user', content: 'hello' }], tools });
  assert.deepEqual(result, { type: 'final', content: 'OK' });
  assert.equal(captured.url, 'https://api.example.test/v1/chat/completions');
  assert.equal(captured.body.model, 'fixture');
  assert.deepEqual(captured.body.tools[0].function.parameters, tools[0].inputSchema);
  assert.equal(captured.init.headers.authorization, 'Bearer fake');
  assert.equal('response_format' in captured.body, false);
});

test('adapter normalizes one provider tool call and enforces ID, known tool, JSON, and object arguments', async () => {
  const generate = async message => new OpenAICompatibleProvider({ endpoint: 'https://api.example.test/v1', model: 'fixture', apiKey: 'fake', fetchImpl: async () => completion(message) }).generate({ messages: [{ role: 'user', content: 'read' }], tools });
  assert.deepEqual(await generate({ tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.js"}' } }] }), { type: 'tool_calls', toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'src/a.js' } }] });
  for (const call of [
    { type: 'function', function: { name: 'read_file', arguments: '{}' } },
    { id: 'x', type: 'function', function: { name: 'not_allowed', arguments: '{}' } },
    { id: 'x', type: 'function', function: { name: 'read_file', arguments: '{' } },
    { id: 'x', type: 'function', function: { name: 'read_file', arguments: '[]' } }
  ]) await assert.rejects(generate({ tool_calls: [call] }), error => error.code === 'invalid_llm_response');
});

test('adapter supports multiple calls and converts prior tool results with matching call IDs', async () => {
  let captured;
  const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test/v1', model: 'fixture', apiKey: 'fake', fetchImpl: async (_url, init) => { captured = JSON.parse(init.body); return completion({ content: 'done' }); } });
  await provider.generate({ messages: [
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a' } }, { id: 'c2', name: 'read_file', arguments: { path: 'b' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'one' }, { role: 'tool', tool_call_id: 'c2', content: 'two' }
  ], tools });
  assert.equal(captured.messages[0].tool_calls[1].id, 'c2');
  assert.equal(captured.messages[1].tool_call_id, 'c1');
  assert.equal(captured.messages[2].tool_call_id, 'c2');
});

test('HTTP 400, auth, rate limit, and server failures normalize to safe categories', async () => {
  for (const [status, code] of [[400, 'llm_invalid_request'], [401, 'llm_authentication_error'], [404, 'llm_invalid_endpoint_or_model'], [429, 'llm_retry_exhausted'], [503, 'llm_retry_exhausted']]) {
    let calls = 0;
    const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test/v1', model: 'fixture', apiKey: 'SECRET_TOKEN', fetchImpl: async () => { calls++; return response(status, { error: { message: 'SECRET_TOKEN Authorization: Bearer SECRET_TOKEN' } }); } });
    const llm = new LLMClient({ provider, config: config({ llmMaxRetries: 0 }) });
    await assert.rejects(llm.generate({ messages: [{ role: 'user', content: 'x' }], tools: [] }), error => error.code === code && !error.message.includes('SECRET_TOKEN') && !error.message.includes('Authorization'));
    if (status === 400 || status === 401 || status === 404) assert.equal(calls, 1, `status ${status} should not retry`);
  }
});

test('transient server errors retry and stop at the configured bound', async () => {
  let calls = 0;
  const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test/v1', model: 'fixture', apiKey: 'fake', fetchImpl: async () => ++calls === 1 ? response(503, {}) : completion({ content: 'ok' }) });
  const llm = new LLMClient({ provider, config: config({ llmMaxRetries: 1 }) });
  assert.equal((await llm.generate({ messages: [{ role: 'user', content: 'x' }] })).content, 'ok');
  assert.equal(calls, 2);
  calls = 0;
  const down = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test/v1', model: 'fixture', apiKey: 'fake', fetchImpl: async () => { calls++; return response(503, {}); } });
  await assert.rejects(new LLMClient({ provider: down, config: config({ llmMaxRetries: 1 }) }).generate({ messages: [{ role: 'user', content: 'x' }] }), error => error.code === 'llm_retry_exhausted');
  assert.equal(calls, 2);
});

test('timeout aborts provider fetch without leaking endpoint query data', async () => {
  let aborted = false;
  const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test/v1?token=endpoint-secret', model: 'fixture', apiKey: 'fake', fetchImpl: async (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); })) });
  await assert.rejects(new LLMClient({ provider, config: config({ llmTimeoutMs: 15, llmMaxRetries: 0 }) }).generate({ messages: [{ role: 'user', content: 'x' }] }), error => error.code === 'provider_timeout' && !error.message.includes('endpoint-secret'));
  assert.equal(aborted, true);
});

test('malformed and oversized provider responses are bounded failures', async () => {
  for (const body of ['not json', { choices: [] }, { choices: [{ message: { role: 'assistant', content: ['unsupported'] } }] }]) {
    const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test/v1', model: 'fixture', apiKey: 'fake', fetchImpl: async () => response(200, body) });
    await assert.rejects(provider.generate({ messages: [{ role: 'user', content: 'x' }] }), error => error.code === 'invalid_llm_response');
  }
});

test('provider selection validates DeepSeek, configurable Qwen, and custom endpoints', async () => {
  const deepseek = createProvider({ llmProvider: 'deepseek', llmModel: 'deepseek-flash', apiKey: 'test' });
  assert.equal(deepseek.endpoint, 'https://api.deepseek.com/chat/completions');
  const qwen = createProvider({ llmProvider: 'qwen', llmModel: 'configured-model', llmEndpoint: 'https://region.example.test/compatible-mode/v1', apiKey: 'test' });
  assert.equal(qwen.endpoint, 'https://region.example.test/compatible-mode/v1/chat/completions');
  assert.equal(qwen.disableThinking, false);
  assert.equal(deepseek.disableThinking, true);
  let deepseekBody;
  const explicitNonThinking = new OpenAICompatibleProvider({ endpoint: deepseek.endpoint, model: 'configured-deepseek-model', apiKey: 'test', disableThinking: true, fetchImpl: async (_url, init) => { deepseekBody = JSON.parse(init.body); return completion({ content: 'ok' }); } });
  await explicitNonThinking.generate({ messages: [{ role: 'user', content: 'test' }] });
  assert.deepEqual(deepseekBody.thinking, { type: 'disabled' });
  assert.throws(() => createProvider({ llmProvider: 'qwen', llmModel: 'configured-model', apiKey: 'test' }), error => error.code === 'missing_llm_endpoint');
  assert.throws(() => createProvider({ llmProvider: 'qwen', llmEndpoint: 'https://region.example.test/v1', apiKey: 'test' }), error => error.code === 'missing_llm_model');
  assert.throws(() => loadProvider({}), error => error.code === 'provider_not_configured');
  const withoutKey = loadConfig({ LLM_PROVIDER: 'deepseek', LLM_MODEL: 'configured-model' });
  assert.throws(() => loadProvider(withoutKey)(withoutKey), error => error.code === 'missing_api_key');
  assert.throws(() => loadConfig({ LLM_THINKING_MODE: 'enabled' }), error => error.code === 'unsupported_thinking_mode');
  assert.throws(() => loadConfig({ LLM_PROVIDER: 'other' }), /LLM_PROVIDER/);
});

test('custom provider module selection remains available and takes precedence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-test-'));
  const moduleFile = path.join(dir, 'custom.js');
  fs.writeFileSync(moduleFile, 'exports.createProvider = config => ({ generate: async () => ({ type: "final", content: config.llmModel }) });');
  try {
    const factory = loadProvider({ providerModule: moduleFile, llmProvider: 'deepseek' });
    assert.equal(factory({ llmModel: 'custom-wins' }).generate instanceof Function, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('planner accepts fenced JSON while malformed JSON stays controlled', () => {
  assert.deepEqual(parsePlannerJson('```json\n{"goal":"x","steps":[]}\n```'), { goal: 'x', steps: [] });
  assert.throws(() => parsePlannerJson('Here is JSON: {}'));
});

// Focused boundary contracts for the newly added network adapter.
test('provider rejects a missing credential before any request', () => {
  assert.throws(() => new OpenAICompatibleProvider({ endpoint: 'https://api.example.test', model: 'm', apiKey: '' }), error => error.code === 'missing_api_key');
});

test('provider rejects a blank model before any request', () => {
  assert.throws(() => new OpenAICompatibleProvider({ endpoint: 'https://api.example.test', model: '  ', apiKey: 'fake' }), error => error.code === 'missing_llm_model');
});

test('provider rejects an overlong model name', () => {
  assert.throws(() => new OpenAICompatibleProvider({ endpoint: 'https://api.example.test', model: 'm'.repeat(257), apiKey: 'fake' }), error => error.code === 'missing_llm_model');
});

test('provider rejects a missing endpoint', () => {
  assert.throws(() => new OpenAICompatibleProvider({ model: 'm', apiKey: 'fake' }), error => error.code === 'missing_llm_endpoint');
});

test('provider rejects malformed endpoint text', () => {
  assert.throws(() => new OpenAICompatibleProvider({ endpoint: 'not a url', model: 'm', apiKey: 'fake' }), error => error.code === 'invalid_llm_endpoint');
});

test('provider rejects non-HTTP endpoint protocols', () => {
  assert.throws(() => new OpenAICompatibleProvider({ endpoint: 'file:///tmp/provider', model: 'm', apiKey: 'fake' }), error => error.code === 'invalid_llm_endpoint');
});

test('provider rejects remote HTTP endpoints before sending the API key', () => {
  assert.throws(() => new OpenAICompatibleProvider({ endpoint: 'http://api.example.test/v1', model: 'm', apiKey: 'fake' }), error => error.code === 'invalid_llm_endpoint' && /HTTPS/.test(error.message));
});

test('provider rejects HTTP localhost unless an approved exception exists', () => {
  for (const endpoint of ['http://localhost:8080/v1', 'http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1']) {
    assert.throws(() => new OpenAICompatibleProvider({ endpoint, model: 'm', apiKey: 'fake' }), error => error.code === 'invalid_llm_endpoint');
  }
});

test('provider rejects credentials embedded in endpoint URL', () => {
  assert.throws(() => new OpenAICompatibleProvider({ endpoint: 'https://user:pass@example.test/v1', model: 'm', apiKey: 'fake' }), error => error.code === 'invalid_llm_endpoint');
});

test('provider requires a fetch implementation', () => {
  assert.throws(() => new OpenAICompatibleProvider({ endpoint: 'https://api.example.test', model: 'm', apiKey: 'fake', fetchImpl: null }), error => error.code === 'fetch_unavailable');
});

test('endpoint builder preserves an existing chat completions path', () => {
  const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test/v1/chat/completions', model: 'm', apiKey: 'fake' });
  assert.equal(provider.endpoint, 'https://api.example.test/v1/chat/completions');
});

test('endpoint builder trims trailing slashes before appending API path', () => {
  const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test/v1///', model: 'm', apiKey: 'fake' });
  assert.equal(provider.endpoint, 'https://api.example.test/v1/chat/completions');
});

test('request validator rejects null, missing messages, and empty messages', async () => {
  const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test', model: 'm', apiKey: 'fake', fetchImpl: async () => assert.fail('fetch must not be called') });
  for (const request of [null, {}, { messages: [] }]) await assert.rejects(provider.generate(request), error => error.code === 'invalid_llm_request');
});

test('request validator rejects more than 200 messages', async () => {
  const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test', model: 'm', apiKey: 'fake', fetchImpl: async () => assert.fail('fetch must not be called') });
  await assert.rejects(provider.generate({ messages: Array.from({ length: 201 }, () => ({ role: 'user', content: 'x' })) }), error => error.code === 'invalid_llm_request');
});

test('request validator rejects a non-array tools value', async () => {
  const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test', model: 'm', apiKey: 'fake', fetchImpl: async () => assert.fail('fetch must not be called') });
  await assert.rejects(provider.generate({ messages: [{ role: 'user', content: 'x' }], tools: {} }), error => error.code === 'invalid_llm_request');
});

test('adapter forwards configured generation parameters without changing text content', async () => {
  let payload;
  const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test', model: 'default', apiKey: 'fake', fetchImpl: async (_url, init) => { payload = JSON.parse(init.body); return completion({ content: 'ok' }); } });
  await provider.generate({ messages: [{ role: 'user', content: 'plain text' }] }, { model: 'configured', temperature: 0.4, maxTokens: 64 });
  assert.equal(payload.model, 'configured');
  assert.equal(payload.temperature, 0.4);
  assert.equal(payload.max_tokens, 64);
  assert.deepEqual(payload.messages, [{ role: 'user', content: 'plain text' }]);
});

test('provider normalizes null completion content to an empty final response', async () => {
  const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test', model: 'm', apiKey: 'fake', fetchImpl: async () => completion({ content: null }) });
  assert.deepEqual(await provider.generate({ messages: [{ role: 'user', content: 'x' }] }), { type: 'final', content: '' });
});

test('provider reports refusal without exposing provider body', async () => {
  const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test', model: 'm', apiKey: 'fake', fetchImpl: async () => completion({ refusal: 'private refusal detail', content: '' }) });
  await assert.rejects(provider.generate({ messages: [{ role: 'user', content: 'x' }] }), error => error.code === 'llm_refusal' && !error.message.includes('private refusal detail'));
});

test('provider rejects repeated tool-call identifiers', async () => {
  const duplicate = { id: 'same', type: 'function', function: { name: 'read_file', arguments: '{}' } };
  const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test', model: 'm', apiKey: 'fake', fetchImpl: async () => completion({ tool_calls: [duplicate, duplicate] }) });
  await assert.rejects(provider.generate({ messages: [{ role: 'user', content: 'x' }], tools }), error => error.code === 'invalid_llm_response');
});

test('provider rejects HTTP 403 without retrying', async () => {
  let calls = 0;
  const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test', model: 'm', apiKey: 'fake', fetchImpl: async () => { calls++; return response(403, {}); } });
  await assert.rejects(new LLMClient({ provider, config: config({ llmMaxRetries: 2 }) }).generate({ messages: [{ role: 'user', content: 'x' }] }), error => error.code === 'llm_authentication_error');
  assert.equal(calls, 1);
});

test('provider retries HTTP 408 within the configured attempt budget', async () => {
  let calls = 0;
  const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test', model: 'm', apiKey: 'fake', fetchImpl: async () => ++calls === 1 ? response(408, {}) : completion({ content: 'recovered' }) });
  const result = await new LLMClient({ provider, config: config({ llmMaxRetries: 1 }) }).generate({ messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(result, { type: 'final', content: 'recovered' });
  assert.equal(calls, 2);
});

test('provider rejects malformed HTTP response objects safely', async () => {
  const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test', model: 'm', apiKey: 'fake', fetchImpl: async () => ({ ok: true }) });
  await assert.rejects(provider.generate({ messages: [{ role: 'user', content: 'x' }] }), error => error.code === 'invalid_llm_response');
});

test('provider maps tool metadata into the function calling request format', async () => {
  let payload;
  const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.test', model: 'm', apiKey: 'fake', fetchImpl: async (_url, init) => { payload = JSON.parse(init.body); return completion({ content: 'ok' }); } });
  const result = await provider.generate({ messages: [{ role: 'user', content: 'x' }], tools });
  assert.deepEqual(result, { type: 'final', content: 'ok' });
  assert.deepEqual(payload.tools, [{ type: 'function', function: { name: 'read_file', description: 'Read one file', parameters: tools[0].inputSchema } }]);
});
