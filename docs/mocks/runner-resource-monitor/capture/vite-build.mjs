import { build } from '/mnt/data/tmp/runner-res-mock/tree/node_modules/vite/dist/node/index.js';
import cfg from './vite.mjs';
await build({ ...cfg, build: { outDir: process.argv[2], emptyOutDir: true } });
