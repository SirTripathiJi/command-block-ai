const { createUser } = require('./routes/users');
function handleCreateUser(request) { return createUser(request.body); }
module.exports = { handleCreateUser };
