import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface RunnerConfig {
  serverUrl: string;
  runnerId: string;
  runnerToken: string;
  name: string;
  labels: string[];
  maxConcurrent: number;
}

const baseDir = process.env.ORBIT_HOME ?? join(homedir(), '.orbit');
const configFile = join(baseDir, 'config.json');

export function configPath(): string {
  return configFile;
}

export function runsDir(): string {
  return join(baseDir, 'runs');
}

export function loadConfig(): RunnerConfig | null {
  if (!existsSync(configFile)) return null;
  return JSON.parse(readFileSync(configFile, 'utf8')) as RunnerConfig;
}

export function saveConfig(cfg: RunnerConfig): void {
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(configFile, JSON.stringify(cfg, null, 2));
}
