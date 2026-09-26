const { randomUUID } = require('node:crypto');
const STATUSES = new Set(['created', 'validating', 'planning', 'in_progress', 'reviewing', 'verifying', 'completed', 'failed', 'verified', 'failed_verification', 'planning_failed', 'invalid_input', 'resource_limit']);
class TaskState {
  constructor(issue, id = randomUUID()) {
    Object.assign(this, { id, issue: typeof issue === 'string' ? issue.slice(0, 10000) : '', status: 'created', stage: 'input', goal: null, plan: [], planningError: null, schedulerResult: null, agentResults: [], subtasks: [], activeAgents: [], completedAgents: [], failedAgents: [], findings: [], relevantFiles: [], proposedChanges: [], actualChanges: [], testResults: [], errors: [], reviewResults: [], verification: { status: 'pending', details: null }, executionHistory: [], eventsDropped: 0, messages: [], toolCalls: [], toolResults: [], filesChanged: [], testRuns: [], recoveryAttempts: 0, recoveryHistory: [], stepExecutions: [], unexpectedFiles: [], finalResponse: null, llmActivity: { providerConfigured: false, model: 'unspecified', logicalCalls: 0, requestAttempts: 0, retries: 0, timeouts: 0, lastError: null } });
  }
  setStatus(status) { if (!STATUSES.has(status)) throw new TypeError(`Invalid task status: ${status}`); this.status = status; }
  record(event, details = {}) { if(this.executionHistory.length>=5000){this.eventsDropped++;return;}this.executionHistory.push({ timestamp: new Date().toISOString(), event, details }); }
  setStage(stage, event = stage, details = {}) { this.stage = stage; this.record(event, details); }
  reserveLLMCall(limit = Infinity) {
      if (this.llmActivity.logicalCalls >= limit) throw Object.assign(new Error(`Maximum LLM call limit reached (${limit}).`), { code: 'RESOURCE_LIMIT', resource: 'llm_calls' });
    this.llmActivity.logicalCalls++;
  }
  recordStep(stepId, status, details = {}) {
    const attempt=details.attempt??1;const current = this.stepExecutions.find(item => item.stepId === stepId && item.attempt === attempt);
    if (current) Object.assign(current, { status, ...details });
    else this.stepExecutions.push({ stepId, attempt, status, ...details });
  }
  recordLLMEvent(event) {
    if (event.type === 'attempt') this.llmActivity.requestAttempts++;
    if (event.type === 'retry') this.llmActivity.retries++;
    if (event.type === 'timeout') this.llmActivity.timeouts++;
    if (event.type === 'failure') this.llmActivity.lastError = event.code || 'llm_error';
    if (event.type === 'success') this.llmActivity.lastError = null;
    this.record(`llm_${event.type}`, { attempt: event.attempt, code: event.code });
  }
  toJSON() {
    const outcome = this.workflowOutcome();
    const summary = {
      task: this.issue,
      taskType: this.taskType || 'unclassified',
      status: this.status,
      outcome,
      selectedAgents: [...new Set(this.plan.map(step => step.agent))],
      agentsRun: [...new Set([...this.completedAgents,...this.failedAgents])],
      selectedPlan: this.plan.map(({ id, agent, task, dependsOn, status, blockedBy, error }) => ({ id, agent, task: String(task || '').slice(0, 500), dependsOn, status, ...(blockedBy ? { blockedBy } : {}), ...(error ? { error: { code: error.code } } : {}) })),
      completedSteps: this.plan.filter(step => step.status === 'succeeded').map(step => step.id),
      failedSteps: this.plan.filter(step => ['failed', 'timed_out'].includes(step.status)).map(step => step.id),
      blockedSteps: this.plan.filter(step => ['blocked', 'skipped'].includes(step.status)).map(step => ({ id: step.id, blockedBy: step.blockedBy || [] })),
      changedFiles: [...this.filesChanged],
      changeEvidence: this.actualChanges,
      testResults: this.testResults,
      testEvidence: this.testRuns.map(({attempt,command,startedAt,endedAt,durationMs,exitCode,success,timedOut,stdout,stderr})=>({attempt,command,startedAt,endedAt,durationMs,exitCode,success,timedOut:Boolean(timedOut),stdout:String(stdout||'').slice(0,4000),stderr:String(stderr||'').slice(0,4000)})),
      recoveryAttempts: this.recoveryAttempts,
      recoveryHistory: this.recoveryHistory,
      reviewResult: this.reviewResults.at(-1) || null,
      verification: this.verification,
      llmActivity: this.llmActivity,
      eventsDropped: this.eventsDropped,
      outcomeReason: this.outcomeReason || null
    };
    return JSON.parse(JSON.stringify({ ...this, outcome, summary }));
  }
  workflowOutcome() {
    if (this.status === 'verified' || this.status === 'completed' && this.verification?.status === 'passed') return 'success';
    if (this.status === 'invalid_input') return 'invalid_input';
    if (this.status === 'resource_limit') return 'resource_limit';
    if (['ConfigurationError', 'provider_not_configured', 'missing_api_key', 'missing_llm_model', 'missing_llm_endpoint', 'invalid_llm_endpoint', 'llm_invalid_endpoint_or_model', 'unsupported_thinking_mode', 'fetch_unavailable', 'provider_load_error', 'provider_interface_error', 'CONFIGURATION_ERROR', 'configuration_error'].includes(this.planningError?.code)) return 'configuration_error';
    if (this.planningError?.code === 'RESOURCE_LIMIT' || this.errors.some(error=>error.code==='RESOURCE_LIMIT')) return 'resource_limit';
    if (this.errors.some(error=>error.code==='TIMEOUT'||error.code==='TASK_TIMEOUT') || this.planningError?.code==='provider_timeout') return 'timeout';
    if (this.status === 'failed_verification') return 'verification_failed';
    if (this.schedulerResult?.timedOutSteps?.length) return 'timeout';
    if (this.schedulerResult?.successfulSteps?.length && this.schedulerResult?.failedSteps?.length) return 'partial_failure';
    if (this.schedulerResult?.blockedSteps?.length && !this.schedulerResult?.successfulSteps?.length) return 'blocked';
    if (this.schedulerResult?.failedSteps?.length) return 'failure';
    if (this.status === 'planning_failed' && /timed out/i.test(this.planningError?.message || '')) return 'timeout';
    return this.status === 'created' || this.status === 'planning' || this.status === 'in_progress' ? 'in_progress' : 'failure';
  }
}
module.exports = { TaskState, STATUSES };
