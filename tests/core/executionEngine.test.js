const test = require('node:test');
const assert = require('node:assert/strict');
const { ExecutionEngine } = require('../../src/core/executionEngine');

const step = (id, dependsOn = []) => ({ id, agent: 'mock', task: id, dependsOn });
const plan = (...steps) => ({ goal: 'scheduler test', steps });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('independent steps overlap and dependencies wait for every parent', async () => {
  const engine = new ExecutionEngine();
  const bothStarted = deferred(); const release = deferred();
  const starts = []; const transitions = []; const finished = new Set(); let active = 0; let maxActive = 0;
  const result = await engine.executePlan(plan(step('a'), step('b'), step('c', ['a']), step('d', ['b', 'c'])), {
    maxConcurrency: 2, onTransition:event=>transitions.push(`${event.stepId}:${event.status}`), executeStep: async item => {
      starts.push(item.id); active++; maxActive = Math.max(maxActive, active);
      if (item.id === 'a' || item.id === 'b') {
        if (starts.filter(id => id === 'a' || id === 'b').length === 2) { bothStarted.resolve(); release.resolve(); }
        await bothStarted.promise; await release.promise;
      }
      if (item.id === 'c') assert.ok(finished.has('a'), 'c waits for a');
      if (item.id === 'd') { assert.ok(finished.has('b')); assert.ok(finished.has('c')); }
      finished.add(item.id); active--; if (item.id === 'b') release.resolve();
      return { id: item.id };
    }
  });
  assert.equal(maxActive, 2);
  assert.deepEqual(starts.slice(0, 2), ['a', 'b']);
  assert.deepEqual(result.successfulSteps, ['a', 'b', 'c', 'd']);
  assert.equal(result.status, 'succeeded');
  assert.ok(transitions.includes('a:ready')&&transitions.includes('a:running')&&transitions.includes('d:succeeded'));
});

test('concurrency one serializes roots and the maximum accepted limit remains bounded', async () => {
  const engine = new ExecutionEngine(); let active=0;let maximum=0;
  const serial=await engine.executePlan(plan(step('a'),step('b')), {maxConcurrency:1,executeStep:async item=>{active++;maximum=Math.max(maximum,active);await Promise.resolve();active--;return item.id;}});
  assert.equal(maximum,1);assert.equal(serial.status,'succeeded');
  let started=0;let maxAtOnce=0;const allStarted=deferred();const done=deferred();
  const bounded=await engine.executePlan(plan(...Array.from({length:8},(_,i)=>step(`max-${i}`))),{maxConcurrency:8,executeStep:async item=>{started++;maxAtOnce=Math.max(maxAtOnce,started);if(started===8){allStarted.resolve();done.resolve();}await allStarted.promise;await done.promise;started--;return item.id;}});
  assert.equal(maxAtOnce,8);assert.equal(bounded.status,'succeeded');
});

test('stable ready order and concurrency cap complete four independent steps', async () => {
  const engine = new ExecutionEngine(); const starts = []; let active = 0; let maxActive = 0;
  const gates = [deferred(), deferred()]; let wave = 0; let inWave = 0;
  const result = await engine.executePlan(plan(step('a'), step('b'), step('c'), step('d')), {
    maxConcurrency: 2, executeStep: async item => {
      starts.push(item.id); active++; maxActive = Math.max(maxActive, active);
      const gate = gates[wave]; if (++inWave === 2) { inWave = 0; wave++; gate.resolve(); }
      await gate.promise; active--; return item.id;
    }
  });
  assert.deepEqual(starts, ['a', 'b', 'c', 'd']);
  assert.equal(maxActive, 2); assert.equal(result.successfulSteps.length, 4);
});

test('one failed branch blocks its descendants while an independent branch completes', async () => {
  const engine = new ExecutionEngine(); const started = [];
  const result = await engine.executePlan(plan(step('a'), step('b'), step('c', ['a']), step('d', ['b'])), {
    maxConcurrency: 2, executeStep: async item => {
      started.push(item.id); if (item.id === 'b') throw Object.assign(new Error('broken'), { code: 'BROKEN' });
      return item.id;
    }
  });
  assert.ok(started.includes('c')); assert.ok(!started.includes('d'));
  assert.equal(result.steps.find(item => item.stepId === 'b').status, 'failed');
  assert.equal(result.steps.find(item => item.stepId === 'd').status, 'blocked');
  assert.deepEqual(result.steps.find(item => item.stepId === 'd').blockedBy, ['b']);
  assert.deepEqual(result.successfulSteps, ['a', 'c']);
  assert.deepEqual(result.failedSteps, ['b']);
});

test('a step with multiple dependencies starts only after both succeed', async () => {
  const engine = new ExecutionEngine(); const done = new Set(); const bothStarted = deferred(); const release = deferred(); let started = 0;
  const result = await engine.executePlan(plan(step('a'), step('b'), step('join', ['a', 'b'])), {
    maxConcurrency: 2, executeStep: async item => {
      if (item.id === 'a' || item.id === 'b') {
        if (++started === 2) { bothStarted.resolve(); release.resolve(); } await bothStarted.promise; await release.promise;
        done.add(item.id);
      } else assert.deepEqual([...done].sort(), ['a', 'b']);
      return item.id;
    }
  });
  assert.equal(result.status, 'succeeded');
});

test('dependency failure records blocking reason and timeout releases the scheduler', async () => {
  const engine = new ExecutionEngine(); let dependentStarted = false;
  const result = await engine.executePlan(plan(step('stuck'), step('child', ['stuck']), step('independent')), {
    maxConcurrency: 2, stepTimeoutMs: 15, maxExecutionTimeMs: 1000,
    executeStep: async item => {
      if (item.id === 'stuck') return new Promise(() => {});
      if (item.id === 'child') dependentStarted = true;
      return item.id;
    }
  });
  assert.equal(result.status, 'failed'); assert.deepEqual(result.timedOutSteps, ['stuck']);
  assert.equal(dependentStarted, false);
  assert.deepEqual(result.steps.find(item => item.stepId === 'child').blockedBy, ['stuck']);
  assert.ok(result.successfulSteps.includes('independent'));
});
