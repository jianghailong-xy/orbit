import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TOOL_FOLD_LINES, ToolCallBody, toolCallHeading, toolCallSummary } from './ToolCallBody';

const render = (toolName: string, input: unknown, translatedDescription?: string): string =>
  renderToStaticMarkup(<ToolCallBody toolName={toolName} input={input} translatedDescription={translatedDescription} />);

const SQL = [
  'cd /root/orbit && psql -c "',
  'SELECT d.session_id, count(*) AS n',
  'FROM project_open_item_delivery d',
  'GROUP BY d.session_id;',
  '"',
].join('\n');

describe('a tool-call approval shows the call, not its JSON', () => {
  it('shows a command with its real line breaks and the description once', () => {
    const html = render('Bash', { command: SQL, description: 'Delivery state per coordinator session' });
    expect(html).toContain('SELECT d.session_id, count(*) AS n\nFROM');
    expect(html).not.toContain('\\n');
    expect(html).not.toContain('&quot;description&quot;');
    expect(html.split('Delivery state per coordinator session')).toHaveLength(2);
    expect(html).toContain('Copy');
  });

  it("puts the owner's language first and the agent's words beside it in grey", () => {
    const html = render('Bash', { command: 'npm test', description: 'Run the web tests' }, '运行 web 测试');
    expect(html.indexOf('运行 web 测试')).toBeLessThan(html.indexOf('Run the web tests'));
    expect(html).toContain('approval-desc-original');
  });

  it(`folds a command past ${TOOL_FOLD_LINES} lines`, () => {
    const command = Array.from({ length: 31 }, (_, k) => `echo ${k}`).join('\n');
    const html = render('Bash', { command });
    expect(html).toContain('echo 11');
    expect(html).not.toContain('echo 12');
    expect(html).toContain('Show 19 more lines');
  });

  it('names the settings that change the risk', () => {
    const html = render('Bash', { command: 'make', timeout: 600_000, run_in_background: true, dangerouslyDisableSandbox: true });
    expect(html).toContain('timeout 10 min');
    expect(html).toContain('runs in background');
    expect(html).toContain('sandbox off');
  });

  it('shows an edit as its path and diff', () => {
    const html = render('Edit', { file_path: '/repo/src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;', replace_all: true });
    expect(html).toContain('a.ts');
    expect(html).toContain('chat-diff');
    expect(html).toContain('Every occurrence');
    expect(html).not.toContain('old_string');
  });

  it('shows a fetch as its URL, with the prompt as its line', () => {
    const html = render('WebFetch', { url: 'https://example.com/notes', prompt: 'Summarize the notes' });
    expect(html).toContain('https://example.com/notes');
    expect(html).toContain('Summarize the notes');
  });

  it('shows an unknown tool as its fields, with the raw input behind a toggle', () => {
    const html = render('mcp__linear__create_issue', { title: 'Escaped JSON', priority: 2 });
    expect(html).toContain('kv-key');
    expect(html).toContain('Escaped JSON');
    expect(html).toContain('Show raw input');
    expect(html).not.toContain('approval-input');
  });
});

describe('the heading and the folded line', () => {
  it('asks what the call does', () => {
    expect(toolCallHeading('Bash', {})).toBe('Run a command?');
    expect(toolCallHeading('Edit', {})).toBe('Edit a file?');
    expect(toolCallHeading('WebFetch', {})).toBe('Fetch a web page?');
    expect(toolCallHeading('mcp__x__y', {})).toBe('Approve tool call?');
  });

  it("folds to the description, else the command's first line", () => {
    expect(toolCallSummary('Bash', { command: SQL, description: 'Delivery state' })).toBe('Delivery state');
    expect(toolCallSummary('Bash', { command: SQL })).toBe('cd /root/orbit && psql -c "');
  });
});
