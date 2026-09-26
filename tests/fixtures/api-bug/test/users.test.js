const test = require('node:test');
const assert = require('node:assert/strict');
const { handleCreateUser } = require('../src/app');
test('missing email receives a validation response', () => {
  assert.deepEqual(handleCreateUser({ body: {} }), { status: 400, body: { error: 'email is required' } });
});
test('valid email is normalized', () => {
  assert.deepEqual(handleCreateUser({ body: { email: 'User@Example.com' } }), { status: 201, body: { email: 'user@example.com' } });
});
