class MockProvider {
  constructor(responses = []) { this.isMock = true; this.responses = [...responses]; this.requests = []; }
  async generate(request) { this.requests.push(request); if (!this.responses.length) throw new Error('MockProvider has no queued response'); const next = this.responses.shift(); return typeof next === 'function' ? next(request) : next; }
}
module.exports = { MockProvider };
