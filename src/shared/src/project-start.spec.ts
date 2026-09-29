import { describe, expect, it } from 'vitest';
import { type ProjectStartSettings, differingStartSettings } from './project-start';

const ASKED: ProjectStartSettings = {
  line: 'PROJECT_BRANCH',
  automatic: true,
  maxConcurrentTasks: 3,
  mergeCheckCommand: 'npm test',
};

describe('differingStartSettings', () => {
  it('names nothing when the settings are what was asked for', () => {
    expect(differingStartSettings(ASKED, {
      ...ASKED,
      projectBranchName: 'refs/heads/project/abc',
    })).toEqual([]);
  });

  it('names every setting that differs, in card order', () => {
    expect(differingStartSettings(ASKED, {
      line: 'MAIN',
      automatic: false,
      maxConcurrentTasks: 1,
      mergeCheckCommand: null,
    })).toEqual(['line', 'automatic', 'maxConcurrentTasks', 'mergeCheckCommand']);
  });

  it('counts a branch it named and did not get, and not one it left to the project', () => {
    const named = { ...ASKED, projectBranchName: 'refs/heads/project/next' };
    expect(differingStartSettings(named, { ...named, projectBranchName: 'refs/heads/project/other' }))
      .toEqual(['line']);
    expect(differingStartSettings(named, named)).toEqual([]);
  });

  it('compares a merge check as it is stored: trimmed, and blank is none', () => {
    expect(differingStartSettings({ ...ASKED, mergeCheckCommand: '  npm test ' }, ASKED)).toEqual([]);
    expect(differingStartSettings({ ...ASKED, mergeCheckCommand: '   ' }, { ...ASKED, mergeCheckCommand: null }))
      .toEqual([]);
  });
});
