const { BaseAgent } = require('./baseAgent');
const SPECS = [['researcher','Explore repository structure and report findings',['repository research']],['investigator','Analyze an issue and identify likely causes',['bug investigation']],['developer','Implement an approved change',['code modification']],['qa','Run and summarize relevant tests',['testing']],['reviewer','Review proposed changes',['code review']]];
class SkeletonAgent extends BaseAgent { async execute(task) { return { status: 'not_implemented', agent: this.name, taskId: task?.id || null }; } }
function createCoreAgents() { return SPECS.map(([name, description, capabilities]) => new SkeletonAgent({ name, description, capabilities })); }
module.exports = { SkeletonAgent, createCoreAgents };
