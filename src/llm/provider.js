const path = require('node:path');
const { ConfigurationError } = require('../utils/errors');
class LLMProvider { async generate(request, options) { throw new Error('LLMProvider.generate must be implemented'); } }
function loadProvider(modulePath) {
  if (!modulePath) throw new ConfigurationError('No LLM provider configured. Set LLM_PROVIDER_MODULE to a module exporting createProvider(config), then provide AI_API_KEY.', 'provider_not_configured');
  let loaded;
  try { loaded = require(path.resolve(modulePath)); }
  catch { throw new ConfigurationError('The configured LLM provider module could not be loaded.', 'provider_load_error'); }
  if (typeof loaded.createProvider !== 'function') throw new ConfigurationError('LLM provider module must export createProvider(config).', 'provider_interface_error');
  return loaded.createProvider;
}
module.exports = { LLMProvider, loadProvider };
