class ExecutionEngine {
  constructor({ agentRegistry, toolRegistry, logger, maxExecutions = 50 } = {}) { this.agentRegistry=agentRegistry;this.toolRegistry=toolRegistry;this.logger=logger;this.maxExecutions=maxExecutions;this.executions=0; }
  async execute(agentName, task, context = {}) {
    if(++this.executions>this.maxExecutions)throw new Error('Execution limit reached');
    const agent=this.agentRegistry.get(agentName);if(!agent)throw new Error(`Unknown agent: ${agentName}`);
    const started=Date.now();this.logger?.info(agentName.toUpperCase(),'Agent started');
    try{const result=await agent.execute(task,{...context,tools:this.toolRegistry});context.state?.record('agent_completed',{agent:agentName,durationMs:Date.now()-started});return result;}
    catch(error){context.state?.record('agent_failed',{agent:agentName,message:error.message});throw error;}
  }
  async executeStep(step, completedResults, execute) {
    const missing=step.dependsOn.filter(dependency=>!completedResults.has(dependency));
    if(missing.length)throw new Error(`Step ${step.id} is not ready; dependencies incomplete: ${missing.join(', ')}`);
    const result=await execute(step,completedResults);completedResults.set(step.id,result);return result;
  }
  async executePlan(plan,{executeStep,maxConcurrency=2,maxExecutionTimeMs=120000,stepTimeoutMs=60000,maxPlanSteps=100,onTransition=()=>{}}={}) {
    if(!Number.isInteger(maxConcurrency)||maxConcurrency<1||maxConcurrency>8)throw new RangeError('maxConcurrency must be an integer from 1 through 8');
    if(!Number.isSafeInteger(maxExecutionTimeMs)||maxExecutionTimeMs<1||maxExecutionTimeMs>3600000||!Number.isSafeInteger(stepTimeoutMs)||stepTimeoutMs<1||stepTimeoutMs>3600000||!Number.isSafeInteger(maxPlanSteps)||maxPlanSteps<1||maxPlanSteps>100)throw new RangeError('Execution time and plan limits are out of bounds');
    if(!plan||!Array.isArray(plan.steps)||plan.steps.length<1)throw Object.assign(new Error('Execution plan is missing or malformed.'),{code:'PLAN_REJECTED'});
    if(plan.steps.length>maxPlanSteps)throw Object.assign(new Error('Execution plan exceeds the configured step limit.'),{code:'RESOURCE_LIMIT',resource:'plan_steps'});
    const ids=new Set();for(const step of plan.steps){if(!step||typeof step.id!=='string'||!step.id||ids.has(step.id)||typeof step.agent!=='string'||typeof step.task!=='string'||!Array.isArray(step.dependsOn))throw Object.assign(new Error('Execution plan contains an invalid or duplicate step.'),{code:'PLAN_REJECTED'});if(this.agentRegistry&&!this.agentRegistry.get(step.agent))throw Object.assign(new Error(`Unknown agent: ${step.agent}`),{code:'PLAN_REJECTED'});ids.add(step.id);}
    for(const step of plan.steps)for(const dependency of step.dependsOn)if(!ids.has(dependency)||dependency===step.id)throw Object.assign(new Error(`Execution plan has an invalid dependency for ${step.id}.`),{code:'PLAN_REJECTED'});
    const startedAt=Date.now(),statuses=new Map(plan.steps.map(step=>[step.id,'pending'])),results=new Map(),details=new Map(),running=new Map();
    const launched=new Set();
    const transition=(step,status,extra={})=>{statuses.set(step.id,status);const item={stepId:step.id,agent:step.agent,status,...extra};details.set(step.id,{...(details.get(step.id)||{}),...item});onTransition(item);const label={running:'started',succeeded:'completed',failed:'failed',timed_out:'timed out',blocked:'blocked',ready:'ready'}[status]||status;this.logger?.info('SCHEDULER',`${label}: ${step.id}`,extra);};
    const launch=step=>{
      if(launched.has(step.id))throw Object.assign(new Error(`Duplicate execution prevented for step ${step.id}.`),{code:'DUPLICATE_STEP'});
      launched.add(step.id);
      const now=Date.now(),deadline=Math.min(now+stepTimeoutMs,startedAt+maxExecutionTimeMs);const lease={active:true,deadline};
      transition(step,'running',{dependencies:step.dependsOn,activeCount:running.size+1});
      const operation=Promise.resolve().then(()=>executeStep(step,{results,lease})).then(result=>({status:'succeeded',result}),error=>({status:error.code==='TIMEOUT'?'timed_out':'failed',error:{code:error.code||error.name||'STEP_FAILED',message:error.message}}));
      const remaining=Math.max(0,deadline-Date.now());let timer;
      const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'timed_out',error:{code:'TIMEOUT',message:`Step ${step.id} exceeded its execution timeout.`}}),remaining);});
      const settled=Promise.race([operation,timeout]).then(outcome=>{clearTimeout(timer);lease.active=false;if(outcome.status==='succeeded'){results.set(step.id,outcome.result);transition(step,'succeeded',{durationMs:Date.now()-now});}else{transition(step,outcome.status,{error:outcome.error,durationMs:Date.now()-now});}return{step,outcome};});
      running.set(step.id,settled);
    };
    while(running.size||[...statuses.values()].some(status=>status==='pending')){
      if(Date.now()-startedAt>=maxExecutionTimeMs){for(const step of plan.steps)if(statuses.get(step.id)==='pending')transition(step,'timed_out',{error:{code:'TASK_TIMEOUT',message:'Task execution budget expired before this step started.'}});}
      for(const step of plan.steps){if(statuses.get(step.id)!=='pending')continue;const failedDeps=step.dependsOn.filter(id=>['failed','timed_out','blocked','skipped'].includes(statuses.get(id)));if(failedDeps.length)transition(step,'blocked',{blockedBy:failedDeps});}
      const ready=plan.steps.filter(step=>statuses.get(step.id)==='pending'&&step.dependsOn.every(id=>statuses.get(id)==='succeeded'));
      for(const step of ready){if(Date.now()-startedAt>=maxExecutionTimeMs)break;if(running.size>=maxConcurrency)break;transition(step,'ready',{dependencies:step.dependsOn});launch(step);}
      if(running.size===0){if([...statuses.values()].some(status=>status==='pending')){for(const step of plan.steps)if(statuses.get(step.id)==='pending')transition(step,'blocked',{blockedBy:step.dependsOn.filter(id=>statuses.get(id)!=='succeeded')});}break;}
      const completed=await Promise.race(running.values());running.delete(completed.step.id);
    }
    const steps=plan.steps.map(step=>({...details.get(step.id),result:results.get(step.id)??null}));
    const failures=steps.filter(step=>['failed','timed_out'].includes(step.status));
    const blocked=steps.filter(step=>step.status==='blocked'||step.status==='skipped');
    const successfulSteps=steps.filter(step=>step.status==='succeeded').map(step=>step.stepId),failedSteps=failures.map(step=>step.stepId),blockedSteps=blocked.map(step=>({stepId:step.stepId,blockedBy:step.blockedBy||[]}));
    return{status:failures.length?'failed':blocked.length?'blocked':'succeeded',maxConcurrency,steps,successfulSteps,failedSteps,blockedSteps,timedOutSteps:steps.filter(step=>step.status==='timed_out').map(step=>step.stepId)};
  }
}
module.exports={ExecutionEngine};
