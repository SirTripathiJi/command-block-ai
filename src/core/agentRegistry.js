const { ValidationError } = require('../utils/errors');
class AgentRegistry {
  constructor() { this.agents = new Map(); }
  register(agent) {
    if (!agent || typeof agent.name !== 'string' || !agent.name || typeof agent.execute !== 'function') throw new ValidationError('Agent requires a name and execute(task, context) function');
    if (agent.capabilities !== undefined && (!Array.isArray(agent.capabilities) || agent.capabilities.some(value=>typeof value!=='string'))) throw new ValidationError('Agent capabilities must be a string array');
    if (agent.tools !== undefined && (!Array.isArray(agent.tools) || agent.tools.some(value=>typeof value!=='string'))) throw new ValidationError('Agent tools must be a string array');
    if (!agent.capabilities) agent.capabilities=[]; if (!agent.tools) agent.tools=[];
    if (this.agents.has(agent.name)) throw new ValidationError(`Agent already registered: ${agent.name}`);
    this.agents.set(agent.name, agent); return agent;
  }
  get(name) { return this.agents.get(name); }
  has(name) { return this.agents.has(name); }
  list() { return [...this.agents.values()]; }
}
module.exports = { AgentRegistry };
