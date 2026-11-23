import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CREATE_WORKDIR_CAPABILITY,
  CREATE_WORKDIR_HOME_CAPABILITY,
  cloneRootFor,
  newFolderPath,
  newFolderRoot,
  newFolderRootFor,
  type NewFolderRunner,
} from './dto';

describe('newFolderRoot', () => {
  const v1 = [CREATE_WORKDIR_CAPABILITY];
  const v2 = [CREATE_WORKDIR_CAPABILITY, CREATE_WORKDIR_HOME_CAPABILITY];

  it('is the reposRoot on a runner that only makes folders there', () => {
    expect(newFolderRoot('/root/orbit-repos', v1)).toBe('/root/orbit-repos');
    expect(newFolderRoot('/root/orbit-repos/', null)).toBe('/root/orbit-repos');
  });

  it('is home, the directory reposRoot sits in, on a runner that declares create-workdir/v2', () => {
    expect(newFolderRoot('/root/orbit-repos', v2)).toBe('/root');
    expect(newFolderRoot('/Users/austin/orbit-repos/', v2)).toBe('/Users/austin');
    expect(newFolderRoot('C:\\Users\\orbit\\orbit-repos', v2)).toBe('C:\\Users\\orbit');
    expect(newFolderRoot('/orbit-repos', v2)).toBe('/');
    expect(newFolderRoot('C:\\orbit-repos', v2)).toBe('C:\\');
  });
});

const fixture = JSON.parse(readFileSync(path.join(__dirname, 'new-folder-root.fixture.json'), 'utf8')) as {
  cases: { name: string; runner: NewFolderRunner; root: string | null; path: string | null }[];
  clones: { name: string; runner: Omit<NewFolderRunner, 'managed'>; root: string | null; path: string | null }[];
};

describe('newFolderRootFor: new-folder-root.fixture.json', () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const root = newFolderRootFor(c.runner);
      expect(root).toBe(c.root);
      expect(root === null ? null : newFolderPath(root, 'app')).toBe(c.path);
    });
  }
});

describe('cloneRootFor: new-folder-root.fixture.json clones', () => {
  for (const c of fixture.clones) {
    it(c.name, () => {
      const root = cloneRootFor(c.runner);
      expect(root).toBe(c.root);
      expect(root === null ? null : newFolderPath(root, 'app')).toBe(c.path);
    });
  }
});
