import { defineConfig } from '@playwright/test';
import toasts from './toasts.config.mjs';
// The toasts configuration (dev server on 14377, P0 environment), restricted to the race diagnosis.
export default defineConfig({ ...toasts, testMatch: 'toasts-selection.diag.mjs', outputDir: process.env.B1_OUTPUT,
  reporter: [['list'], ['json', { outputFile: `${process.env.B1_OUTPUT}/report.json` }]] });
