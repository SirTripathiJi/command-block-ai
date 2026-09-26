const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { resolveWorkspacePath, assertInsideRoot } = require('./fileTools');
const { PermissionError, ValidationError } = require('../utils/errors');
async function atomicWrite(target, content) {
  const mode = (await fs.stat(target)).mode & 0o777;
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try { await fs.writeFile(temp, content, { encoding: 'utf8', flag: 'wx', mode }); await fs.chmod(temp, mode); await fs.rename(temp, target); }
  catch (error) { await fs.rm(temp, { force: true }).catch(() => {}); throw error; }
}
function createEditTools({ workspaceRoot }) {
  const root = path.resolve(workspaceRoot);
  const edit = { name: 'edit_file', description: 'Replace one unique exact text snippet in an existing workspace file. Does not create or overwrite whole files.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' } }, required: ['path', 'oldText', 'newText'], additionalProperties: false }, permissions: ['filesystem:write'], execute: async ({ path: relative, oldText, newText }) => {
    const target = await assertInsideRoot(root, resolveWorkspacePath(root, relative));
    const before = await fs.readFile(target, 'utf8'); const first = before.indexOf(oldText);
    if (first < 0) throw Object.assign(new ValidationError('The requested oldText was not found.'), { code: 'TEXT_NOT_FOUND' });
    if (before.indexOf(oldText, first + oldText.length) >= 0) throw Object.assign(new ValidationError('The requested oldText occurs more than once; provide a unique snippet.'), { code: 'AMBIGUOUS_TEXT' });
    const after = before.slice(0, first) + newText + before.slice(first + oldText.length);
    if (after === before) return { success: true, path: relative, changed: false };
    await atomicWrite(target, after); return { success: true, path: relative, changed: true, beforeHash: hash(before), afterHash: hash(after), diff: { beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after), removedLines: oldText.split(/\r?\n/).length, addedLines: newText.split(/\r?\n/).length } };
  } };
  const create = { name: 'create_file', description: 'Create a new UTF-8 file inside the workspace without overwriting existing files.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false }, permissions: ['filesystem:write'], execute: async ({ path: relative, content }) => {
    if (!relative || typeof content !== 'string') throw new ValidationError('path and content are required');
    const target = resolveWorkspacePath(root, relative);
    let existingParent = path.dirname(target);
    while (true) { try { await fs.realpath(existingParent); break; } catch (error) { if (error.code !== 'ENOENT') throw error; const next = path.dirname(existingParent); if (next === existingParent) throw error; existingParent = next; } }
    await assertInsideRoot(root, existingParent);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const parent = await assertInsideRoot(root, path.dirname(target));
    try { await fs.writeFile(path.join(parent, path.basename(target)), content, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') throw Object.assign(new ValidationError('File already exists; refusing to overwrite.'), { code: 'FILE_EXISTS' }); throw error; }
    await assertInsideRoot(root, target); return { success: true, path: relative, changed: true, beforeHash: null, afterHash: hash(content), diff: { beforeBytes: 0, afterBytes: Buffer.byteLength(content), removedLines: 0, addedLines: content.split(/\r?\n/).length } };
  } };
  return [edit, create];
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
module.exports = { createEditTools };
