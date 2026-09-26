const { ConfigurationError } = require('../utils/errors');

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const NAME = /^[a-zA-Z0-9_-]{1,128}$/;

class OpenAICompatibleProvider {
  constructor({ endpoint, model, apiKey, disableThinking = false, fetchImpl = globalThis.fetch } = {}) {
    if (!apiKey) throw new ConfigurationError('AI_API_KEY is required for real provider requests.', 'missing_api_key');
    if (typeof model !== 'string' || !model.trim() || model.length > 256) throw new ConfigurationError('LLM_MODEL is required for the selected provider.', 'missing_llm_model');
    if (typeof endpoint !== 'string' || !endpoint.trim()) throw new ConfigurationError('LLM_ENDPOINT is required for the selected provider.', 'missing_llm_endpoint');
    let url;
    try { url = new URL(endpoint); } catch { throw new ConfigurationError('LLM_ENDPOINT must be a valid HTTPS URL.', 'invalid_llm_endpoint'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new ConfigurationError('LLM_ENDPOINT must use HTTPS and must not contain embedded credentials.', 'invalid_llm_endpoint');
    if (typeof fetchImpl !== 'function') throw new ConfigurationError('This Node.js runtime must provide fetch for real LLM requests.', 'fetch_unavailable');
    this.endpoint = appendCompletionsPath(url);
    this.model = model.trim();
    this.apiKey = apiKey;
    this.disableThinking = disableThinking;
    this.fetch = fetchImpl;
  }

  async generate(request, options = {}) {
    validateRequest(request);
    const payload = {
      model: options.model || this.model,
      messages: request.messages.map(toProviderMessage),
      ...(request.tools?.length ? { tools: request.tools.map(toProviderTool) } : {}),
      ...(Number.isFinite(options.temperature) ? { temperature: options.temperature } : {}),
      ...(Number.isInteger(options.maxTokens) ? { max_tokens: options.maxTokens } : {}),
      ...(this.disableThinking ? { thinking: { type: 'disabled' } } : {})
    };
    let response;
    try {
      response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: options.signal
      });
    } catch (error) {
      if (options.signal?.aborted || error?.name === 'AbortError') throw codedError('LLM provider request timed out.', 'provider_timeout');
      const network = codedError('LLM provider is temporarily unavailable.', 'llm_unavailable');
      network.retryable = true;
      throw network;
    }
    if (!response || !Number.isInteger(response.status)) throw codedError('LLM provider returned a malformed HTTP response.', 'invalid_llm_response');
    if (!response.ok) throw httpError(response.status);
    let body;
    try {
      const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
      body = JSON.parse(text);
    } catch (error) {
      if (error?.code) throw error;
      throw codedError('LLM provider returned a malformed response.', 'invalid_llm_response');
    }
    return normalizeChatCompletion(body, request.tools || []);
  }
}

function createProvider(config, dependencies) {
  const provider = (config.llmProvider || '').toLowerCase();
  if (!['deepseek', 'qwen'].includes(provider)) throw new ConfigurationError('Set LLM_PROVIDER to deepseek or qwen.', 'provider_not_configured');
  const endpoint = config.llmEndpoint || (provider === 'deepseek' ? 'https://api.deepseek.com' : '');
  return new OpenAICompatibleProvider({ endpoint, model: config.llmModel, apiKey: config.apiKey, disableThinking: provider === 'deepseek', fetchImpl: dependencies?.fetchImpl });
}

function appendCompletionsPath(url) {
  const result = new URL(url.href);
  const basePath = result.pathname.replace(/\/+$/, '');
  if (!basePath.endsWith('/chat/completions')) result.pathname = `${basePath}/chat/completions`;
  return result.href;
}

function validateRequest(request) {
  if (!request || !Array.isArray(request.messages) || !request.messages.length || request.messages.length > 200 || !Array.isArray(request.tools || [])) throw codedError('LLM request is malformed.', 'invalid_llm_request');
}

