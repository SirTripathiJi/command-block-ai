const { TaskState } = require('./taskState');
const { ToolLoop } = require('./toolLoop');
const { TaskPlanner } = require('./taskPlanner');
const { ContextManager } = require('./contextManager');
const { ExecutionEngine } = require('./executionEngine');
const { createCoreAgents } = require('../agents/llmAgents');
const { AgentRegistry } = require('./agentRegistry');
const { validatePlan } = require('./taskPlanner');
const { createHash } = require('node:crypto');
class Orchestrator {
  constructor({ logger, llm, toolRegistry, agentRegistry, planner, contextManager, executionEngine, config = {} } = {}) {
    this.logger=logger; this.llm=llm; this.toolRegistry=toolRegistry; this.agentRegistry=agentRegistry;
    if(!this.agentRegistry){this.agentRegistry=new AgentRegistry();createCoreAgents().forEach(agent=>this.agentRegistry.register(agent));}
    this.config={maxAgentSteps:config.maxAgentSteps??12,maxToolCalls:config.maxToolCalls??20,maxLLMCalls:config.maxLLMCalls??100,maxExecutionTimeMs:config.maxExecutionTimeMs??120000,toolTimeoutMs:config.toolTimeoutMs??15000,commandTimeoutMs:config.commandTimeoutMs??10000,maxCommandOutputBytes:config.maxCommandOutputBytes??100000,maxFixAttempts:config.maxFixAttempts??3,maxAgentRetries:config.maxAgentRetries??1,maxPlanSteps:config.maxPlanSteps??12,maxConcurrency:config.maxConcurrency??2,stepTimeoutMs:config.stepTimeoutMs??60000,workspaceRoot:config.workspaceRoot,allowedPermissions:config.allowedPermissions??['filesystem:read','filesystem:write','git:read','process:test']};
    this.idempotency=new Map();
    this.planner=planner||new TaskPlanner({llm,maxSteps:this.config.maxPlanSteps,maxExecutionTimeMs:this.config.maxExecutionTimeMs,allowedPermissions:this.config.allowedPermissions});
    this.contextManager=contextManager||new ContextManager();this.executionEngine=executionEngine||new ExecutionEngine({agentRegistry:this.agentRegistry,toolRegistry:this.toolRegistry,logger});
  }
  async run(issue,{idempotencyKey}={}) {
    if(typeof idempotencyKey==='string'&&idempotencyKey.trim()){
      const key=createHash('sha256').update(idempotencyKey).digest('hex');
      if(this.idempotency.has(key)){const replay=JSON.parse(JSON.stringify(await this.idempotency.get(key)));replay.idempotentReplay=true;if(replay.summary)replay.summary.idempotentReplay=true;return replay;}
      const pending=this.runTask(issue);this.idempotency.set(key,pending);
      try{const result=await pending;this.idempotency.set(key,Promise.resolve(result));while(this.idempotency.size>50)this.idempotency.delete(this.idempotency.keys().next().value);return result;}
      catch(error){this.idempotency.delete(key);throw error;}
    }
    return this.runTask(issue);
  }
  async runTask(issue) {
    const safeIssue=safeText(issue,this.llm?.config?.apiKey);const state=new TaskState(safeIssue); state.status='validating'; state.verification.status='pending';
    const startedAt=Date.now(); const loop=new ToolLoop({llm:this.llm,toolRegistry:this.toolRegistry,config:this.config,logger:this.logger,state,startedAt});
    state.llmActivity.providerConfigured=Boolean(this.llm?.provider&&!this.llm.provider.isMock || this.llm?.provider?.isMock); state.llmActivity.model=this.llm?.config?.llmModel||this.llm?.config?.model||'unspecified';
    this.logger?.info('ORCHESTRATOR','Analyzing issue'); state.setStage('validating','task_started',{issueLength:state.issue.length});
    const invalidReason=await this.validateTask(issue);
    if(invalidReason){state.status=invalidReason.code==='CONFIGURATION_ERROR'?'planning_failed':'invalid_input';state.stage='final';state.planningError={code:invalidReason.code,message:invalidReason.message};state.errors.push(state.planningError);state.outcomeReason=invalidReason.message;state.verification={status:'not_run',details:'Input validation failed; no work was started.'};state.record('task_validation_failed',state.planningError);return state.toJSON();}
    state.setStage('planning','task_validated');
    state.taskType=classifyTaskType(safeIssue);
    let plan;
    try {
      const agents=this.agentRegistry.list();
      this.logger?.info('PLANNER','Discovering available agents',{agents:agents.map(agent=>agent.name)});
      const plannerBudget=this.config.maxExecutionTimeMs-(Date.now()-startedAt);if(plannerBudget<=0)throw Object.assign(new Error('Task execution budget expired before planning.'),{code:'TIMEOUT'});
      plan=await this.planner.createPlan(safeIssue,agents,this.toolRegistry,{onLLMEvent:event=>state.recordLLMEvent(event),reserveCall:()=>state.reserveLLMCall(this.config.maxLLMCalls),timeoutMs:plannerBudget});
      plan=validatePlan(plan,agents,this.toolRegistry,{maxSteps:this.config.maxPlanSteps,allowedPermissions:this.config.allowedPermissions});
      plan=validatePlan(sanitizePlan(plan,this.llm?.config?.apiKey),agents,this.toolRegistry,{maxSteps:this.config.maxPlanSteps,allowedPermissions:this.config.allowedPermissions});
    } catch(error) {
      state.status='planning_failed'; state.stage='final'; state.planningError={code:error.code||error.name||'PLAN_REJECTED',message:error.message}; state.errors.push(state.planningError); state.verification={status:'blocked',details:'No plan was executed.'}; state.outcomeReason='Plan failed runtime validation or planning.'; state.record('plan_rejected',{code:state.planningError.code,message:state.planningError.message});state.record('planning_failed',state.planningError); return state.toJSON();
    }
    state.plan=plan.steps.map(step=>({...step,status:'pending'})); state.goal=plan.goal;
    this.logger?.info('PLANNER','Selected agents',{agents:[...new Set(plan.steps.map(step=>step.agent))]});this.logger?.info('PLANNER','Execution plan created',{goal:plan.goal,steps:plan.steps.map(step=>({id:step.id,agent:step.agent,dependsOn:step.dependsOn}))});
    state.setStage('execution','plan_created',{goal:plan.goal,steps:plan.steps.map(step=>({id:step.id,agent:step.agent,dependsOn:step.dependsOn}))});state.record('plan_validated',{stepCount:plan.steps.length});this.logger?.info('PLANNER','Plan validated',{stepCount:plan.steps.length});state.status='in_progress'; state.verification.status='running';
    const baseline=await this.readGitStatus();
    try {
      const remainingBudget=this.config.maxExecutionTimeMs-(Date.now()-startedAt);if(remainingBudget<=0)throw Object.assign(new Error('Task execution budget expired before step execution.'),{code:'TIMEOUT'});
      const schedulerResult=await this.executionEngine.executePlan(plan,{maxConcurrency:this.config.maxConcurrency,maxExecutionTimeMs:remainingBudget,stepTimeoutMs:this.config.stepTimeoutMs,maxPlanSteps:this.config.maxPlanSteps,onTransition:event=>this.recordSchedulerTransition(state,event),executeStep:async(step,{results,lease})=>{
        const context=this.contextManager.build({issue:safeIssue,step,dependencyResults:this.dependencyResults(step,plan,results),state});
        const result=await this.runAgentWithRetries(step,context,loop,state,lease);this.storeAgentResult(state,result);
        if(result.status!=='completed')throw Object.assign(new Error(`Agent ${step.agent} returned ${result.status}`),{code:'AGENT_FAILED'});
        if(step.agent==='qa'){const qaStatus=await this.assessQA(step,result,context,plan,loop,state,results,lease);if(!qaStatus)throw Object.assign(new Error('Verification failed after bounded recovery.'),{code:'VERIFICATION_FAILED'});return [...state.agentResults].reverse().find(item=>item.agent==='qa')||result;}
        return result;
      }});
      state.schedulerResult=safeSchedulerResult(schedulerResult,this.llm?.config?.apiKey);
      if(schedulerResult.status!=='succeeded'){
        const verificationFailure=schedulerResult.steps.some(step=>step.error?.code==='VERIFICATION_FAILED');
        const resourceLimit=schedulerResult.steps.some(step=>step.error?.code==='RESOURCE_LIMIT');
        const failure={code:verificationFailure?'VERIFICATION_FAILED':resourceLimit?'RESOURCE_LIMIT':schedulerResult.timedOutSteps.length?'TIMEOUT':'STEP_FAILED',message:`Workflow ${schedulerResult.status}; timed out steps: ${schedulerResult.timedOutSteps.join(', ')||'none'}; failed steps: ${schedulerResult.failedSteps.join(', ')||'none'}; blocked steps: ${schedulerResult.blockedSteps.map(item=>item.stepId).join(', ')||'none'}. ${schedulerResult.steps.filter(item=>item.error?.message).map(item=>`${item.stepId}: ${item.error.message}`).join('; ')} ${state.errors.map(error=>error.message).filter(Boolean).join('; ')}`};
        state.errors.push(failure);state.record('workflow_failed',{...failure,schedulerResult});
        state.status=verificationFailure?'failed_verification':resourceLimit?'resource_limit':'failed';state.stage='final';state.outcomeReason=failure.message;state.verification={status:verificationFailure?'failed':'blocked',details:state.schedulerResult};return state.toJSON();
      }
      const hasDeveloper=plan.steps.some(step=>step.agent==='developer');
      if(hasDeveloper) {
        state.status='verifying';state.setStage('verification','verification_started');
        const verified=await this.finalVerify(baseline,state);
        if(!verified) {state.status='failed_verification';state.stage='final';state.verification={status:'failed',details:state.verificationEvidence};const failure={code:'VERIFICATION_FAILED',message:'Final evidence did not satisfy change, test, review, repository, or workspace-cleanliness requirements.'};state.errors.push(failure);state.outcomeReason=failure.message;state.record('verification_finished',{status:'failed',evidence:state.verificationEvidence});state.record('verification_failed',failure);return state.toJSON();}
        state.status='verified'; state.verification={status:'passed',details:{testsPassed:true,reviewInspectedDiff:true,diffInspected:true,unexpectedFiles:state.unexpectedFiles}};
        state.stage='final';state.outcomeReason='Concrete file change evidence, passing executed tests, reviewer inspection, and fresh repository inspection support success.';state.record('verification_finished',{status:'passed',evidence:state.verification.details});
      } else {
        const after=await this.readGitStatus();const baselineSet=new Set(baseline);state.unexpectedFiles=after.filter(file=>!baselineSet.has(file)&&!state.filesChanged.includes(file));
        const reviewRequired=plan.steps.some(step=>step.agent==='reviewer');const review=state.reviewResults.at(-1);const reviewEvidence=!reviewRequired||review?.reviewOutcome==='reviewed';
        const noChangeEvidence=state.actualChanges.length===0&&state.filesChanged.length===0&&state.unexpectedFiles.length===0&&reviewEvidence;
        if(state.taskType==='code_change'||!noChangeEvidence){const reason=state.taskType==='code_change'?'The requested task implies a modification, but the validated plan had no Developer step.':state.unexpectedFiles.length?'Unexpected workspace modifications were observed.':'Required reviewer evidence was insufficient.';state.status='failed_verification';state.stage='final';state.verification={status:'failed',details:{type:'no_code_change',taskType:state.taskType,actualChanges:state.actualChanges.length,unexpectedFiles:state.unexpectedFiles,reviewOutcome:review?.reviewOutcome||null,reason}};state.outcomeReason='No-code-change evidence was insufficient for the requested task.';state.errors.push({code:'VERIFICATION_FAILED',message:reason});state.record('verification_finished',{status:'failed',evidence:state.verification.details});return state.toJSON();}
        state.status='completed';state.stage='final';state.verification={status:'passed',details:{type:'no_code_change',taskType:state.taskType,reason:'Task intent and the validated plan required no code modification; no file changes were observed.'}};state.outcomeReason='The validated task completed without code modification.';state.record('verification_finished',{status:'passed',evidence:state.verification.details});
      }
      const last=[...state.agentResults].reverse().find(result=>result.summary); state.finalResponse=last?.summary||`Completed plan: ${plan.goal}`; state.record('task_completed',{status:state.status,outcome:state.workflowOutcome()});
      this.logger?.info('VERIFIER',state.status==='verified'?'Task verified':'Plan completed',{status:state.status}); return state.toJSON();
    } catch(error) {
      if(error.code==='VERIFICATION_FAILED') {state.status='failed_verification';state.verification={status:'failed',details:state.testResults.at(-1)||error.message};return state.toJSON();}
      const code=error.code||error.name||'EXECUTION_ERROR';const message=safeText(error.message,this.llm?.config?.apiKey).slice(0,1000);
      state.status=code==='RESOURCE_LIMIT'?'resource_limit':'failed';state.stage='final';state.verification={status:'blocked',details:{code,message}};state.outcomeReason=message;state.errors.push({code,message});state.record('execution_failed',state.errors.at(-1));
      this.logger?.error('ORCHESTRATOR','Task failed',{code,message});return state.toJSON();
    }
  }
  async validateTask(issue) {
    if(typeof issue!=='string'||!issue.trim())return{code:'INVALID_INPUT',message:'Issue must be a non-empty string.'};
    if(Buffer.byteLength(issue,'utf8')>10000)return{code:'INVALID_INPUT',message:'Issue exceeds the 10000-byte limit.'};
    const bounds={maxAgentSteps:[1,100],maxToolCalls:[0,500],maxLLMCalls:[1,1000],maxExecutionTimeMs:[1,3600000],toolTimeoutMs:[1,600000],commandTimeoutMs:[1,600000],maxCommandOutputBytes:[1,10*1024*1024],maxFixAttempts:[0,10],maxAgentRetries:[0,10],maxPlanSteps:[1,100],maxConcurrency:[1,8],stepTimeoutMs:[1,3600000]};
    for(const [name,[min,max]] of Object.entries(bounds)){const value=this.config[name];if(!Number.isSafeInteger(value)||value<min||value>max)return{code:'CONFIGURATION_ERROR',message:`${name} must be an integer from ${min} through ${max}.`};}
    if(!Array.isArray(this.config.allowedPermissions)||this.config.allowedPermissions.some(item=>typeof item!=='string')||!this.toolRegistry||typeof this.toolRegistry.get!=='function'||!this.agentRegistry||typeof this.agentRegistry.list!=='function')return{code:'CONFIGURATION_ERROR',message:'Agent/tool registry or permission configuration is invalid.'};
    if(!this.planner||typeof this.planner.createPlan!=='function'||!this.llm&&this.planner instanceof TaskPlanner)return{code:'CONFIGURATION_ERROR',message:'Planner or LLM runtime configuration is invalid.'};
    const llmConfig=this.llm?.config;if(llmConfig){if(llmConfig.temperature!==undefined&&(!Number.isFinite(llmConfig.temperature)||llmConfig.temperature<0||llmConfig.temperature>2))return{code:'CONFIGURATION_ERROR',message:'LLM temperature is outside its configured bounds.'};if(llmConfig.maxTokens!==undefined&&(!Number.isSafeInteger(llmConfig.maxTokens)||llmConfig.maxTokens<1||llmConfig.maxTokens>100000))return{code:'CONFIGURATION_ERROR',message:'LLM token limit is outside its configured bounds.'};if(llmConfig.llmTimeoutMs!==undefined&&(!Number.isSafeInteger(llmConfig.llmTimeoutMs)||llmConfig.llmTimeoutMs<1||llmConfig.llmTimeoutMs>300000))return{code:'CONFIGURATION_ERROR',message:'LLM timeout is outside its configured bounds.'};if(llmConfig.llmMaxRetries!==undefined&&(!Number.isSafeInteger(llmConfig.llmMaxRetries)||llmConfig.llmMaxRetries<0||llmConfig.llmMaxRetries>10))return{code:'CONFIGURATION_ERROR',message:'LLM retry limit is outside its configured bounds.'};}
    if(this.config.workspaceRoot){try{const stat=require('node:fs').statSync(this.config.workspaceRoot);if(!stat.isDirectory())throw new Error();}catch{return{code:'CONFIGURATION_ERROR',message:'Workspace root must be an existing directory.'};}}
    return null;
  }
  recordSchedulerTransition(state,event){
    const error=event.error?{code:event.error.code||'STEP_FAILED',message:safeText(event.error.message,this.llm?.config?.apiKey).slice(0,1000)}:undefined;
    const item=state.plan.find(step=>step.id===event.stepId);if(item){item.status=event.status;if(event.blockedBy)item.blockedBy=event.blockedBy;if(error)item.error=error;}
    state.recordStep(event.stepId,event.status,{attempt:0,kind:'scheduler',agent:event.agent,blockedBy:event.blockedBy,error,startedAt:event.status==='running'?new Date().toISOString():undefined});
    if(event.status==='running'&&event.agent==='reviewer'){state.status='reviewing';state.setStage('review','review_started',{stepId:event.stepId});}
    if(event.status==='timed_out'){removeActiveAgent(state,event.agent);if(event.agent&&!state.failedAgents.includes(event.agent))state.failedAgents.push(event.agent);state.record('agent_failed',{agent:event.agent,stepId:event.stepId,code:error?.code||'TIMEOUT',message:error?.message});}
    const eventName={ready:'ready',running:'started',succeeded:'succeeded',failed:'failed',timed_out:'failed',blocked:'blocked'}[event.status]||event.status;
    state.record(`step_${eventName}`,{stepId:event.stepId,agent:event.agent,blockedBy:event.blockedBy,error,activeCount:event.activeCount});
    if(event.status==='succeeded'&&event.agent==='reviewer')state.record('review_finished',{stepId:event.stepId,outcome:state.reviewResults.at(-1)?.reviewOutcome||'insufficient_evidence'});
  }
  async runAgentWithRetries(step,input,loop,state,lease) {
    let attempt=0;
    while(true) {
      const currentAttempt=attempt+1;state.recordStep(step.id,'running',{attempt:currentAttempt,kind:'agent',agent:step.agent});
      try {const result=await this.runAgent(step,input,loop,state,lease);state.recordStep(step.id,'succeeded',{attempt:currentAttempt,kind:'agent',agent:step.agent});return result;}
      catch(error) {
        state.recordStep(step.id,'failed',{attempt:currentAttempt,kind:'agent',agent:step.agent,error:{code:error.code||error.name||'AGENT_FAILED',message:safeText(error.message,this.llm?.config?.apiKey).slice(0,1000)}});
        if(attempt>=this.config.maxAgentRetries) throw error;
        attempt++;state.record('agent_retry',{agent:step.agent,stepId:step.id,attempt,error:safeText(error.message,this.llm?.config?.apiKey).slice(0,1000)});
      }
    }
  }
  async runAgent(step,input,loop,state,lease={active:true,deadline:Infinity}) {
    const agent=this.agentRegistry.get(step.agent); if(!agent) throw new Error(`Required agent is not registered: ${step.agent}`);
    const apiInvestigations=input.apiInvestigations||[];const contextSummary={stepId:step.id,relevantFiles:input.relevantFiles||[],apiInvestigationCount:apiInvestigations.length,apiFindingCount:apiInvestigations.reduce((total,item)=>total+(item.findings||[]).length,0),relatedTestCount:apiInvestigations.reduce((total,item)=>total+(item.relatedTests||[]).length,0)};
    state.activeAgents.push(agent.name);this.logger?.info(agent.name.toUpperCase(),'Working',contextSummary);state.record('agent_context_prepared',{agent:agent.name,...contextSummary});state.record('agent_started',{agent:agent.name,stepId:step.id});
    try {
      const result=await agent.execute({...input,stepTask:step.task},{tools:step.tools,runToolLoop:options=>loop.run({...options,deadline:lease.deadline,isActive:()=>lease.active})});
      if(!lease.active)throw Object.assign(new Error('Step execution lease expired.'),{code:'TIMEOUT'});
      if(!result||result.agent!==agent.name||typeof result.status!=='string'||typeof result.summary!=='string') throw new Error(`Agent ${agent.name} returned an invalid result`);
      if(result.status!=='completed') throw Object.assign(new Error(safeText(result.error?.message||`Agent ${agent.name} returned ${result.status}`,this.llm?.config?.apiKey)),{code:'AGENT_FAILED'});
      removeActiveAgent(state,agent.name);state.completedAgents.push(agent.name);state.record('agent_completed',{agent:agent.name,stepId:step.id,status:result.status,summary:safeText(result.summary,this.llm?.config?.apiKey).slice(0,1000)});return result;
    } catch(error) {if(lease.active){removeActiveAgent(state,agent.name);state.failedAgents.push(agent.name);state.record('agent_failed',{agent:agent.name,stepId:step.id,message:safeText(error.message,this.llm?.config?.apiKey).slice(0,1000)});}throw error;}
  }
  storeAgentResult(state,result) {
    const stored=sanitizeAgentResult(result,this.llm?.config?.apiKey);if(state.agentResults.length<1200)state.agentResults.push(stored);
    const findingCapacity=Math.max(0,1000-state.findings.length);if(Array.isArray(stored.findings))state.findings.push(...stored.findings.slice(0,Math.min(100,findingCapacity)).map(finding=>({agent:result.agent,finding})));
    if(typeof stored.rootCause==='string'&&state.findings.length<1000)state.findings.push({agent:result.agent,rootCause:stored.rootCause});
    if(Array.isArray(stored.relevantFiles))for(const file of stored.relevantFiles.slice(0,100))if(typeof file==='string'&&state.relevantFiles.length<500&&!state.relevantFiles.includes(file))state.relevantFiles.push(file);
    if(result.agent==='investigator'&&stored.recommendedFix&&state.proposedChanges.length<100)state.proposedChanges.push(stored.recommendedFix);
    if(result.agent==='reviewer'){if(state.reviewResults.length>=50)state.reviewResults.shift();state.reviewResults.push(stored);}
  }
  async assessQA(step,result,input,plan,loop,state,completed,lease) {
    const lastTest=state.testRuns.at(-1);const passed=Boolean(lastTest?.success&&Number(lastTest.exitCode)===0);
    state.testResults.push({attempt:state.testRuns.length,passed,result:lastTest||null,summary:safeText(result.summary,this.llm?.config?.apiKey).slice(0,1000)});
    if(passed)return true;
    const developerStep=[...plan.steps].reverse().find(item=>item.agent==='developer');
    const qaStep=step;
    if(!developerStep||state.recoveryAttempts>=this.config.maxFixAttempts) {
      const reason=!developerStep?'No Developer step is available to recover the failing tests.':`recovery limit reached (${state.recoveryAttempts}/${this.config.maxFixAttempts}).`;
      state.recoveryHistory.push({attempt:state.recoveryAttempts+1,status:'exhausted',reason,testAttempt:lastTest?.attempt});state.errors.push({code:'VERIFICATION_FAILED',message:`Tests failed. ${reason}`});state.record('recovery_finished',{attempt:state.recoveryAttempts+1,status:'exhausted',reason,testAttempt:lastTest?.attempt});state.record('verification_failed',{testAttempt:lastTest?.attempt,recoveryAttempts:state.recoveryAttempts});return false;
    }
    state.recoveryAttempts++;state.stage='recovery';this.logger?.warn('ORCHESTRATOR','Recovery attempt',{attempt:state.recoveryAttempts,max:this.config.maxFixAttempts});const recovery={attempt:state.recoveryAttempts,status:'running',reason:lastTest?.error?.message||`Test command exited with ${lastTest?.exitCode}`,startedAt:new Date().toISOString()};state.recoveryHistory.push(recovery);state.record('recovery_started',{attempt:state.recoveryAttempts,reason:recovery.reason,testAttempt:lastTest?.attempt});
    const developerContext=this.contextManager.build({issue:input.issue,step:developerStep,dependencyResults:this.dependencyResults(developerStep,plan,completed),state});
    const recoveryInput={...developerContext,testFailure:lastTest,previousChanges:state.actualChanges,recoveryAttempt:state.recoveryAttempts};
    try{
      const developerResult=await this.runAgentWithRetries({...developerStep,id:`${developerStep.id}-recovery-${state.recoveryAttempts}`},recoveryInput,loop,state,lease);this.storeAgentResult(state,developerResult);completed.set(developerStep.id,developerResult);
      const qaContext=this.contextManager.build({issue:input.issue,step:qaStep,dependencyResults:[],state});
      const before=state.testRuns.length;const qaResult=await this.runAgentWithRetries({...qaStep,id:`${qaStep.id}-recovery-${state.recoveryAttempts}`},qaContext,loop,state,lease);this.storeAgentResult(state,qaResult);completed.set(qaStep.id,qaResult);
      if(state.testRuns.length===before) {state.testRuns.push({attempt:before+1,success:false,exitCode:null,error:'QA did not run tests during recovery'});}
      const passed=await this.assessQA(qaStep,qaResult,qaContext,plan,loop,state,completed,lease);recovery.status=passed?'succeeded':'failed';recovery.endedAt=new Date().toISOString();recovery.testAttempt=state.testRuns.at(-1)?.attempt;state.record('recovery_finished',{attempt:recovery.attempt,status:recovery.status,testAttempt:recovery.testAttempt});state.stage='execution';return passed;
    }catch(error){recovery.status='failed';recovery.endedAt=new Date().toISOString();recovery.errorCode=error.code||'RECOVERY_FAILED';state.record('recovery_finished',{attempt:recovery.attempt,status:'failed',code:recovery.errorCode});state.stage='execution';throw error;}
  }
  dependencyResults(step,plan,results) {const ids=new Set();const visit=id=>{for(const dependency of plan.steps.find(candidate=>candidate.id===id)?.dependsOn||[]){if(!ids.has(dependency)){ids.add(dependency);visit(dependency);}}};visit(step.id);return plan.steps.filter(candidate=>ids.has(candidate.id)&&results.has(candidate.id)).map(candidate=>({step:candidate,result:results.get(candidate.id)}));}
  async finalVerify(baseline,state) {
    const lastRun=state.testRuns.at(-1);const testPassed=Boolean(state.testResults.length>0&&state.testResults.at(-1).passed&&lastRun?.success===true&&lastRun.exitCode===0&&!lastRun.timedOut&&Array.isArray(lastRun.command)&&lastRun.command.length>0);
    const diff=await this.executeInternalTool('git_diff',state);
    const after=await this.readGitStatus();const baselineSet=new Set(baseline);const expected=new Set(state.filesChanged);
    state.unexpectedFiles=after.filter(file=>!baselineSet.has(file)&&!expected.has(file));
    const review=state.reviewResults.at(-1);
    const reviewInspectedDiff=Boolean(review?.reviewOutcome==='reviewed'&&review.reviewEvidence?.diffInspected&&review.reviewEvidence?.statusInspected&&review.artifacts?.some(item=>item.tool==='git_diff'&&item.success)&&review.artifacts?.some(item=>item.tool==='git_status'&&item.success));
    const changedEvidence=state.actualChanges.length>0&&state.actualChanges.every(change=>change.succeeded&&change.afterExists&&change.afterHash)&&state.filesChanged.every(file=>state.actualChanges.some(change=>change.path===file));
    const noBlockingErrors=!state.errors.some(error=>['VERIFICATION_FAILED','RESOURCE_LIMIT','TIMEOUT','STEP_FAILED'].includes(error.code))&&state.recoveryHistory.every(item=>item.status==='succeeded');
    state.verificationEvidence={changedEvidence,changedFiles:state.filesChanged,testPassed,testCommand:lastRun?.command||null,reviewOutcome:review?.reviewOutcome||'insufficient_evidence',reviewInspectedDiff,freshDiff:{success:diff.success,bytes:diff.bytes||0,sha256:diff.sha256||null},unexpectedFiles:state.unexpectedFiles,noBlockingErrors};
    return changedEvidence&&testPassed&&reviewInspectedDiff&&diff.success&&diff.bytes>=0&&state.unexpectedFiles.length===0&&noBlockingErrors;
  }
  async executeInternalTool(name,state) {try{const data=await this.toolRegistry.get(name).execute({});const result={success:true,tool:name,data,error:null};const metadata=typeof data==='string'?{bytes:Buffer.byteLength(data),sha256:createHash('sha256').update(data).digest('hex')}:{};state.record('tool_result',{success:true,tool:name,...metadata,error:null});return{...result,...metadata};}catch(error){const result={success:false,tool:name,data:null,error:{code:error.code||error.name,message:error.message}};state.record('tool_result',result);return result;}}
  async readGitStatus() {const tool=this.toolRegistry.get('git_status');if(!tool)return[];try{return(await tool.execute({})).split(/\r?\n/).filter(line=>line&&!line.startsWith('##')).map(line=>line.slice(3));}catch{return[];}}
}
function removeActiveAgent(state,name){const index=state.activeAgents.indexOf(name);if(index!==-1)state.activeAgents.splice(index,1);}
function safeText(value,secret=''){let text=typeof value==='string'?value:String(value??'');if(secret)text=text.split(secret).join('[REDACTED]');return text.slice(0,10000);}
function classifyTaskType(issue){if(/\b(how to|explain|describe|investigate|analy[sz]e|diagnose|review|inspect|understand|why|what)\b/i.test(issue))return'no_code_change';if(/^\s*(fix|implement|modify|change|add|remove|update|create|refactor|replace|delete|write)\b/i.test(issue))return'code_change';return'no_code_change';}
function sanitizePlan(plan,secret=''){return{goal:safeText(plan.goal,secret).slice(0,1000),steps:plan.steps.map(step=>({...step,id:safeText(step.id,secret).slice(0,128),agent:safeText(step.agent,secret).slice(0,128),task:safeText(step.task,secret).slice(0,10000),dependsOn:step.dependsOn.map(id=>safeText(id,secret).slice(0,128)),tools:step.tools.map(name=>safeText(name,secret).slice(0,128)),...(step.capabilities?{capabilities:step.capabilities.map(name=>safeText(name,secret).slice(0,128))}:{})}))};}
function sanitizeAgentResult(result,secret=''){
  const stored=JSON.parse(JSON.stringify(result));
  const scrub=(value,key='')=>{
    if(typeof value==='string')return safeText(value,secret).slice(0,4000);
    if(Array.isArray(value))return value.slice(0,100).map(item=>scrub(item));
    if(value&&typeof value==='object'){
      const out={};for(const [name,item] of Object.entries(value)){
        if(name==='data'&&typeof item==='string'&&['read_file','git_diff','git_status'].includes(value.tool))out[name]={bytes:Buffer.byteLength(item),sha256:createHash('sha256').update(item).digest('hex')};
        else if(['stdout','stderr'].includes(name)&&typeof item==='string')out[name]=safeText(item,secret).slice(0,4000);
        else out[name]=scrub(item,name);
      }return out;
    }return value;
  };
  return scrub(stored);
}
function safeSchedulerResult(result,secret=''){
  return{status:result.status,maxConcurrency:result.maxConcurrency,successfulSteps:result.successfulSteps,failedSteps:result.failedSteps,blockedSteps:result.blockedSteps,timedOutSteps:result.timedOutSteps,steps:result.steps.map(step=>({stepId:step.stepId,agent:step.agent,status:step.status,blockedBy:step.blockedBy||[],durationMs:step.durationMs,error:step.error?{code:step.error.code,message:safeText(step.error.message,secret).slice(0,1000)}:null,result:step.result?{agent:step.result.agent,status:step.result.status,summary:safeText(step.result.summary,secret).slice(0,1000)}:null}))};
}
module.exports={Orchestrator};
