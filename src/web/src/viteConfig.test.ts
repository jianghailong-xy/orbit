import { describe, expect, it } from 'vitest';
import config from '../vite.config';

/**
 * WHICH REACT ROUTER THE WEB BUILD BUNDLES.
 *
 * React Router 7 ships a development and a production build, but its exports map has no
 * `production` condition: `.` and `./dom` both resolve to `dist/development`, so a plain Vite
 * build puts the development build in the shipped bundle — `ENABLE_DEV_WARNINGS = true`, and its
 * warnings ("Matched leaf route ... does not have an element") in the production console.
 *
 * vite.config.ts aliases both entry points to the production files for a build, and only for a
 * build: the dev server and the tests keep the development build, where its warnings are useful.
 * This holds that split, because losing it is silent — the app still works, it just ships the
 * development build to production again.
 */

type Config = (env: { command: string; mode: string }) => {
  resolve: { alias: Array<{ find: RegExp; replacement: string }> };
};

const aliases = (command: 'build' | 'serve') =>
  (config as unknown as Config)({ command, mode: command === 'build' ? 'production' : 'development' })
    .resolve.alias;

const replacementOf = (command: 'build' | 'serve', find: RegExp) =>
  aliases(command).find((alias) => alias.find.source === find.source)?.replacement;

describe('the web build', () => {
  it('bundles React Router’s production build, through both of its entry points', () => {
    expect(replacementOf('build', /^react-router$/)).toMatch(
      /[\\/]react-router[\\/]dist[\\/]production[\\/]index\.mjs$/,
    );
    expect(replacementOf('build', /^react-router\/dom$/)).toMatch(
      /[\\/]react-router[\\/]dist[\\/]production[\\/]dom-export\.mjs$/,
    );
  });

  it('leaves the development build to the dev server and the tests', () => {
    expect(replacementOf('serve', /^react-router$/)).toBeUndefined();
    expect(replacementOf('serve', /^react-router\/dom$/)).toBeUndefined();
  });
});
