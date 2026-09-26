const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createEditTools } = require('../../src/tools/editTools');
const { createRunTestsTool } = require('../../src/tools/testTools');
const { ToolRegistry } = require('../../src/core/toolRegistry');
const { AgentRegistry } = require('../../src/core/agentRegistry');
const { createCoreAgents } = require('../../src/agents/llmAgents');
const { Orchestrator } = require('../../src/core/orchestrator');
const { LLMClient } = require('../../src/llm/client');
const { MockProvider } = require('../../src/llm/mockProvider');
const { createFileTools } = require('../../src/tools/fileTools');
const { createSearchTool } = require('../../src/tools/searchTools');
const { createGitTools } = require('../../src/tools/gitTools');
const execFileAsync = promisify(execFile);
async function temporary(fn) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-p3-')); try { return await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); } }
async function gitInit(root) { await execFileAsync('git', ['init', '-q'], { cwd: root }); await execFileAsync('git', ['add', '.'], { cwd: root }); await execFileAsync('git', ['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture baseline'], { cwd: root }); }
test('edit_file refuses traversal, missing, and ambiguous edits without corrupting content', () => temporary(async root => {
  await fs.writeFile(path.join(root,'a.txt'),'x x'); const [edit]=createEditTools({workspaceRoot:root});
  await assert.rejects(edit.execute({path:'../../outside',oldText:'x',newText:'y'}));
  await assert.rejects(edit.execute({path:'a.txt',oldText:'missing',newText:'y'})); await assert.rejects(edit.execute({path:'a.txt',oldText:'x',newText:'y'}));
  assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'x x');
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'harness-outside-')); await fs.symlink(outside,path.join(root,'link'));
  const [,create]=createEditTools({workspaceRoot:root}); await assert.rejects(create.execute({path:'link/created/file.txt',content:'no'}));
  assert.equal(await fs.stat(path.join(outside,'created')).then(()=>true,()=>false),false); await fs.rm(outside,{recursive:true,force:true});
}));
test('create_file blocks traversal and refuses overwrite', () => temporary(async root => {
  const [,create]=createEditTools({workspaceRoot:root}); await assert.rejects(create.execute({path:'../escape',content:'bad'}));
  await create.execute({path:'nested/new.txt',content:'safe'}); await assert.rejects(create.execute({path:'nested/new.txt',content:'overwrite'}));
  assert.equal(await fs.readFile(path.join(root,'nested/new.txt'),'utf8'),'safe');
}));
test('run_tests stays rooted in workspace, rejects dangerous executable, and enforces timeout', () => temporary(async root => {
  const cwdTool=createRunTestsTool({workspaceRoot:root,testCommand:['node','-e','process.stdout.write(process.cwd())']});
  const cwd=await cwdTool.execute({}); assert.equal(cwd.success,true); assert.equal(await fs.realpath(cwd.stdout),await fs.realpath(root));
  await assert.rejects(createRunTestsTool({workspaceRoot:root,testCommand:['sh','-c','true']}).execute({}));
  const slow=createRunTestsTool({workspaceRoot:root,testCommand:['node','-e','setTimeout(()=>{},2000)'],timeoutMs:100});
  const result=await slow.execute({}); assert.equal(result.success,false); assert.equal(result.timedOut,true);
}));
test('mock provider drives inspection, edit, failing tests, recovery, passing tests, and diff review', async () => {
  await temporary(async tempRoot => { const root=path.join(tempRoot,'calculator'); await fs.cp(path.resolve(__dirname,'../fixtures/calculator'),root,{recursive:true}); await gitInit(root);
  const script = [
    {type:'final',content:JSON.stringify({goal:'Fix calculator division',steps:[{id:'research',agent:'researcher',task:'Find divide implementation',dependsOn:[]},{id:'investigate',agent:'investigator',task:'Diagnose defect',dependsOn:['research']},{id:'implement',agent:'developer',task:'Fix defect',dependsOn:['investigate']},{id:'verify',agent:'qa',task:'Run tests',dependsOn:['implement']},{id:'review',agent:'reviewer',task:'Review diff',dependsOn:['verify']}]})},
    {type:'tool_call',tool:'search_code',arguments:{query:'divide'}},
    {type:'tool_call',tool:'read_file',arguments:{path:'src/calculator.js'}},
    {type:'final',content:JSON.stringify({summary:'Located divide implementation.',findings:['Division helper multiplies operands.'],relevantFiles:['src/calculator.js','tests/calculator.test.js']})},
    {type:'final',content:JSON.stringify({summary:'Root cause is multiplication in divide.',problem:'divide returns product',rootCause:'Wrong operator',evidence:['src/calculator.js returns a * b'],relevantFiles:['src/calculator.js'],recommendedFix:'Use division'})},
    {type:'tool_call',tool:'edit_file',arguments:{path:'src/calculator.js',oldText:'return a * b',newText:'return a / b + 1'}},
    {type:'final',content:JSON.stringify({summary:'Applied initial correction.',filesChanged:['src/calculator.js'],changes:['Changed operator']})},
    {type:'tool_call',tool:'run_tests',arguments:{}},
    {type:'final',content:JSON.stringify({summary:'Initial tests failed.',testsExecuted:['npm test'],testResults:[]})},
    {type:'tool_call',tool:'edit_file',arguments:{path:'src/calculator.js',oldText:'return a / b + 1',newText:'return a / b'}},
    {type:'final',content:JSON.stringify({summary:'Corrected quotient calculation.',filesChanged:['src/calculator.js'],changes:['Removed erroneous increment']})},
    {type:'tool_call',tool:'run_tests',arguments:{}},
    {type:'final',content:JSON.stringify({summary:'All tests passed.',testsExecuted:['npm test'],testResults:[]})},
    {type:'tool_call',tool:'git_status',arguments:{}},
    {type:'tool_call',tool:'git_diff',arguments:{}},
    {type:'final',content:JSON.stringify({summary:'Diff contains the focused calculator fix.',findings:[],filesChanged:['src/calculator.js'],unresolvedIssues:[]})}
  ];
  const config={workspaceRoot:root,model:'mock',temperature:0,maxTokens:1000,maxAgentSteps:12,maxToolCalls:20,maxExecutionTimeMs:30000,toolTimeoutMs:5000,maxFixAttempts:3,allowedPermissions:['filesystem:read','filesystem:write','git:read','process:test'],commandTimeoutMs:10000,maxCommandOutputBytes:100000};
  const registry=new ToolRegistry(); [...createFileTools(config),createSearchTool(config),...createGitTools(config),...createEditTools(config),createRunTestsTool({workspaceRoot:root,timeoutMs:10000})].forEach(tool=>registry.register(tool));
  const agents=new AgentRegistry(); createCoreAgents().forEach(agent=>agents.register(agent));
  const llm=new LLMClient({provider:new MockProvider(script),config}); const state=await new Orchestrator({llm,toolRegistry:registry,agentRegistry:agents,config}).run('Fix the calculator bug.');
  assert.equal(state.status,'verified'); assert.equal(state.verification.status,'passed'); assert.equal(state.recoveryAttempts,1); assert.deepEqual(state.filesChanged,['src/calculator.js']);
  assert.deepEqual(state.testRuns.map(run=>run.success),[false,true]); assert.equal(state.testRuns[0].exitCode,1); assert.equal(state.executionHistory.some(e=>e.event==='recovery_started'),true);
  assert.equal((await fs.readFile(path.join(root,'src/calculator.js'),'utf8')).includes('return a / b;'),true);
  });
});
test('verification stops at configured retry limit with a useful failure state',async()=>{
 await temporary(async tempRoot=>{const root=path.join(tempRoot,'calculator');await fs.cp(path.resolve(__dirname,'../fixtures/calculator'),root,{recursive:true});await gitInit(root);
 const plan={goal:'Fix calculator',steps:[{id:'research',agent:'researcher',task:'inspect',dependsOn:[]},{id:'implement',agent:'developer',task:'fix divide',dependsOn:['research']},{id:'verify',agent:'qa',task:'run tests',dependsOn:['implement']}]};
 const provider=new MockProvider([{type:'final',content:JSON.stringify(plan)},{type:'final',content:JSON.stringify({summary:'Found bug.',findings:[],relevantFiles:['src/calculator.js']})},{type:'final',content:JSON.stringify({summary:'No edit made.',filesChanged:[],changes:[]})},{type:'tool_call',tool:'run_tests',arguments:{}},{type:'final',content:JSON.stringify({summary:'Tests fail.',tests:[]})}]);
 const config={workspaceRoot:root,model:'mock',temperature:0,maxTokens:300,maxAgentSteps:5,maxToolCalls:5,maxExecutionTimeMs:10000,toolTimeoutMs:5000,maxFixAttempts:0,maxAgentRetries:0,maxPlanSteps:5,allowedPermissions:['filesystem:read','filesystem:write','git:read','process:test']};
 const registry=new ToolRegistry();[...createFileTools(config),createSearchTool(config),...createGitTools(config),...createEditTools(config),createRunTestsTool({workspaceRoot:root,timeoutMs:5000})].forEach(tool=>registry.register(tool));const agents=new AgentRegistry();createCoreAgents().forEach(agent=>agents.register(agent));
 const result=await new Orchestrator({llm:new LLMClient({provider,config}),toolRegistry:registry,agentRegistry:agents,config}).run('Fix calculator');assert.equal(result.status,'failed_verification');assert.equal(result.recoveryAttempts,0);assert.match(result.errors.at(-1).message,/recovery limit reached/);
 });
});
