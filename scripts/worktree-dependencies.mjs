// Check the installed graph, not the checkout's lockfile: its node_modules may be stale.
import fs from 'node:fs';
import path from 'node:path';

const [repo, installedRoot] = process.argv.slice(2).map((value) => path.resolve(value));
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

try {
  const wanted = read(path.join(repo, 'package-lock.json')).packages;
  const installed = read(path.join(installedRoot, 'node_modules/.package-lock.json')).packages;
  if (!wanted || !installed) throw new Error('a packages lockfile is required');
  for (const location of Object.keys(installed)) {
    if (location.includes('node_modules/') && !wanted[location]) {
      throw new Error(`${location}: an extra installed package could shadow the locked graph`);
    }
  }
  if (repo === installedRoot) {
    for (const workspace of ['', 'src/shared', 'src/apiserver', 'src/web']) {
      const bin = path.join(repo, workspace, 'node_modules/.bin');
      if (fs.existsSync(bin) && !fs.realpathSync(bin).startsWith(`${repo}${path.sep}`)) {
        throw new Error(`${bin}: local executables are borrowed from outside this tree`);
      }
    }
  }
  for (const [location, expected] of Object.entries(wanted)) {
    if (!location.includes('node_modules/')) continue; // Root/workspace manifests are source.
    const actual = installed[location];
    // npm may omit optional dependencies (including optional peers), even on a supported platform.
    // Only genuine absence is allowed: any installed entry must still match the lock and disk.
    if (expected.optional && !actual &&
        !fs.lstatSync(path.join(installedRoot, location), { throwIfNoEntry: false })) continue;
    if (!actual) throw new Error(`${location} is not installed`);
    for (const key of ['version', 'resolved', 'integrity', 'link']) {
      if (expected[key] !== actual[key]) throw new Error(`${location}: installed ${key} differs from lock`);
    }
    const directory = fs.realpathSync(path.join(installedRoot, location));
    if (expected.link) {
      if (directory !== fs.realpathSync(path.join(installedRoot, expected.resolved))) {
        throw new Error(`${location}: workspace link points outside its checkout`);
      }
    } else {
      if (repo === installedRoot && !directory.startsWith(`${repo}${path.sep}`)) {
        throw new Error(`${location}: local installation borrows an external package`);
      }
      if (read(path.join(directory, 'package.json')).version !== expected.version) {
        throw new Error(`${location}: actual package version differs from lock`);
      }
    }
  }
} catch (error) {
  console.error(`worktree-overlay: incompatible dependencies in ${installedRoot}: ${error.message}`);
  process.exitCode = 1;
}
