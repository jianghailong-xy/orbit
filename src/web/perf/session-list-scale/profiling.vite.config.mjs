// The web build with React's profiling renderer, so a commit's render time can be read off the fiber root
// (what React's <Profiler> reports). Everything else is vite.config.ts. measure.mjs copies this file into the
// src/web of the tree it builds.
import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config.ts';

export default defineConfig((env) => {
  const config = typeof base === 'function' ? base(env) : base;
  return mergeConfig(
    { ...config, resolve: { ...config.resolve, alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }, ...config.resolve.alias] } },
    { build: { outDir: 'dist-profiling', emptyOutDir: true } },
  );
});
