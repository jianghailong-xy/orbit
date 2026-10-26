// The fixture repository for the repo-configuration scenarios. Every file the CLI might load
// carries a distinct codeword, and every place that could execute something (hooks in each
// candidate location, MCP servers, worktree/environment scripts, .envrc) runs the marker script,
// which appends one JSON line naming its source. A marker line is proof something executed;
// a codeword in the stored model context is proof a file was loaded.
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const TEST_MCP = join(here, '..', 'test-mcp.mjs');
// The node that runs the harness also runs the test MCP server and the fixture repos' servers
// (P0b: /usr/local/bin/node does not exist on orbit-macos; the harness node is /opt/homebrew/bin/node).
export const NODE = process.execPath;

const HOOK_EVENTS = ['beforeShellExecution', 'beforeMCPExecution', 'afterShellExecution', 'afterMCPExecution', 'beforeReadFile',
  'afterFileEdit', 'stop', 'beforeSubmitPrompt', 'afterAgentResponse', 'afterAgentThought', 'sessionStart', 'sessionEnd',
  'preCompact', 'subagentStart', 'subagentStop', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'workspaceOpen'];

export const CODEWORDS = {
  agents: 'P0-AGENTS-MANGO', claude: 'P0-CLAUDE-KIWI', claudeLocal: 'P0-CLAUDELOCAL-PLUM', cursorrules: 'P0-CURSORRULES-LIME',
  ruleAlways: 'P0-RULE-ALWAYS-FIG', ruleGlob: 'P0-RULE-GLOB-DATE', ruleAgent: 'P0-RULE-AGENT-PEAR', nestedAgents: 'P0-NESTED-AGENTS-CHERRY',
  skill: 'P0-SKILL-GUAVA', command: 'P0-COMMAND-LYCHEE',
  // Outside the repository, in the slot (plantSlotConfigs): the CLI's HOME and its config dir.
  userRule: 'P0-USER-RULE-OLIVE', homeAgents: 'P0-HOME-AGENTS-QUINCE', configDirRule: 'P0-CONFIGDIR-RULE-SAGE',
};

// The marker script: `mark.sh <source> <event>`; stdin (the hook payload) is kept, truncated.
export function writeMarker(toolsDir, markerLog) {
  mkdirSync(toolsDir, { recursive: true });
  const script = join(toolsDir, 'mark.sh');
  writeFileSync(script, `#!/bin/sh
# P0 marker: proves that something ran. Appends one JSON line to the marker log.
payload=""
if [ ! -t 0 ]; then payload=$(head -c 2000 | tr -d '\\000' | base64 -w0); fi
printf '{"source":"%s","event":"%s","cwd":"%s","pid":%s,"home":"%s","xdgConfig":"%s","cursorConfigDir":"%s","canary":"%s","payloadB64":"%s"}\\n' \\
  "$1" "$2" "$(pwd)" "$$" "$HOME" "$XDG_CONFIG_HOME" "$CURSOR_CONFIG_DIR" "$ORBIT_P0_CANARY" "$payload" >> '${markerLog}'
# Hooks read a JSON answer on stdout; an empty object changes nothing.
echo '{}'
`);
  chmodSync(script, 0o755);
  return script;
}

function hooksJson(mark, source) {
  const hooks = {};
  for (const ev of HOOK_EVENTS) hooks[ev] = [{ command: `${mark} ${source} ${ev}`, timeout: 10 }];
  return JSON.stringify({ version: 1, hooks }, null, 2);
}

function mcpJson(name, mcpLog) {
  return JSON.stringify({ mcpServers: { [name]: { command: NODE, args: [TEST_MCP], env: { P0_MCP_LOG: mcpLog, P0_MCP_NAME: name } } } }, null, 2);
}

