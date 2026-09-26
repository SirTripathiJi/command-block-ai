const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {Orchestrator}=require('../../src/core/orchestrator');
const {TaskState}=require('../../src/core/taskState');
const {ToolRegistry}=require('../../src/core/toolRegistry');
const {LLMClient}=require('../../src/llm/client');
const {MockProvider}=require('../../src/llm/mockProvider');
const {ToolLoop}=require('../../src/core/toolLoop');
const {LLMToolAgent}=require('../../src/agents/llmAgents');
const {createEditTools}=require('../../src/tools/editTools');
const {createRunTestsTool}=require('../../src/tools/testTools');
const {readIssue,formatCliError}=require('../../src/index');

const baseConfig={maxAgentSteps:4,maxToolCalls:4,maxLLMCalls:4,maxExecutionTimeMs:5000,toolTimeoutMs:1000,maxFixAttempts:1,maxAgentRetries:0,maxPlanSteps:4,maxConcurrency:2,stepTimeoutMs:2000,allowedPermissions:['filesystem:read','filesystem:write','git:read','process:test']};
function registry(agent){return{list:()=>[agent],get:name=>name===agent.name?agent:undefined};}
function taskPlan(agent='reader'){return{goal:'Inspect task evidence',steps:[{id:'inspect',agent,task:'Inspect using available evidence',dependsOn:[]}]};}
function fixtureAgent(execute=async()=>({agent:'reader',status:'completed',summary:'Inspected evidence.'})){return{name:'reader',description:'Read-only fixture agent',capabilities:['repository-analysis'],tools:[],execute};}

test('invalid issue input and invalid limits return structured failures without executing',async()=>{
  let planned=0;const agent=fixtureAgent();const planner={createPlan:async()=>{planned++;return taskPlan();}};
  const orchestrator=new Orchestrator({planner,agentRegistry:registry(agent),toolRegistry:new ToolRegistry(),config:baseConfig});
  const empty=await orchestrator.run('   ');assert.equal(empty.outcome,'invalid_input');assert.equal(empty.status,'invalid_input');
  const oversized=await orchestrator.run('x'.repeat(10001));assert.equal(oversized.outcome,'invalid_input');
  const badLimits=await new Orchestrator({planner,agentRegistry:registry(agent),toolRegistry:new ToolRegistry(),config:{...baseConfig,maxConcurrency:9}}).run('inspect');
  assert.equal(badLimits.outcome,'configuration_error');assert.equal(planned,0);
});

test('CLI EOF resolves to a structured invalid-input error without a stack trace',async()=>{
  const listeners=new Map();const fake={once:(event,fn)=>listeners.set(event,fn),removeListener:(event)=>listeners.delete(event),question:(_prompt,callback)=>listeners.get('close')?.()};
  assert.equal(await readIssue(fake),'');const formatted=formatCliError(Object.assign(new Error('Issue must be non-empty.'),{code:'INVALID_INPUT'}),'');
  assert.match(formatted, /"status":"invalid_input"/);assert.match(formatted,/"outcome":"invalid_input"/);assert.doesNotMatch(formatted,/stack/i);
});

test('runtime revalidation rejects unknown agents and duplicate step identifiers',async()=>{
  const agent=fixtureAgent();const tools=new ToolRegistry();
  for(const plan of [
    {goal:'bad agent',steps:[{id:'x',agent:'missing',task:'do',dependsOn:[]}]},
    {goal:'duplicate',steps:[{id:'x',agent:'reader',task:'one',dependsOn:[]},{id:'x',agent:'reader',task:'two',dependsOn:[]}]}
  ]){
    const result=await new Orchestrator({planner:{createPlan:async()=>plan},agentRegistry:registry(agent),toolRegistry:tools,config:baseConfig}).run('inspect');
    assert.equal(result.status,'planning_failed');assert.equal(result.outcome,'failure');assert.ok(result.executionHistory.some(event=>event.event==='plan_rejected'));
  }
});

test('task level LLM-call exhaustion is reported as a resource limit',async()=>{
  const agent=fixtureAgent(async(_task,context)=>context.runToolLoop({agent:'reader',systemPrompt:'read only',tools:[],input:{issue:'inspect'}}));
  const planner={createPlan:async(_issue,_agents,_tools,{reserveCall})=>{reserveCall();return taskPlan();}};
  const provider=new MockProvider([{type:'final',content:'unused'}]);
  const result=await new Orchestrator({llm:new LLMClient({provider,config:{apiKey:'placeholder',model:'fixture',temperature:0,maxTokens:64}}),planner,agentRegistry:registry(agent),toolRegistry:new ToolRegistry(),config:{...baseConfig,maxLLMCalls:1}}).run('inspect');
  assert.equal(result.outcome,'resource_limit');assert.equal(result.errors.at(-1).code,'RESOURCE_LIMIT');assert.equal(provider.requests.length,0);
});

