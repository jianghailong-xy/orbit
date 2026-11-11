import json, glob, os, sys, re
REC = sys.argv[1]; OUT = sys.argv[2]
ROOT = os.path.dirname(os.path.abspath(REC))  # drive.sh's ROOT: rec/, work/ and home-<scenario>/ sit in it
os.makedirs(OUT, exist_ok=True)
KEEP_H = ['accept','content-type','user-agent','anthropic-beta','anthropic-version','x-app','x-stainless-retry-count','x-stainless-timeout','x-stainless-package-version','anthropic-dangerous-direct-browser-access']
SESSION = '00000000-0000-4000-8000-000000000000'
basic_tools = json.load(open(f'{REC}/basic/003-main.json'))['body']['tools']
def scrub(o):
    s = json.dumps(o, ensure_ascii=False)
    s = s.replace(ROOT + '/work', '/work')
    s = re.sub(re.escape(ROOT) + r'/home-[A-Za-z0-9-]+', '/home/recorder', s)
    s = re.sub(r'\ba[0-9a-f]{16}\b', 'a0000000000000000', s)
    s = re.sub(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', SESSION, s)
    s = re.sub(r'\\"device_id\\":\\"[0-9a-f]{64}\\"', r'\\"device_id\\":\\"' + '0'*64 + r'\\"', s)
    s = re.sub(r'agentId: [0-9a-f]{17}', 'agentId: a0000000000000000', s)
    s = re.sub(r"to: '[0-9a-f]{17}'", "to: 'a0000000000000000'", s)
    s = re.sub(r'cc_version=2\.1\.322\.[0-9a-f]{3}', 'cc_version=2.1.322.000', s)
    return json.loads(s)
SC = {
 'basic': 'One plain turn: the first /v1/messages request of a session, full body and headers.',
 'effort-low': '--effort low', 'effort-medium': '--effort medium', 'effort-high': '--effort high',
 'effort-xhigh': '--effort xhigh', 'effort-max': '--effort max', 'effort-none': 'no --effort flag',
 'thinking': 'Recorder answers thinking(signature orbit1.…)+tool_use; the next request carries the thinking block back.',
 'thinkturns': 'Three user turns, each answered thinking+text; later requests carry every earlier thinking block.',
 'parallel': 'Recorder answers two tool_use blocks (one exits 3); the next request carries both tool_results.',
 'image-r2': 'Recorder answers Read on an 8x8 PNG; the next request carries a tool_result with an image block.',
 'subagent-r2': 'Recorder answers an Agent tool_use; the subagent request and the main follow-ups.',
 'toolsearch-r2': 'ToolSearch select:WebFetch then WebFetch https://example.com/, ANTHROPIC_DEFAULT_HAIKU_MODEL unset.',
 'toolsearch-haikur2': 'The same with ANTHROPIC_DEFAULT_HAIKU_MODEL=gpt-5.5-mini.',
 'toolong-r2': 'Turn 2 answered 400 "prompt is too long: 250000 tokens > 200000 maximum": the CLI compacts and retries.',
 'toolong-openai': 'Turn 2 answered 400 with OpenAI\'s context_length_exceeded wording: the CLI re-sends once, no compaction.',
 'toolong': 'Turn 1 answered 400 "prompt is too long…": a single-exchange conversation cannot be compacted.',
 'context-x': '/context: count_tokens requests.',
}
for sc, what in SC.items():
    files = sorted(glob.glob(f'{REC}/{sc}/*.json'))
    reqs = []
    for f in files:
        d = json.load(open(f))
        role = os.path.basename(f)[4:-5]
        if d['method'] == 'HEAD':
            reqs.append({'role': role, 'method': 'HEAD', 'path': d['url']}); continue
        b = d['body']
        if b and b.get('tools') == basic_tools and not (sc == 'basic'):
            b = dict(b); b['tools'] = '$basic.tools'
        h = {k: d['headers'][k] for k in KEEP_H if k in d['headers']}
        h['authorization'] = 'Bearer orbit-gwk-<redacted>'
        h['x-claude-code-session-id'] = SESSION
        reqs.append({'role': role, 'method': d['method'], 'path': d['url'], 'headers': h, 'body': b})
    outcome = []
    p = f'{REC}/{sc}.stdout.jsonl'
    if os.path.exists(p):
        for l in open(p):
            try: j = json.loads(l)
            except Exception: continue
            if j.get('type') == 'result':
                outcome.append({k: j.get(k) for k in ('is_error','terminal_reason','api_error_status','result','num_turns')})
            if j.get('type') == 'system' and j.get('subtype') == 'compact_boundary':
                outcome.append({'compact_boundary': (j.get('compact_metadata') or {}).get('trigger')})
    out = {'cli': 'claude 2.1.322',
           'recordedAt': '2026-11-11', 'scenario': what,
           'recipe': 'scripts/claude-gateway-recorder/drive.sh ' + sc, 'requests': scrub(reqs), 'outcome': scrub(outcome)}
    json.dump(out, open(f'{OUT}/{sc}.json', 'w'), indent=1, ensure_ascii=False)
    print(sc, len(reqs), os.path.getsize(f'{OUT}/{sc}.json'))