function toProviderMessage(message) {
  if (message.role === 'tool') return { role: 'tool', tool_call_id: message.tool_call_id, content: message.content };
  if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
    return { role: 'assistant', content: message.content || null, tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) };
  }
  return { role: message.role, content: message.content };
}

function toProviderTool(tool) {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } };
}

function normalizeChatCompletion(body, availableTools) {
  if (!isRecord(body) || !Array.isArray(body.choices) || body.choices.length < 1 || !isRecord(body.choices[0]) || !isRecord(body.choices[0].message)) throw codedError('LLM provider returned a malformed response.', 'invalid_llm_response');
  const message = body.choices[0].message;
  if (typeof message.refusal === 'string' && message.refusal) throw codedError('LLM provider refused the request.', 'llm_refusal');
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls) || !message.tool_calls.length || message.tool_calls.length > 32) throw codedError('LLM provider returned malformed tool calls.', 'invalid_llm_response');
    const allowed = new Set(availableTools.map(tool => tool.name));
    const ids = new Set();
    const toolCalls = message.tool_calls.map(call => {
      const id = call?.id;
      const name = call?.function?.name;
      const raw = call?.function?.arguments;
      if (call?.type !== 'function' || typeof id !== 'string' || !id || id.length > 256 || ids.has(id) || typeof name !== 'string' || !NAME.test(name) || !allowed.has(name) || typeof raw !== 'string' || Buffer.byteLength(raw) > 64 * 1024) throw codedError('LLM provider returned an invalid or unauthorized tool call.', 'invalid_llm_response');
      ids.add(id);
      let args;
      try { args = JSON.parse(raw); } catch { throw codedError('LLM provider returned malformed tool arguments.', 'invalid_llm_response'); }
      if (!isRecord(args)) throw codedError('LLM provider returned malformed tool arguments.', 'invalid_llm_response');
      return { id, name, arguments: args };
    });
    return { type: 'tool_calls', toolCalls };
  }
  if (message.content === null || typeof message.content === 'string') {
    const content = message.content || '';
    if (Buffer.byteLength(content) > 1024 * 1024) throw codedError('LLM provider response exceeds the size limit.', 'invalid_llm_response');
    return { type: 'final', content };
  }
  throw codedError('LLM provider returned an unsupported message type.', 'invalid_llm_response');
}

async function readBoundedText(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw codedError('LLM provider response exceeds the size limit.', 'invalid_llm_response');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw codedError('LLM provider response exceeds the size limit.', 'invalid_llm_response');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw codedError('LLM provider response exceeds the size limit.', 'invalid_llm_response'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function httpError(status) {
  let code = 'llm_provider_error';
  let message = 'LLM provider request failed.';
  let retryable = false;
  if (status === 401 || status === 403) { code = 'llm_authentication_error'; message = 'LLM provider authentication failed.'; }
  else if (status === 404) { code = 'llm_invalid_endpoint_or_model'; message = 'LLM endpoint or model was not found.'; }
  else if (status === 408) { code = 'provider_timeout'; message = 'LLM provider request timed out.'; retryable = true; }
  else if (status === 400 || status === 422) { code = 'llm_invalid_request'; message = 'LLM provider rejected the request.'; }
  else if (status === 429) { code = 'llm_rate_limit'; message = 'LLM provider rate limit reached.'; retryable = true; }
  else if (status >= 500) { code = 'llm_unavailable'; message = 'LLM provider is temporarily unavailable.'; retryable = true; }
  const error = codedError(message, code);
  error.status = status;
  error.retryable = retryable;
  throw error;
}

function codedError(message, code) { return Object.assign(new Error(message), { name: 'LLMProviderError', code }); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

module.exports = { OpenAICompatibleProvider, createProvider, normalizeChatCompletion, toProviderTool, toProviderMessage, appendCompletionsPath };
