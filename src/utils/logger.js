class Logger {
  constructor({ sink = console.log, enabled = true } = {}) { this.sink = sink; this.enabled = enabled; }
  log(level, component, message, details = {}) {
    if (!this.enabled) return;
    this.sink(JSON.stringify({ timestamp: new Date().toISOString(), level, component, message, ...details }));
  }
  info(component, message, details) { this.log('info', component, message, details); }
  warn(component, message, details) { this.log('warn', component, message, details); }
  error(component, message, details) { this.log('error', component, message, details); }
}
module.exports = { Logger };