// Builds the repository at `repo`; `paths` names the marker log, MCP log and tools dir.
export function buildFixtureRepo(repo, { markerLog, mcpLog, toolsDir }) {
  const mark = writeMarker(toolsDir, markerLog);
  const files = {
    'README.md': '# P0 fixture repository\n\nA tiny repository whose configuration files each carry a codeword.\n',
    'app.py': 'print("hello from the fixture")\n',
    'AGENTS.md': `# Agent instructions\n\nCodeword: ${CODEWORDS.agents}. When asked for codewords, list every codeword you were given.\n`,
    'CLAUDE.md': `# Claude instructions\n\nCodeword: ${CODEWORDS.claude}.\n`,
    'CLAUDE.local.md': `Codeword: ${CODEWORDS.claudeLocal}.\n`,
    '.cursorrules': `Codeword: ${CODEWORDS.cursorrules}.\n`,
    'sub/AGENTS.md': `Codeword: ${CODEWORDS.nestedAgents}.\n`,
    'sub/note.txt': 'nested directory\n',
    '.cursor/rules/always.mdc': `---\ndescription: P0 always rule\nalwaysApply: true\n---\nCodeword: ${CODEWORDS.ruleAlways}.\n`,
    '.cursor/rules/glob.mdc': `---\nglobs: "*.py"\nalwaysApply: false\n---\nCodeword: ${CODEWORDS.ruleGlob}.\n`,
    '.cursor/rules/agent.mdc': `---\ndescription: Fetch this rule when the user asks about fixture codewords\nalwaysApply: false\n---\nCodeword: ${CODEWORDS.ruleAgent}.\n`,
    '.cursor/skills/p0skill/SKILL.md': `---\nname: p0skill\ndescription: P0 fixture skill (${CODEWORDS.skill})\n---\nDo nothing.\n`,
    '.cursor/commands/p0cmd.md': `P0 fixture command (${CODEWORDS.command}).\n`,
    // Only `permissions` is allowed; both arrays are required (a missing one fails the schema).
    '.cursor/cli.json': JSON.stringify({ permissions: { allow: ['Shell(ls)', 'Shell(touch)'], deny: ['Shell(rm)'] } }, null, 2),
    '.cursor/hooks.json': hooksJson(mark, 'repo-cursor-hooks'),
    '.cursor/mcp.json': mcpJson('repo-mcp', mcpLog),
    '.cursor/worktrees.json': JSON.stringify({ 'setup-worktree': [`${mark} repo-worktrees-json setup`] }, null, 2),
    '.cursor/environment.json': JSON.stringify({ install: `${mark} repo-environment-json install`, start: `${mark} repo-environment-json start` }, null, 2),
    // A command of its own (mkdir), so its allow entry and cli.json's (touch) are told apart.
    '.claude/settings.json': JSON.stringify({
      permissions: { allow: ['Bash(mkdir:*)'] },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: `${mark} repo-claude-settings SessionStart` }] }],
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: `${mark} repo-claude-settings PreToolUse` }] }],
        Stop: [{ hooks: [{ type: 'command', command: `${mark} repo-claude-settings Stop` }] }],
      },
    }, null, 2),
    '.envrc': `${mark} repo-envrc load\n`,
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), body);
  }
  execSync('git init -q && git add -A && git -c user.email=p0@example.invalid -c user.name=p0 commit -qm fixture', { cwd: repo });
  return { mark, files: Object.keys(files) };
}

// The places outside the repository where a slot could hold hooks/MCP: the user's ~/.cursor,
// CURSOR_CONFIG_DIR, and the per-project data dir the ACP path reads "project" hooks from.
export function plantSlotConfigs(slot, repo, { mark, mcpLog }) {
  const slug = repo.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  const spots = {
    'home-cursor': join(slot.home, '.cursor'),
    'config-dir': slot.config,
    'data-project': join(slot.data, 'projects', slug, '.cursor'),
    'home-project': join(slot.home, '.cursor', 'projects', slug, '.cursor'),
  };
  for (const [label, dir] of Object.entries(spots)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hooks.json'), hooksJson(mark, `${label}-hooks`));
    writeFileSync(join(dir, 'mcp.json'), mcpJson(`${label}-mcp`, mcpLog));
  }
  // Rules the CLI might read from its own HOME and config dir rather than from the repository.
  mkdirSync(join(slot.home, '.cursor', 'rules'), { recursive: true });
  writeFileSync(join(slot.home, '.cursor', 'rules', 'p0-user.mdc'), `---\ndescription: P0 user rule\nalwaysApply: true\n---\nCodeword: ${CODEWORDS.userRule}.\n`);
  writeFileSync(join(slot.home, 'AGENTS.md'), `Codeword: ${CODEWORDS.homeAgents}.\n`);
  mkdirSync(join(slot.config, 'rules'), { recursive: true });
  writeFileSync(join(slot.config, 'rules', 'p0-config.mdc'), `---\ndescription: P0 config-dir rule\nalwaysApply: true\n---\nCodeword: ${CODEWORDS.configDirRule}.\n`);
  mkdirSync(join(slot.home, '.claude'), { recursive: true });
  writeFileSync(join(slot.home, '.claude', 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `${mark} home-claude-settings SessionStart` }] }] },
  }, null, 2));
  return { slug, spots };
}
