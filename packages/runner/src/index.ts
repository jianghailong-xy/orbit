#!/usr/bin/env node
import { hostname } from 'os';
import { RunnerRegisterRequest } from '@orbit/shared';
import { list, num, parseFlags, str } from './args';
import { loadConfig, RunnerConfig, saveConfig } from './config';
import { runLoop } from './run-loop';
import { Transport } from './transport';

const USAGE = `orbit — register a machine and run Claude Code tasks for an Orbit control plane

Usage:
  orbit register --server <url> --token <enrollment-token> [options]
  orbit run

register options:
  --server <url>           Control plane base URL (e.g. http://localhost:3000)
  --token <token>          One-time enrollment token (from the Orbit UI)
  --name <name>            Runner name (default: this machine's hostname)
  --labels a,b,c           Routing labels (e.g. sg,hdfs)
  --max-concurrent <n>     Max concurrent jobs (default: 1)

Env:
  ANTHROPIC_API_KEY        Used by Claude Code on this machine (never sent to the control plane)
  ORBIT_CLAUDE_MODE=cli    Force the \`claude -p\` subprocess path instead of the Agent SDK
  ORBIT_HOME               Override config/runs dir (default: ~/.orbit)
`;

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  const flags = parseFlags(rest);

  switch (cmd) {
    case 'register':
      await register(flags);
      break;
    case 'run':
      await run();
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      break;
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(1);
  }
}

async function register(flags: Record<string, string | boolean>): Promise<void> {
  const server = str(flags, 'server');
  const token = str(flags, 'token');
  if (!server || !token) {
    process.stderr.write('register requires --server and --token\n');
    process.exit(1);
  }
  const name = str(flags, 'name') ?? hostname();
  const labels = list(flags, 'labels') ?? [];
  const maxConcurrent = num(flags, 'max-concurrent') ?? 1;

  const body: RunnerRegisterRequest = {
    enrollmentToken: token,
    name,
    hostname: hostname(),
    labels,
    maxConcurrent,
    version: '0.1.0',
  };

  const res = await new Transport(server).register(body);
  if (!res) {
    process.stderr.write('registration failed: empty response\n');
    process.exit(1);
  }
  const cfg: RunnerConfig = {
    serverUrl: server,
    runnerId: res.runnerId,
    runnerToken: res.runnerToken,
    name: res.name,
    labels,
    maxConcurrent,
  };
  saveConfig(cfg);
  process.stdout.write(
    `registered runner "${res.name}" (${res.runnerId}).\nStart it with:  orbit run\n`,
  );
}

async function run(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) {
    process.stderr.write('no runner config found — run `orbit register` first\n');
    process.exit(1);
  }
  await runLoop(cfg);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
