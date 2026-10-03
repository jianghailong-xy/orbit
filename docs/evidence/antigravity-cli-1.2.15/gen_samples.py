#!/usr/bin/env python3
"""Record the agy 1.2.15 stream-json samples kept in src/runner-go/testdata/antigravity/.

Each sample runs real agy against mockgemini through drive.py, then is exported with
machine-specific paths normalised. usage: gen_samples.py <out-dir>
"""
import json, os, re, subprocess, sys, shutil, concurrent.futures

ROOT = '/var/tmp/agy-c0'
OUT = sys.argv[1]
EXPORT_ONLY = '--export-only' in sys.argv
R = ROOT + '/runs/'
BASE = ["--print=", "--input-format", "stream-json", "--output-format", "stream-json"]
SKIP = BASE + ["--dangerously-skip-permissions"]
SETTINGS = {"enableTelemetry": False}
ENV = {"AGY_CLI_DISABLE_AUTO_UPDATE": "true", "ORBIT_SESSION_ID": "sample-session"}


def rc(cmd, ws, wait=10000):
    return 'mock:tool run_command ' + json.dumps({"CommandLine": cmd, "Cwd": ws, "WaitMsBeforeAsync": wait,
                                                   "toolSummary": "Command", "toolAction": "Running command"})


def tool(name, args):
    return f'mock:tool {name} ' + json.dumps({**args, "toolSummary": name, "toolAction": "Using " + name})


def turns(prompts, final=True):
    steps = []
    for i, p in enumerate(prompts):
        steps += [{"send": p}, {"wait_result": i + 1, "timeout": 90}]
    if final:
        steps += [{"close_stdin": True}, {"wait_exit": 20}]
    return steps


def ws(n):
    return R + 's_' + n + '/ws'


S = {}
S['text-multiturn'] = {
    "note": "Two turns in one process. The thought part the model sent is never surfaced; text arrives as ACTIVE deltas then a DONE step; result.num_turns and result.usage are cumulative over the session.",
    "steps": turns(["hello\nmock:think weighing how to greet\nmock:text Hello! This answer is streamed in several chunks, so the CLI emits ACTIVE text deltas before the DONE step.",
                    "and again\nmock:text Second turn, one chunk."])}
w = ws('tools-skip-permissions')
S['tools-skip-permissions'] = {
    "note": "--dangerously-skip-permissions. Tool steps go ACTIVE -> DONE (tool_info.output) or ERROR (tool_info.error). tool_info.parameters is a display subset. A failing command is still DONE: no exit code is reported.",
    "args": SKIP, "files": {"ws:existing.txt": "old line\n"},
    "steps": turns(["do the work\n" + "\n".join([
        rc("echo hi-from-tool && pwd", w),
        tool("write_to_file", {"TargetFile": w + "/made.txt", "CodeContent": "made\n", "Overwrite": False, "Description": "create a file"}),
        tool("replace_file_content", {"TargetFile": w + "/existing.txt", "TargetContent": "old line", "ReplacementContent": "new line", "StartLine": 1, "EndLine": 1, "AllowMultiple": False, "Instruction": "edit", "Description": "edit a line"}),
        tool("view_file", {"AbsolutePath": w + "/made.txt"}),
        rc("ls /nonexistent-dir-xyz", w),
        tool("no_such_tool", {"x": 1}),
        "mock:text all done"])])}
w = ws('denied-default')
S['denied-default'] = {
    "note": "Default (request-review) mode headless: a tool that needs approval is soft-denied, the turn ends at once with response \"\" and status SUCCESS; denied_actions is a cumulative de-duplicated set; stderr carries one 'jetski: no output produced' line per denied turn.",
    "steps": turns(["run it\n" + rc("echo hi", w) + "\nmock:text unreachable",
                    "write it\n" + tool("write_to_file", {"TargetFile": w + "/x.txt", "CodeContent": "x\n", "Overwrite": False, "Description": "d"}) + "\nmock:text unreachable",
                    "just talk\nmock:text plain answer still works"])}
S['error-invalid-key'] = {
    "note": "API key rejected (400 API_KEY_INVALID): error_message step, result status ERROR, AGY_ERROR JSON on stderr, process exits 3 and the second prompt is never answered.",
    "mock_args": ["-want-key", "the-right-key"],
    "steps": [{"send": "hello\nmock:text unreachable"}, {"wait_result": 1, "timeout": 90}, {"send": "again\nmock:text unreachable"}, {"wait_exit": 30}]}
S['error-quota-429'] = {
    "note": "429 RESOURCE_EXHAUSTED with RetryInfo 40s: no retry (delay > 30s), AGY_ERROR retryable:true, exit 3.",
    "steps": [{"send": "hello\nmock:error 429 RESOURCE_EXHAUSTED retryDelay=40s You exceeded your current quota"}, {"wait_result": 1, "timeout": 90}, {"wait_exit": 30}]}
