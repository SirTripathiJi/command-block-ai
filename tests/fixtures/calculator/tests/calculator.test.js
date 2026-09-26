const test = require('node:test');
const assert = require('node:assert/strict');
const { divide } = require('../src/calculator');
test('divide returns quotient', () => assert.equal(divide(10, 2), 5));
