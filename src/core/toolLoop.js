const { createHash } = require('node:crypto');
const { validateArguments } = require('./schemaValidation');
class ToolLoop {
  constructor({ llm, toolRegistry, config, logger, state, startedAt }) { this.llm = llm; this.toolRegistry = toolRegistry; this.config = config; this.logger = logger; this.state = state; this.startedAt = startedAt; this.toolCount = 0; }
  async run({ agent, systemPrompt, tools: names, input, deadline = Infinity, isActive = () => true }) {
    const allowed = new Set(names); const toolDefinitions = this.toolRegistry.list().filter(tool => allowed.has(tool.name));
    const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: JSON.stringify(input) }];
    const artifacts = [];
    for (let step = 0; step < this.config.maxAgentSteps; step++) {
      if(!isActive())throw Object.assign(new Error('Step execution lease expired.'),{code:'TIMEOUT'});
      const remaining = Math.min(this.config.maxExecutionTimeMs - (Date.now() - this.startedAt),deadline-Date.now());
      if (remaining <= 0) throw new Error('Maximum execution time reached');
      this.logger?.info(agent.toUpperCase(), 'Agent reasoning', { step: step + 1 });
      const response = await withTimeout(this.llm.generate({ messages: messages.map(message => ({ ...message })), tools: toolDefinitions }, { timeoutMs: remaining, onEvent: event => this.state?.recordLLMEvent(event), reserveCall: () => this.state?.reserveLLMCall(this.config.maxLLMCalls ?? Infinity) }), remaining, 'LLM request timed out');
      if(!isActive())throw Object.assign(new Error('Step execution lease expired.'),{code:'TIMEOUT'});
      if (response.type === 'final') return { content: response.content, toolResults: artifacts };
      const calls = response.type === 'tool_calls' ? response.toolCalls : [{ id: response.toolCallId, name: response.tool, arguments: response.arguments }];
      if (!Array.isArray(calls) || !calls.length) throw Object.assign(new Error('Provider returned no tool calls.'), { code: 'invalid_llm_response' });
      messages.push({ role: 'assistant', content: '', toolCalls: calls });
      for (const [index, current] of calls.entries()) {
        const toolName = current.name;
        const toolId = current.id || `local-${step + 1}-${index + 1}`;
        const args = current.arguments;
        const call = { agent, tool: toolName, arguments: args, step: step + 1, toolCallId: toolId };
        const stateCall = { agent, tool: toolName, arguments: safeArguments(args, this.llm?.config?.apiKey), step: step + 1, toolCallId: toolId };
        this.state.toolCalls.push(stateCall);
        if (++this.toolCount > this.config.maxToolCalls) throw Object.assign(new Error(`Maximum tool call limit reached (${this.config.maxToolCalls}).`), { code: 'RESOURCE_LIMIT', resource: 'tool_calls' });
        let result;
        const toolStartedAt = Date.now();
        try {
          const tool = this.toolRegistry.get(toolName);
          if (!tool) throw Object.assign(new Error(`Unknown tool: ${toolName}`), { code: 'UNKNOWN_TOOL' });
          if (!allowed.has(toolName)) throw Object.assign(new Error(`Tool not available to ${agent}: ${toolName}`), { code: 'PERMISSION_DENIED' });
          if (tool.permissions.some(permission => !this.config.allowedPermissions.includes(permission))) throw Object.assign(new Error('Tool permission denied'), { code: 'PERMISSION_DENIED' });
          validateArguments(tool.inputSchema, args);
          this.logger?.info('TOOL', `Executing ${tool.name}`, { agent });
          this.state?.record('tool_started', { agent, tool: tool.name });
          const data = await withTimeout(Promise.resolve().then(() => tool.execute(args)), Math.min(this.config.toolTimeoutMs, remaining), 'Tool execution timed out');
          if (!isActive()) throw Object.assign(new Error('Step execution lease expired.'), { code: 'TIMEOUT' });
          result = { success: true, tool: tool.name, data, error: null };
          if (tool.name === 'edit_file' || tool.name === 'create_file') {
            if (data.changed && !this.state.filesChanged.includes(data.path)) this.state.filesChanged.push(data.path);
            if (data.changed) this.state.actualChanges.push({ path: data.path, operation: tool.name === 'edit_file' ? 'modify' : 'create', tool: tool.name, succeeded: true, beforeExists: tool.name === 'edit_file', afterExists: true, beforeHash: data.beforeHash || null, afterHash: data.afterHash || null, diff: data.diff || null });
          }
          if (tool.name === 'run_tests') {
            const secret = this.llm?.config?.apiKey; const run = { attempt: this.state.testRuns.length + 1, startedAt: data.startedAt || new Date(toolStartedAt).toISOString(), endedAt: data.endedAt || new Date().toISOString(), durationMs: data.durationMs ?? Date.now() - toolStartedAt, ...data };
            const safeRun = { ...run, command: safeCommand(run.command, secret), stdout: safeText(run.stdout, secret), stderr: safeText(run.stderr, secret), ...(run.error ? { error: { ...run.error, message: safeText(run.error.message, secret) } } : {}) }; this.state.testRuns.push(safeRun);
            this.state.record('test_execution', { attempt: run.attempt, command: safeRun.command, durationMs: run.durationMs, exitCode: run.exitCode, success: run.success, timedOut: Boolean(run.timedOut), stdout: safeRun.stdout, stderr: safeRun.stderr });
          }
          this.state?.record('tool_finished', { agent, tool: tool.name, durationMs: Date.now() - toolStartedAt, success: true });
        } catch (error) {
          if (error.code === 'RESOURCE_LIMIT') throw error;
          result = { success: false, tool: toolName, data: null, error: { code: error.code || error.name || 'TOOL_ERROR', message: error.message } };
          this.state?.record('tool_finished', { agent, tool: toolName, durationMs: Date.now() - toolStartedAt, success: false, code: result.error.code });
        }
        if (!isActive()) throw Object.assign(new Error('Step execution lease expired.'), { code: 'TIMEOUT' });
        const hash = createHash('sha256').update(JSON.stringify(result)).digest('hex'); call.resultHash = hash; stateCall.resultHash = hash;
        if (!this.state.toolResults.some(item => item.hash === hash)) this.state.toolResults.push({ hash, ...safeResult(result, this.llm?.config?.apiKey) });
        this.state.record('tool_result', { agent, ...safeResult(result, this.llm?.config?.apiKey), resultHash: hash });
        artifacts.push({ ...result, toolCallId: toolId, arguments: safeArguments(args, this.llm?.config?.apiKey) });
        messages.push({ role: 'tool', tool_call_id: toolId, content: JSON.stringify(redactResult(result, this.llm?.config?.apiKey)) });
      }
    }
    throw Object.assign(new Error(`${agent} exceeded maximum agent steps (${this.config.maxAgentSteps}).`),{code:'RESOURCE_LIMIT',resource:'agent_steps'});
  }
}
function withTimeout(promise, ms, message) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.reject(Object.assign(new Error(message), { code: 'TIMEOUT' }));
  let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(message), { code: 'TIMEOUT' })), ms); })]).finally(() => clearTimeout(timer));
}
function safeArguments(args,secret=''){if(!args||typeof args!=='object'||Array.isArray(args))return{};const safe={};for(const [key,value] of Object.entries(args)){if(['content','oldText','newText'].includes(key)&&typeof value==='string'){safe[key]={bytes:Buffer.byteLength(value),sha256:createHash('sha256').update(value).digest('hex')};}else if(typeof value==='string')safe[key]=safeText(value,secret).slice(0,500);else if(Array.isArray(value))safe[key]=value.slice(0,20).map(item=>typeof item==='string'?safeText(item,secret).slice(0,500):item);else if(value&&typeof value==='object')safe[key]='[object]';else safe[key]=value;}return safe;}
function safeResult(result,secret=''){const out={...result};if(typeof out.data==='string'&&['read_file','git_diff','git_status'].includes(out.tool))out.data={bytes:Buffer.byteLength(out.data),sha256:createHash('sha256').update(out.data).digest('hex')};else if(out.tool==='run_tests'&&out.data){out.data={...out.data,command:safeCommand(out.data.command,secret),stdout:safeText(out.data.stdout,secret),stderr:safeText(out.data.stderr,secret),...(out.data.error?{error:{...out.data.error,message:safeText(out.data.error.message,secret)}}:{})};}if(out.error?.message)out.error={...out.error,message:safeText(out.error.message,secret)};return out;}
function safeText(value,secret=''){let text=String(value||'');if(secret)text=text.split(secret).join('[REDACTED]');return text.slice(0,4000);}
function safeCommand(command,secret=''){return Array.isArray(command)?command.slice(0,64).map(value=>safeText(value,secret).slice(0,1000)):null;}
function redactResult(value,secret=''){if(!secret)return value;if(typeof value==='string')return value.split(secret).join('[REDACTED]');if(Array.isArray(value))return value.map(item=>redactResult(item,secret));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,redactResult(item,secret)]));return value;}
module.exports = { ToolLoop, withTimeout };
