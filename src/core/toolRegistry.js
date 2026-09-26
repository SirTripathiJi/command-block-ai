const { ValidationError } = require('../utils/errors');
class ToolRegistry {
  constructor() { this.tools = new Map(); }
  register(tool) {
    if (!tool || !tool.name || !tool.description || !tool.inputSchema || typeof tool.execute !== 'function' || !Array.isArray(tool.permissions)) throw new ValidationError('Tool requires name, description, inputSchema, execute and permissions');
    if (this.tools.has(tool.name)) throw new ValidationError(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool); return tool;
  }
  get(name) { return this.tools.get(name); }
  has(name) { return this.tools.has(name); }
  list() { return [...this.tools.values()].map(({ name, description, inputSchema, permissions }) => ({ name, description, inputSchema, permissions })); }
}
module.exports = { ToolRegistry };