test('no-code plan can complete but an agent claim cannot manufacture file-change evidence',async()=>{
  const agent=fixtureAgent();const result=await new Orchestrator({planner:{createPlan:async()=>taskPlan()},agentRegistry:registry(agent),toolRegistry:new ToolRegistry(),config:baseConfig}).run('Explain the repository structure.');
  assert.equal(result.outcome,'success');assert.equal(result.verification.details.type,'no_code_change');
  const state=new TaskState('fix a defect');const orchestrator=new Orchestrator({toolRegistry:new ToolRegistry()});
  orchestrator.storeAgentResult(state,{agent:'developer',status:'completed',summary:'Fixed it.',filesChanged:['src/fake.js']});
  assert.deepEqual(state.filesChanged,[]);assert.deepEqual(state.actualChanges,[]);
});

test('idempotency key replays a prior result without running the plan twice',async()=>{
  let ran=0;const agent=fixtureAgent(async()=>{ran++;return{agent:'reader',status:'completed',summary:'Ran once.'};});
  const orchestrator=new Orchestrator({planner:{createPlan:async()=>taskPlan()},agentRegistry:registry(agent),toolRegistry:new ToolRegistry(),config:baseConfig});
  const first=await orchestrator.run('Inspect once',{idempotencyKey:'evaluation-case-1'});const replay=await orchestrator.run('Inspect once',{idempotencyKey:'evaluation-case-1'});
  assert.equal(ran,1);assert.equal(first.outcome,'success');assert.equal(replay.idempotentReplay,true);assert.equal(replay.id,first.id);
});

test('review success requires structured output plus actual status and diff tool evidence',async()=>{
  const reviewer=new LLMToolAgent('reviewer','Review repository changes');
  const result=await reviewer.execute({}, {runToolLoop:async()=>({content:JSON.stringify({summary:'Looks acceptable.',findings:[],unresolvedIssues:[]}),toolResults:[{tool:'git_diff',success:true,data:'diff'}]})});
  assert.equal(result.reviewOutcome,'insufficient_evidence');assert.equal(result.reviewEvidence.statusInspected,false);
});

test('unexpected workspace changes and missing executed-test evidence block code verification',async()=>{
  const tools={get:name=>({execute:async()=>name==='git_diff'?'diff':' M surprise.txt'})};
  const orchestrator=new Orchestrator({toolRegistry:tools});const state=new TaskState('fix');
  state.filesChanged=['src/fix.js'];state.actualChanges=[{path:'src/fix.js',succeeded:true,afterExists:true,afterHash:'hash'}];
  state.testResults=[{passed:true}];state.reviewResults=[{reviewOutcome:'reviewed',reviewEvidence:{diffInspected:true,statusInspected:true},artifacts:[{tool:'git_diff',success:true},{tool:'git_status',success:true}]}];
  assert.equal(await orchestrator.finalVerify([],state),false);assert.deepEqual(state.unexpectedFiles,['surprise.txt']);assert.equal(state.verificationEvidence.testPassed,false);
});

test('task state observability does not retain file contents or tool argument contents',async()=>{
  const secret='PRIVATE_FILE_CONTENT_10';const provider=new MockProvider([{type:'tool_call',tool:'read_file',arguments:{path:'private.txt'}},{type:'final',content:'Inspected.'}]);
  const llm=new LLMClient({provider,config:{apiKey:'placeholder',model:'fixture',temperature:0,maxTokens:64}});
  const tool={name:'read_file',description:'read',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false},permissions:['filesystem:read'],execute:async()=>secret};
  const tools={list:()=>[tool],get:name=>name==='read_file'?tool:undefined};const state=new TaskState('inspect private file');
  await new ToolLoop({llm,toolRegistry:tools,config:{...baseConfig},state,startedAt:Date.now()}).run({agent:'reader',systemPrompt:'Inspect.',tools:['read_file'],input:{}});
  assert.equal(JSON.stringify(state.toJSON()).includes(secret),false);assert.ok(state.toolResults[0].data.sha256);
});

test('file and QA tools return hash and execution evidence without storing full file contents',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-phase10-'));
  try{
    await fs.writeFile(path.join(root,'existing.txt'),'before value');
    const [edit,create]=createEditTools({workspaceRoot:root});
    const changed=await edit.execute({path:'existing.txt',oldText:'before',newText:'after'});
    assert.equal(changed.beforeHash,createHash('sha256').update('before value').digest('hex'));
    assert.equal(changed.afterHash,createHash('sha256').update('after value').digest('hex'));
    assert.equal(changed.diff.removedLines,1);assert.equal(changed.diff.addedLines,1);
    const created=await create.execute({path:'new.txt',content:'small content'});
    assert.equal(created.beforeHash,null);assert.equal(created.afterHash,createHash('sha256').update('small content').digest('hex'));
    const testRun=await createRunTestsTool({workspaceRoot:root,testCommand:['node','-e','process.stdout.write("ok")'],timeoutMs:1000,maxOutputBytes:100}).execute({});
    assert.equal(testRun.success,true);assert.equal(testRun.exitCode,0);assert.deepEqual(testRun.command,['node','-e','process.stdout.write("ok")']);assert.ok(testRun.durationMs>=0);assert.ok(testRun.startedAt&&testRun.endedAt);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
