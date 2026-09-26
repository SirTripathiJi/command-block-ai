class ConfigurationError extends Error { constructor(message, code = 'configuration_error') { super(message); this.name = 'ConfigurationError'; this.code = code; } }
class PermissionError extends Error { constructor(message) { super(message); this.name = 'PermissionError'; } }
class ValidationError extends Error { constructor(message) { super(message); this.name = 'ValidationError'; } }
module.exports = { ConfigurationError, PermissionError, ValidationError };
