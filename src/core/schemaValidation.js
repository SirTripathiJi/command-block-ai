const { ValidationError } = require('../utils/errors');
function validateArguments(schema, value) {
  if (!schema || schema.type !== 'object' || !value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Tool arguments must be an object');
  for (const key of schema.required || []) if (!(key in value)) throw new ValidationError(`Missing required argument: ${key}`);
  if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in (schema.properties || {}))) throw new ValidationError(`Unknown argument: ${key}`);
  for (const [key, rule] of Object.entries(schema.properties || {})) {
    if (!(key in value)) continue;
    if (rule.type === 'string' && typeof value[key] !== 'string') throw new ValidationError(`Argument ${key} must be a string`);
    if (rule.type === 'string' && rule.minLength && value[key].length < rule.minLength) throw new ValidationError(`Argument ${key} must not be empty`);
  }
}
module.exports = { validateArguments };
