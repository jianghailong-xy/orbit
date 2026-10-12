import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from '../../../../../src/web/ui-migration/toasts.config.mjs';
export default defineConfig({...baseline,globalSetup:fileURLToPath(new URL('../../../../../src/web/ui-migration/environment.mjs',import.meta.url)),testDir:'.',testMatch:'raster.browser.mjs',projects:baseline.projects.filter(p=>p.name==='chromium-light-desktop'),use:{...baseline.use,reducedMotion:'no-preference'},outputDir:'./raster-results',reporter:[['list'],['json',{outputFile:fileURLToPath(new URL('./raster-results/report.json',import.meta.url))}]]});
