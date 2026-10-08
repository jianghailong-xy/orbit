import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from './playwright.config.mjs';
export default defineConfig({ ...baseline, testMatch:'coordinator-feedback.browser.mjs',testIgnore:[], projects:baseline.projects.filter(p=>['chromium-light-desktop','webkit-light-desktop'].includes(p.name)), outputDir:'../.coordinator-feedback-results', reporter:[['list'],['json',{outputFile:fileURLToPath(new URL('../.coordinator-feedback-results/report.json',import.meta.url))}]],use:{...baseline.use,baseURL:'http://127.0.0.1:14379'},webServer:{...baseline.webServer,command:'npm run dev -- --host 127.0.0.1 --port 14379 --strictPort',url:'http://127.0.0.1:14379'}});
