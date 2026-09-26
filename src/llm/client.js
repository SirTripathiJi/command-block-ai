const { ConfigurationError, ValidationError } = require('../utils/errors');

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH']);

function normalizeRequest(request) {
  if (!isRecord(request) || !Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > 200) throw invalidRequest();
  for (const message of request.messages) {
    if (!isRecord(message) || !['system', 'user', 'assistant', 'tool'].includes(message.role) || typeof message.content !== 'string' || message.content.length > 1024 * 1024) throw invalidRequest();
  }
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools) || request.tools.length > 100) throw invalidRequest();
    const names = new Set();
    for (const tool of request.tools) {
      if (!isRecord(tool) || typeof tool.name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name) || names.has(tool.name) || typeof tool.description !== 'string' || !isRecord(tool.inputSchema)) throw invalidRequest();
      names.add(tool.name);
    }
  }
  try { if (Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES) throw invalidRequest(); }
  catch (error) { if (error instanceof ValidationError) throw error; throw invalidRequest(); }
  return JSON.parse(JSON.stringify(request));
}

function normalizeResponse(response) {
  if (!isRecord(response)) throw invalidResponse();
  if ((response.type === 'final' || response.type === 'message') && typeof response.content === 'string' && response.content.length <= 1024 * 1024) return { type: 'final', content: response.content };
  if (response.type === 'tool_call') {
    let tool = response.tool; let args = response.arguments;
    if (Array.isArray(response.toolCalls) && response.toolCalls.length === 1) { tool = response.toolCalls[0]?.name; args = response.toolCalls[0]?.arguments; }
    if (typeof tool === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(tool) && isRecord(args)) {
      try { if (Buffer.byteLength(JSON.stringify(args)) <= 64 * 1024) return { type: 'tool_call', tool, arguments: JSON.parse(JSON.stringify(args)) }; } catch {}
    }
  }
  throw invalidResponse();
}

class LLMClient {
  constructor({ provider, config }) { if (!provider || typeof provider.generate !== 'function') throw new TypeError('provider.generate is required'); this.provider = provider; this.config = config; }
  async generate(request, { timeoutMs, onEvent, reserveCall } = {}) {
    if (!this.config.apiKey && !this.provider.isMock) throw new ConfigurationError('AI_API_KEY is required for model requests', 'missing_api_key');
    const normalized = normalizeRequest(request);
    reserveCall?.();
    const budget = Math.max(1, Math.min(timeoutMs ?? this.config.llmTimeoutMs ?? 30000, this.config.llmTimeoutMs ?? 30000));
    const deadline = Date.now() + budget;
    const maxRetries = this.provider.isMock ? 0 : (this.config.llmMaxRetries ?? 0);
    for (let attempt = 1; ; attempt++) {
      onEvent?.({ type: 'attempt', attempt });
      try {
        const response = await invokeWithTimeout(this.provider, normalized, {
          model: this.config.llmModel || this.config.model,
          endpoint: this.config.llmEndpoint || undefined,
          temperature: this.config.temperature,
          maxTokens: this.config.maxTokens,
          apiKey: this.config.apiKey,
          timeoutMs: Math.max(1, deadline - Date.now())
        }, Math.max(1, deadline - Date.now()));
        const result = normalizeResponse(response);
        onEvent?.({ type: 'success', attempt });
        return result;
      } catch (error) {
        const code = error.code || 'provider_request_error';
        if (code === 'provider_timeout') onEvent?.({ type: 'timeout', attempt, code });
        const retryable = isTransient(error);
        if (retryable && attempt <= maxRetries && Date.now() < deadline) {
          onEvent?.({ type: 'retry', attempt, code: safeCode(error) });
          continue;
        }
        onEvent?.({ type: 'failure', attempt, code: safeCode(error) });
        throw safeProviderError(error, this.config.apiKey, retryable && attempt > maxRetries ? 'llm_retry_exhausted' : undefined);
      }
    }
  }
}

function invokeWithTimeout(provider, request, options, ms) {
  const controller = new AbortController();
  const promise = Promise.resolve().then(() => provider.generate(request, { ...options, signal: controller.signal }));
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('LLM request timed out'), { code: 'provider_timeout' })); }, ms); })]).finally(() => clearTimeout(timer));
}
function isTransient(error) { const status = Number(error.status || error.statusCode); return error.retryable === true || TRANSIENT_CODES.has(error.code) || status === 429 || status >= 500; }
function safeCode(error) { const status = Number(error.status || error.statusCode); if (status === 401 || status === 403) return 'llm_authentication_error'; if (status === 429) return 'llm_rate_limit'; if (status >= 500 || TRANSIENT_CODES.has(error.code)) return 'llm_unavailable'; return error.code || 'provider_request_error'; }
function safeProviderError(error, apiKey, overrideCode) {
  const code = overrideCode || safeCode(error);
  const message = code === 'llm_authentication_error' ? 'LLM provider authentication failed.' : code === 'llm_rate_limit' ? 'LLM provider rate limit reached.' : code === 'llm_unavailable' || code === 'llm_retry_exhausted' ? 'LLM provider is temporarily unavailable.' : code === 'provider_timeout' ? 'LLM request timed out.' : code === 'invalid_llm_response' ? error.message : 'LLM provider request failed.';
  const hadSecret = apiKey && String(error.message || '').includes(apiKey);
  const safe = new Error(`${message}${hadSecret ? ' [REDACTED]' : ''}`); safe.name = 'LLMError'; safe.code = code; return safe;
}
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function invalidRequest() { const error = new ValidationError('LLM request is malformed or exceeds size limits'); error.code = 'invalid_llm_request'; return error; }
function invalidResponse() { const error = new ValidationError('LLM response must be a supported message or tool call'); error.code = 'invalid_llm_response'; return error; }
module.exports = { LLMClient, normalizeRequest, normalizeResponse, isTransient };