S['interrupt-sigint-streaming'] = {
    "note": "SIGINT while the model streams: result status ERROR, error \"interrupted\", response holds the partial text, usage zero, exit 1.",
    "steps": [{"send": "long answer\nmock:text partial answer before the interrupt\nmock:hang"}, {"wait_event": "text_delta", "timeout": 60}, {"sleep": 1}, {"signal": "INT"}, {"wait_exit": 30}]}
w = ws('interrupt-sigint-tool')
S['interrupt-sigint-tool'] = {
    "note": "SIGINT while run_command runs: agy kills the command's process group, the tool step never reaches DONE, result ERROR \"interrupted\", exit 1.",
    "args": SKIP,
    "steps": [{"send": "slow\n" + rc("sleep 30; echo finished", w, 60000) + "\nmock:text unreachable"}, {"wait_event": "\"state\":\"ACTIVE\",\"step_type\":\"tool\"", "timeout": 60}, {"sleep": 2}, {"signal": "INT"}, {"wait_exit": 30}]}
S['midturn-message-queued'] = {
    "note": "A second prompt written while turn 1's model call is in flight is queued and becomes its own turn after turn 1's result (default queuedMessages; send-immediately behaves the same in print mode).",
    "steps": [{"send": "first\nmock:sleep 4s\nmock:text reply to first"}, {"wait_event": "user_input", "timeout": 60}, {"sleep": 1},
              {"send": "second, sent mid-turn\nmock:text reply to second"}, {"wait_result": 2, "timeout": 60}, {"close_stdin": True}, {"wait_exit": 20}]}
S['slash-model-ends-session'] = {
    "note": "A CLI-handled slash command in the stream (/model) ends the session: result ERROR, exit 2. --disable-slash-commands sends it to the model as text instead.",
    "steps": [{"send": "/model"}, {"wait_result": 1, "timeout": 60}, {"wait_exit": 30}]}
S['unknown-conversation'] = {
    "note": "--conversation with an id this gemini dir does not hold: a warning on stderr, then a brand-new conversation with a new id, exit 0.",
    "args": BASE + ["--conversation", "00000000-1111-2222-3333-444444444444"],
    "steps": turns(["hello\nmock:text fresh conversation"])}
S['ask-question-headless'] = {
    "note": "ask_question cannot reach a human headless: the step is reported as step_type \"unknown\" with no details and the model is told \"User Skipped\".",
    "steps": turns(["ask me\n" + tool("ask_question", {"questions": [{"question": "Which colour?", "options": ["red", "blue"], "is_multi_select": False}]}) + "\nmock:text after asking"])}
S['mcp-call'] = {
    "note": "A stdio MCP server from <gemini_dir>/config/mcp_config.json is reached through call_mcp_tool; the server inherits agy's environment (ORBIT_SESSION_ID).",
    "args": SKIP,
    "files": {"gd:config/mcp_config.json": {"mcpServers": {"orbit": {"command": "python3", "args": [ROOT + "/fakemcp.py", "orbit"]}}}},
    "steps": turns(["mcp\n" + tool("call_mcp_tool", {"ServerName": "orbit", "ToolName": "whoami", "Arguments": {"note": "hello"}}) + "\nmock:text mcp finished"])}
w = ws('hook-deny')
S['hook-deny'] = {
    "note": "Under --dangerously-skip-permissions a PreToolUse hook from <gemini_dir>/config/hooks.json is the gate: deny -> tool step ERROR with the hook's reason, the model continues.",
    "args": SKIP,
    "files": {"gd:config/hooks.json": {"orbit-gate": {"PreToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": f"python3 {ROOT}/hook.py gate deny", "timeout": 600}]}]}}},
    "steps": turns(["try it\n" + rc("echo gated", w) + "\nmock:text the hook said no"])}

# Two-process samples: the second half resumes the first half's conversation.
TWO = {
    'resume': ({"note": "First process.", "steps": turns(["remember PAPAYA\nmock:text noted PAPAYA"])},
               {"note": "Second process with --conversation: same conversation_id, step_index continues, a system_message step is injected, num_turns/usage include the earlier process.",
                "steps": turns(["what word?\nmock:text resumed fine"])}),
    'resume-after-error': ({"note": "First process ends on a 400 error (exit 3).",
                            "steps": [{"send": "fails\nmock:error 400 INVALID_ARGUMENT Request contains an invalid argument."}, {"wait_result": 1, "timeout": 90}, {"wait_exit": 30}]},
                           {"note": "Resumed: both turns succeed (no error_message step, process stays up) but every result still says status ERROR with the old error.",
                            "steps": turns(["turn A\nmock:text A ok", "turn B\nmock:text B ok"])}),
}


def scen_for(name, spec, gd=None, conv=None):
    s = {"settings": SETTINGS, "env": ENV}
    s.update({k: v for k, v in spec.items() if k != 'note'})
    if gd:
        s['gd'] = gd
    if conv:
        s['args'] = list(s.get('args', BASE)) + ["--conversation", conv]
    return s


