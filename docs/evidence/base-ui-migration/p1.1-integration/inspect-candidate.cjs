// Read actual runtime resolution and generated artifacts, independent of the compatibility helper.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const {execFileSync} = require('node:child_process');
const root = fs.realpathSync(process.argv[2]);
const result = {root, commit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), modules: {}, paths: {}};
for (const [workspace, names] of Object.entries({
  web: ['@base-ui/react/button', '@base-ui/react/dialog', '@orbit/shared'],
  apiserver: ['@prisma/client', '.prisma/client/default', '@orbit/shared'],
})) {
  const requireFrom = createRequire(path.join(root, 'src', workspace, 'package.json'));
  for (const name of names) {
    const resolved = fs.realpathSync(requireFrom.resolve(name));
    assert(resolved.startsWith(root + '/'), `${workspace}: ${name} escaped to ${resolved}`);
    result.modules[workspace + ':' + name] = resolved;
  }
}
for (const rel of ['node_modules', 'node_modules/.bin', 'node_modules/@base-ui/react',
  'src/apiserver/node_modules/@prisma/client', 'src/apiserver/node_modules/.prisma',
  'src/shared/dist', 'src/web/node_modules', 'src/web/node_modules/.vite', 'src/web/node_modules/.vite-temp']) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    assert(rel.endsWith('/.vite') || rel.endsWith('/.vite-temp'), `missing ${rel}`);
    result.paths[rel] = {exists: false, note: 'cache not yet created'};
    continue;
  }
  const real = fs.realpathSync(file);
  assert(real.startsWith(root + '/'), `${rel} escaped to ${real}`);
  result.paths[rel] = {exists: true, realpath: real, symlink: fs.lstatSync(file).isSymbolicLink()};
}
for (const rel of ['node_modules/@base-ui/react/package.json', 'node_modules/.package-lock.json',
  'src/apiserver/node_modules/.prisma/client/index.d.ts']) {
  const stat = fs.statSync(path.join(root, rel));
  result.paths[rel] = {ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs};
}
result.trackedStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {cwd: root, encoding: 'utf8'});
assert.equal(result.trackedStatus, '');
console.log(JSON.stringify(result, null, 2));
