const { ValidationError } = require('../utils/errors');
class BaseAgent {
  constructor({ name, description, capabilities = [], tools = [] }) {
    if (!name || !description) throw new ValidationError('Agent name and description are required');
    this.name = name; this.description = description; this.capabilities = capabilities; this.tools = tools;
  }
  async execute() { throw new Error(`${this.name} does not implement execute()`); }
}
module.exports = { BaseAgent };
