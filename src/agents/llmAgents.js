const { BaseAgent } = require('./baseAgent');
const PROMPTS = {
  researcher: 'Explore this repository for the issue. Use targeted searches and inspect likely source and test files. Return concise JSON with keys summary, findings (array), relevantFiles (array). Do not modify files or claim tests ran.',
  investigator: 'Diagnose the issue from repository evidence and research context. Use inspection tools if needed. Return JSON with problem, rootCause, evidence (array), relevantFiles (array), recommendedFix, summary. Mark uncertainty clearly; do not invent facts.',
  developer: 'Implement the recommended fix using only edit_file or create_file patch-safe tools. Inspect files first. Do not run tests; QA handles that. On recovery, use supplied test failure output to make a correction. Return JSON with summary, filesChanged (array), changes (array), unresolvedIssues (array). Never claim tests passed.',
  qa: 'Run the repository test suite using run_tests. Do not claim success unless the returned exit code is zero. Return JSON with summary, testsExecuted (array), testResults (array containing passed, exitCode, stdout, stderr), unresolvedIssues (array).',
  reviewer: 'Inspect the actual git_status and git_diff tool results, then compare the diff with the issue, findings, changed files, and recorded test evidence. Return JSON with summary, findings (array), filesChanged (array), unresolvedIssues (array). Do not claim a review or tests passed unless the corresponding tool evidence is present.'
};
const ROLE_TOOLS = {
  researcher: ['list_files', 'read_file', 'search_code'], investigator: ['list_files', 'read_file', 'search_code'],
  developer: ['list_files', 'read_file', 'search_code', 'edit_file', 'create_file'],
  api_specialist: ['list_files','read_file','search_code','git_status','git_diff','run_tests'],
  qa: ['run_tests'], reviewer: ['git_status', 'git_diff']
};
class LLMToolAgent extends BaseAgent {
  constructor(name, description, capabilities = [], tools = ROLE_TOOLS[name] || []) { super({ name, description, capabilities, tools }); }
  async execute(task, context = {}) {
    const output = await context.runToolLoop({ agent: this.name, systemPrompt: PROMPTS[this.name], tools: context.tools || ROLE_TOOLS[this.name], input: task });
    const parsed = parseAgentOutput(this.name, output.content);
    const artifacts=output.toolResults||[];
    const result={...parsed,agent:this.name,status:'completed',summary:typeof parsed.summary==='string'?parsed.summary:output.content,artifacts};
    result.findings=Array.isArray(result.findings)?result.findings:[];result.relevantFiles=Array.isArray(result.relevantFiles)?result.relevantFiles:[];
    if(this.name==='investigator'){result.evidence=Array.isArray(result.evidence)?result.evidence:[];result.recommendations=Array.isArray(result.recommendations)?result.recommendations:(result.recommendedFix?[result.recommendedFix]:[]);}
    if(this.name==='developer'){result.filesChanged=Array.isArray(result.filesChanged)?result.filesChanged:[];result.changes=Array.isArray(result.changes)?result.changes:[];if(artifacts.some(item=>['edit_file','create_file'].includes(item.tool)&&!item.success))result.status='failed';}
    if(this.name==='qa'){const runs=artifacts.filter(item=>item.tool==='run_tests'&&item.success).map(item=>item.data);result.tests=Array.isArray(result.tests)?result.tests:runs;result.passed=runs.length>0&&runs.at(-1).success===true&&runs.at(-1).exitCode===0;}
    if(this.name==='reviewer'){
      const diff=artifacts.find(item=>item.tool==='git_diff'&&item.success&&typeof item.data==='string');
      const status=artifacts.find(item=>item.tool==='git_status'&&item.success&&typeof item.data==='string');
      const complete=Boolean(diff&&status&&!parsed.malformed&&Array.isArray(parsed.findings)&&Array.isArray(parsed.unresolvedIssues));
      const concerns=(result.unresolvedIssues||[]).length>0||(result.findings||[]).some(item=>item?.severity==='blocking');
      result.reviewOutcome=!complete?'insufficient_evidence':concerns?'concerns_found':'reviewed';
      result.reviewEvidence={diffInspected:Boolean(diff),statusInspected:Boolean(status),findingsCount:Array.isArray(result.findings)?result.findings.length:0,unresolvedCount:Array.isArray(result.unresolvedIssues)?result.unresolvedIssues.length:0};
    }
    return result;
  }
}
function parseAgentOutput(agent, content) {
  try {
    const value = JSON.parse(content);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object');
    return value;
  } catch { return { summary: content, findings: [], relevantFiles: [], artifacts: [], malformed: true }; }
}
function createCoreAgents() {
  const { APISpecialistAgent } = require('./apiSpecialist');
  return [
    new APISpecialistAgent(),
    new LLMToolAgent('researcher', 'Explore repository and identify relevant source and tests', ['repository-analysis','code-search','architecture-understanding']),
    new LLMToolAgent('investigator', 'Use evidence to diagnose the reported issue', ['bug-investigation','root-cause-analysis','error-analysis']),
    new LLMToolAgent('developer', 'Make controlled patch-based code changes', ['code-modification','implementation','refactoring']),
    new LLMToolAgent('qa', 'Run configured repository tests', ['test-execution','verification','regression-testing']),
    new LLMToolAgent('reviewer', 'Review the working tree diff and changes', ['code-review','diff-analysis','regression-analysis'])
  ];
}
const SPECIALIST_AGENT_INTERFACES = [
  {name:'browser-agent',description:'Exercises browser and UI workflows.',capabilities:['browser-automation','ui-testing'],available:false},
  {name:'database-agent',description:'Analyzes database queries and schemas.',capabilities:['database-analysis','query-analysis'],available:false},
  {name:'documentation-agent',description:'Updates project documentation.',capabilities:['documentation','technical-writing'],available:false},
  {name:'dependency-agent',description:'Investigates dependencies and versions.',capabilities:['dependency-analysis'],available:false},
  {name:'data-analyst',description:'Analyzes structured project data.',capabilities:['data-analysis'],available:false}
];
module.exports = { LLMToolAgent, createCoreAgents, PROMPTS, ROLE_TOOLS, SPECIALIST_AGENT_INTERFACES };
