function createUser(body) {
  try {
    const email = body.email.toLowerCase();
    return { status: 201, body: { email } };
  } catch {
    return { status: 500, body: { error: 'internal error' } };
  }
}
module.exports = { createUser };
