const path = require('node:path');
const { ConfigurationError } = require('../utils/errors');
class LLMProvider { async generate(request, options) { throw new Error('LLMProvider.generate must be implemented'); } }
function loadProvider(modulePathOrConfig) {
  const config = typeof modulePathOrConfig === 'object' && modulePathOrConfig !== null ? modulePathOrConfig : null;
  const modulePath = config ? config.providerModule : modulePathOrConfig;
  if (modulePath) {
    let loaded;
    try { loaded = require(path.resolve(modulePath)); }
    catch { throw new ConfigurationError('The configured LLM provider module could not be loaded.', 'provider_load_error'); }
    if (typeof loaded.createProvider !== 'function') throw new ConfigurationError('LLM provider module must export createProvider(config).', 'provider_interface_error');
    return loaded.createProvider;
  }
  if (config?.llmProvider) {
    const { createProvider } = require('./openaiCompatibleProvider');
    return createProvider.bind(null, config);
  }
  throw new ConfigurationError('No LLM provider configured. Set LLM_PROVIDER to deepseek or qwen, or set LLM_PROVIDER_MODULE to a module exporting createProvider(config).', 'provider_not_configured');
}
module.exports = { LLMProvider, loadProvider };