def run(name, scen):
    p = f'{ROOT}/sc/sample-{name}.json'
    json.dump(scen, open(p, 'w'), indent=1)
    out = subprocess.run(['timeout', '300', 'python3', ROOT + '/drive.py', 's_' + name, p], capture_output=True, text=True)
    return name, out.stdout.strip()


def conv_id(name):
    for l in open(R + 's_' + name + '/stdout.jsonl'):
        line = json.loads(l)['line']
        if line.startswith('{"event":"init"'):
            return json.loads(line)['conversation_id']


if not EXPORT_ONLY:
  with concurrent.futures.ThreadPoolExecutor(5) as ex:
    futs = [ex.submit(run, n, scen_for(n, spec)) for n, spec in S.items()]
    for n, (a, b) in TWO.items():
        gd = f'{ROOT}/shared/sample-{n}-gd'
        shutil.rmtree(gd, ignore_errors=True)
    futs += [ex.submit(run, n + '.1', scen_for(n + '.1', a, gd=f'{ROOT}/shared/sample-{n}-gd')) for n, (a, b) in TWO.items()]
    for f in futs:
        print(*f.result())
  for n, (a, b) in TWO.items():
    cid = conv_id(n + '.1')
    print(*run(n + '.2', scen_for(n + '.2', b, gd=f'{ROOT}/shared/sample-{n}-gd', conv=cid)))


def normalise(text, name, gd=None):
    run_dir = R + 's_' + name
    text = text.replace(run_dir + '/ws', '/work/repo').replace(run_dir + '/home', '/work/home')
    text = text.replace(gd or (run_dir + '/gd'), '/work/orbit-gemini')
    text = text.replace(ROOT + '/', '/work/tools/')
    text = re.sub(r'http://127\.0\.0\.1:\d+', 'http://127.0.0.1:MOCK', text)
    return text


def export(name, spec, sample_dir, gd=None):
    os.makedirs(sample_dir, exist_ok=True)
    run_dir = R + 's_' + name
    stdout = [json.loads(l)['line'] for l in open(run_dir + '/stdout.jsonl')]
    open(sample_dir + '/stdout.jsonl', 'w').write(normalise('\n'.join(stdout) + '\n', name, gd))
    err = re.sub(r'^\[[0-9.]+\] ', '', open(run_dir + '/stderr.txt').read(), flags=re.M)
    open(sample_dir + '/stderr.txt', 'w').write(normalise(err, name, gd))
    scen = json.load(open(f'{ROOT}/sc/sample-{name}.json'))
    sent, driver = [], []
    for step in scen.get('steps', []):
        if 'send' in step:
            sent.append(json.dumps({"event": "user", "message": {"content": step['send']}}, ensure_ascii=False))
            driver.append(f"write stdin line {len(sent)}")
        elif 'wait_result' in step:
            driver.append(f"wait for result #{step['wait_result']}")
        elif 'wait_event' in step:
            driver.append(f"wait for an event containing {step['wait_event']}")
        elif 'signal' in step:
            driver.append(f"send SIG{step['signal']} to agy")
        elif 'close_stdin' in step:
            driver.append("close stdin")
        elif 'sleep' in step:
            driver.append(f"sleep {step['sleep']}s")
        elif 'wait_exit' in step:
            driver.append("wait for exit")
    open(sample_dir + '/stdin.jsonl', 'w').write(normalise('\n'.join(sent) + '\n', name, gd))
    stdin = driver
    argv = json.load(open(run_dir + '/argv.json'))['argv']
    exit_code = None
    for line in open(run_dir + '/steps.txt'):
        if 'final exit=' in line:
            exit_code = int(line.rsplit('=', 1)[1])
    meta = {"agy": "1.2.15", "recorded": "2026-10-03", "argv": [normalise(a, name, gd) for a in argv[1:]],
            "settings": SETTINGS, "exit": exit_code, "note": spec.get('note', '')}
    files = {k: v for k, v in spec.get('files', {}).items()}
    if files:
        meta['files'] = json.loads(normalise(json.dumps(files), name, gd))
    if spec.get('mock_args'):
        meta['mock_args'] = spec['mock_args']
    meta['driver'] = json.loads(normalise(json.dumps(stdin), name, gd))
    json.dump(meta, open(sample_dir + '/meta.json', 'w'), indent=2, ensure_ascii=False)
    open(sample_dir + '/meta.json', 'a').write('\n')


shutil.rmtree(OUT, ignore_errors=True)
for n, spec in S.items():
    export(n, spec, OUT + '/' + n)
for n, (a, b) in TWO.items():
    gd = f'{ROOT}/shared/sample-{n}-gd'
    export(n + '.1', a, OUT + '/' + n + '/1-first-process', gd)
    export(n + '.2', b, OUT + '/' + n + '/2-resumed-process', gd)
print('exported to', OUT)
