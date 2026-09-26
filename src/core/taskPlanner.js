const { ValidationError } = require('../utils/errors');
const SYSTEM_PROMPT = `You are a task planner for a software engineering harness. Choose only registered agents and create the smallest useful sequential or dependency-based plan for the issue. Do not choose unavailable specialists. Return only JSON with {goal:string,steps:[{id:string,agent:string,task:string,dependsOn:string[],capabilities?:string[],tools?:string[]}]}. Plans must include repository research when code context is needed. For API request/response issues, consider the registered api_specialist when available. Do not select it for unrelated issues. For code changes include development and a QA verification step after development; add review when changes are made. Do not invent agents or tools.`;
class TaskPlanner {
  constructor({ llm, maxSteps = 12, maxExecutionTimeMs = 120000, allowedPermissions = ['filesystem:read','filesystem:write','git:read','process:test'] } = {}) { this.llm=llm; this.maxSteps=maxSteps; this.maxExecutionTimeMs=maxExecutionTimeMs; this.allowedPermissions=allowedPermissions; }
  async createPlan(issue, agents, toolRegistry, { onLLMEvent, reserveCall, timeoutMs } = {}) {
    const budget=Math.min(this.maxExecutionTimeMs,timeoutMs??this.maxExecutionTimeMs);
    const response = await withTimeout(this.llm.generate({ messages: [{role:'system',content:SYSTEM_PROMPT},{role:'user',content:JSON.stringify({issue,availableAgents:agents.map(({name,description,capabilities,tools})=>({name,description,capabilities,tools}))})}], tools: [] }, { timeoutMs: budget, onEvent: onLLMEvent, reserveCall }),budget);
    if (response.type !== 'final') throw new ValidationError('Planner must return a final JSON plan');
    let plan; try { plan=JSON.parse(response.content); } catch { throw new ValidationError('Planner response is not valid JSON'); }
    return validatePlan(plan, agents, toolRegistry, { maxSteps:this.maxSteps, allowedPermissions:this.allowedPermissions });
  }
}
function withTimeout(promise,ms){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Planning request timed out'),{code:'TIMEOUT'})),ms);})]).finally(()=>clearTimeout(timer));}
function validatePlan(plan, agents, toolRegistry, {maxSteps=12,allowedPermissions=[]}={}) {
  if (!plan || typeof plan.goal !== 'string' || !plan.goal.trim() || plan.goal.length>1000 || !Array.isArray(plan.steps) || !plan.steps.length) throw new ValidationError('Plan must include a bounded goal and at least one step');
  if(Buffer.byteLength(JSON.stringify(plan))>128*1024)throw Object.assign(new ValidationError('Plan exceeds the 128 KiB size limit'),{code:'RESOURCE_LIMIT',resource:'plan_bytes'});
  if (plan.steps.length > maxSteps) throw Object.assign(new ValidationError(`Plan exceeds maximum step count (${maxSteps})`),{code:'RESOURCE_LIMIT',resource:'plan_steps'});
  const byName = new Map(agents.map(agent=>[agent.name,agent])); const ids=new Set(); const stepById=new Map();
  for (const step of plan.steps) {
    if (!step || typeof step.id !== 'string' || step.id.length>128 || !/^[a-zA-Z0-9_-]+$/.test(step.id) || ids.has(step.id)) throw new ValidationError(`Invalid or duplicate plan step ID: ${step?.id}`);
    if (typeof step.agent !== 'string' || typeof step.task !== 'string' || !step.task.trim() || step.task.length>10000 || !Array.isArray(step.dependsOn) || step.dependsOn.some(dep=>typeof dep!=='string') || new Set(step.dependsOn).size!==step.dependsOn.length) throw new ValidationError(`Malformed plan step: ${step.id}`);
    const agent=byName.get(step.agent); if (!agent) throw new ValidationError(`Plan requires unavailable agent: ${step.agent}`);
    if (step.capabilities !== undefined && (!Array.isArray(step.capabilities) || step.capabilities.some(capability=>typeof capability!=='string'||!agent.capabilities.includes(capability)))) throw new ValidationError(`Agent ${step.agent} lacks a requested capability`);
    const selectedTools=step.tools ?? agent.tools;
    if (!Array.isArray(selectedTools) || selectedTools.some(name=>typeof name!=='string'||!agent.tools.includes(name)) || new Set(selectedTools).size!==selectedTools.length) throw new ValidationError(`Plan requests tools unavailable to ${step.agent}`);
    for (const name of selectedTools) {
      const tool=toolRegistry.get(name); if (!tool) throw new ValidationError(`Plan requests unknown tool: ${name}`);
      if (tool.permissions.some(permission=>!allowedPermissions.includes(permission))) throw new ValidationError(`Plan requests disallowed tool permission: ${name}`);
    }
    ids.add(step.id); stepById.set(step.id,{id:step.id,agent:step.agent,task:step.task,dependsOn:[...step.dependsOn],tools:[...selectedTools],...(step.capabilities?{capabilities:[...step.capabilities]}:{})});
  }
  for (const step of stepById.values()) for (const dependency of step.dependsOn) if (!ids.has(dependency) || dependency===step.id) throw new ValidationError(`Invalid dependency ${dependency} for step ${step.id}`);
  const ordered=[]; const complete=new Set();
  while (ordered.length<stepById.size) {
    const ready=[...stepById.values()].filter(step=>!complete.has(step.id)&&step.dependsOn.every(dep=>complete.has(dep)));
    if (!ready.length) throw new ValidationError('Plan contains a dependency cycle');
    for (const step of ready) { ordered.push(step); complete.add(step.id); }
  }
  const reaches=(fromId,targetId,visited=new Set())=>{ if(fromId===targetId)return true; if(visited.has(fromId))return false;visited.add(fromId);return (stepById.get(fromId)?.dependsOn||[]).some(dep=>reaches(dep,targetId,visited)); };
  const developers=ordered.filter(step=>step.agent==='developer');
  for(const developer of developers) if(!ordered.some(step=>step.agent==='qa'&&reaches(step.id,developer.id))) throw new ValidationError(`QA verification must depend on developer step ${developer.id}`);
  for(const reviewer of ordered.filter(step=>step.agent==='reviewer')) if(developers.length&&!ordered.some(step=>step.agent==='qa'&&reaches(reviewer.id,step.id))) throw new ValidationError(`Review step ${reviewer.id} must depend on QA verification`);
  return {goal:plan.goal,steps:ordered};
}
module.exports={TaskPlanner,validatePlan,SYSTEM_PROMPT};
