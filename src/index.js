const readline = require('node:readline');
const { stdin, stdout } = require('node:process');
const { loadConfig } = require('./config');
const { Logger } = require('./utils/logger');
const { ToolRegistry } = require('./core/toolRegistry');
const { Orchestrator } = require('./core/orchestrator');
const { LLMClient } = require('./llm/client');
const { loadProvider } = require('./llm/provider');
const { createFileTools } = require('./tools/fileTools');
const { createSearchTool } = require('./tools/searchTools');
const { createGitTools } = require('./tools/gitTools');
const { createEditTools } = require('./tools/editTools');
const { createRunTestsTool } = require('./tools/testTools');
const { AgentRegistry } = require('./core/agentRegistry');
const { createCoreAgents } = require('./agents/llmAgents');
const { ConfigurationError } = require('./utils/errors');
async function buildOrchestrator(config, logger = new Logger()) {
  const providerFactory = loadProvider(config.providerModule);
  let provider;
  try { provider = await providerFactory(config); }
  catch { const error = new Error('The configured LLM provider could not be initialized.'); error.name = 'LLMError'; error.code = 'provider_initialization_error'; throw error; }
  if (!provider || typeof provider.generate !== 'function') { const error = new Error('LLM provider must implement generate(request, options).'); error.name = 'LLMError'; error.code = 'provider_interface_error'; throw error; }
  const tools = new ToolRegistry();
  [...createFileTools(config), createSearchTool(config), ...createGitTools(config), ...createEditTools(config), createRunTestsTool({ workspaceRoot: config.workspaceRoot, testCommand: config.testCommand, timeoutMs: config.commandTimeoutMs, maxOutputBytes: config.maxCommandOutputBytes })].forEach(tool => tools.register(tool));
  const agents = new AgentRegistry(); createCoreAgents().forEach(agent => agents.register(agent));
  return new Orchestrator({ logger, llm: new LLMClient({ provider, config }), toolRegistry: tools, agentRegistry: agents, config });
}
async function main() {
  const config = loadConfig(); const logger = new Logger();
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    stdout.write('AI Harness\nEnter a software engineering issue:\n> ');
    const issue = await readIssue(rl); if (!issue.trim()) throw Object.assign(new Error('Issue must be a non-empty string.'),{code:'INVALID_INPUT'}); if(Buffer.byteLength(issue,'utf8')>10000)throw Object.assign(new Error('Issue exceeds the 10000-byte limit.'),{code:'INVALID_INPUT'});
    const orchestrator = await buildOrchestrator(config, logger);
    const result = await orchestrator.run(issue); stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!['verified','completed'].includes(result.status)) process.exitCode = 1;
  } finally { rl.close(); }
}
function readIssue(rl){return new Promise(resolve=>{let settled=false;const finish=value=>{if(settled)return;settled=true;rl.removeListener('close',onClose);resolve(value);};const onClose=()=>finish('');rl.once('close',onClose);rl.question('',answer=>finish(answer));});}
function formatCliError(error, apiKey = process.env.AI_API_KEY || '') {
  let message = String(error?.message || 'Harness could not start');
  if (apiKey) message = message.split(apiKey).join('[REDACTED]');
  const configurationError = error?.name === 'ConfigurationError' || ['provider_not_configured','missing_api_key'].includes(error?.code) || /WORKSPACE_ROOT|TEST_COMMAND/i.test(message);
  const outcome=error?.code==='INVALID_INPUT'?'invalid_input':configurationError?'configuration_error':error?.code==='RESOURCE_LIMIT'?'resource_limit':error?.code==='TIMEOUT'?'timeout':'failure';
  return `${JSON.stringify({ status: outcome==='invalid_input'?'invalid_input':'failed', outcome, error: { code: error?.code || error?.name || 'STARTUP_ERROR', message } })}\n`;
}
if (require.main === module) main().catch(error => { process.stderr.write(formatCliError(error)); process.exitCode = 1; });
module.exports = { main, buildOrchestrator, formatCliError, readIssue };
