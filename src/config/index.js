const path = require('node:path');
const fs = require('node:fs');
const { ConfigurationError } = require('../utils/errors');
function loadConfig(env = process.env) {
  const retries = Number(env.RETRY_LIMIT ?? 2);
  const temperature = Number(env.MODEL_TEMPERATURE ?? 0.2);
  const maxTokens = Number(env.MAX_TOKENS ?? 2048);
  const maxAgentSteps = Number(env.MAX_AGENT_STEPS ?? 12);
  const maxToolCalls = Number(env.MAX_TOOL_CALLS ?? 8);
  const maxLLMCalls = Number(env.MAX_LLM_CALLS ?? 100);
  const maxExecutionTimeMs = Number(env.MAX_EXECUTION_TIME_MS ?? 120000);
  const commandTimeoutMs = Number(env.COMMAND_TIMEOUT_MS ?? 10000);
  const maxCommandOutputBytes = Number(env.MAX_COMMAND_OUTPUT_BYTES ?? 100000);
  const maxFixAttempts = Number(env.MAX_FIX_ATTEMPTS ?? 3);
  const maxAgentRetries = Number(env.MAX_AGENT_RETRIES ?? 1);
  const maxPlanSteps = Number(env.MAX_PLAN_STEPS ?? 12);
  const maxConcurrency = Number(env.MAX_CONCURRENCY ?? 2);
  const stepTimeoutMs = Number(env.STEP_TIMEOUT_MS ?? 60000);
  const llmTimeoutMs = Number(env.LLM_TIMEOUT_MS ?? 30000);
  const llmMaxRetries = Number(env.LLM_MAX_RETRIES ?? env.RETRY_LIMIT ?? 2);
  let testCommand = null;
  if (env.TEST_COMMAND) { try { testCommand = JSON.parse(env.TEST_COMMAND); } catch { throw new ConfigurationError('TEST_COMMAND must be a JSON string array'); }
    if (!Array.isArray(testCommand) || testCommand.length < 1 || testCommand.some(part => typeof part !== 'string' || !part)) throw new ConfigurationError('TEST_COMMAND must be a non-empty JSON string array'); }

  boundedInteger('RETRY_LIMIT', retries, 0, 20);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new ConfigurationError('MODEL_TEMPERATURE must be between 0 and 2');
  boundedInteger('MAX_TOKENS', maxTokens, 1, 100000);
  boundedInteger('MAX_AGENT_STEPS', maxAgentSteps, 1, 100);
  boundedInteger('MAX_TOOL_CALLS', maxToolCalls, 0, 500);
  boundedInteger('MAX_LLM_CALLS', maxLLMCalls, 1, 1000);
  boundedInteger('MAX_EXECUTION_TIME_MS', maxExecutionTimeMs, 1, 3600000);
  boundedInteger('COMMAND_TIMEOUT_MS', commandTimeoutMs, 1, 600000);
  boundedInteger('MAX_COMMAND_OUTPUT_BYTES', maxCommandOutputBytes, 1, 10 * 1024 * 1024);
  boundedInteger('MAX_FIX_ATTEMPTS', maxFixAttempts, 0, 10);
  boundedInteger('MAX_AGENT_RETRIES', maxAgentRetries, 0, 10);
  boundedInteger('MAX_PLAN_STEPS', maxPlanSteps, 1, 100);
  boundedInteger('MAX_CONCURRENCY', maxConcurrency, 1, 8);
  boundedInteger('STEP_TIMEOUT_MS', stepTimeoutMs, 1, 3600000);
  boundedInteger('LLM_TIMEOUT_MS', llmTimeoutMs, 1, 300000);
  boundedInteger('LLM_MAX_RETRIES', llmMaxRetries, 0, 10);
  const llmEndpoint = env.LLM_ENDPOINT || '';
  if (llmEndpoint.length > 2048 || /[\u0000-\u001f]/.test(llmEndpoint)) throw new ConfigurationError('LLM_ENDPOINT must be a valid text value no longer than 2048 characters');
  const llmModel = env.LLM_MODEL ?? env.MODEL_NAME ?? '';
  if (typeof llmModel !== 'string' || llmModel.length > 256 || /[\u0000-\u001f]/.test(llmModel)) throw new ConfigurationError('LLM_MODEL must be a text value no longer than 256 characters');
  const workspaceRoot = path.resolve(env.WORKSPACE_ROOT || process.cwd());
  try { if (!fs.statSync(workspaceRoot).isDirectory()) throw new Error(); }
  catch { throw new ConfigurationError('WORKSPACE_ROOT must point to an existing directory'); }
  return Object.freeze({ providerModule: env.LLM_PROVIDER_MODULE || '', llmModel, model: llmModel || 'unspecified', llmEndpoint, llmTimeoutMs, llmMaxRetries, testCommand, maxFixAttempts, maxAgentRetries, maxPlanSteps, maxConcurrency, stepTimeoutMs, maxAgentSteps, maxToolCalls, maxLLMCalls, maxExecutionTimeMs, apiKey: env.AI_API_KEY || '', temperature, maxTokens, retryLimit: retries, workspaceRoot, allowedCommands: (env.ALLOWED_COMMANDS || '').split(',').map(x => x.trim()).filter(Boolean), commandTimeoutMs, maxCommandOutputBytes });
}
function boundedInteger(name, value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new ConfigurationError(`${name} must be an integer from ${min} through ${max}`); }
module.exports = { loadConfig };
