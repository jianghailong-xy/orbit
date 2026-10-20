#!/usr/bin/env python3
"""Reduce one drive.py run to the facts §17 cites, as JSON on stdout.

Usage: python3 -I summarize.py <run-name>

Keeps the tool declarations of the first request that declares tools (name, properties, required,
additionalProperties), init.tools, every tool step, the result, the hook calls, the /hooks listing and the
workspace afterwards. Leaves out the request bodies' prompts, which are agy's and large.
"""
import json, os, sys

ROOT = '/var/tmp/agy143-doc'


def lines(path):
    if not os.path.exists(path):
        return []
    return [json.loads(l) for l in open(path) if l.strip()]


def main():
    out = os.path.join(ROOT, 'runs', sys.argv[1])
    summary = {'run': sys.argv[1]}
    meta = json.load(open(os.path.join(out, 'meta.json')))
    summary['agy_exit'] = meta['exit']
    summary['flags'] = meta['flags']
    summary['files_under_home'] = meta['files_under_home']
    summary['workspace_after'] = meta['workspace_after']
    for req in lines(os.path.join(out, 'requests.jsonl')):
        body = req.get('body') or {}
        if isinstance(body, str):
            try:
                body = json.loads(body)
            except ValueError:
                continue
        tools = body.get('tools') if isinstance(body, dict) else None
        if not tools:
            continue
        decls = []
        for t in tools:
            for d in t.get('functionDeclarations', []):
                s = d.get('parametersJsonSchema') or d.get('parameters') or {}
                decls.append({'name': d['name'], 'additionalProperties': s.get('additionalProperties'),
                              'properties': sorted((s.get('properties') or {}).keys()),
                              'required': s.get('required')})
        summary['declared_tools'] = decls
        break
    steps, result = [], None
    for e in lines(os.path.join(out, 'stdout.jsonl')):
        if e.get('event') == 'init':
            summary['init_tools'] = e['init'].get('tools')
            summary['permission_mode'] = e['init'].get('permission_mode')
        su = e.get('step_update')
        if su and su.get('step_type') == 'tool':
            info = su.get('tool_info') or {}
            steps.append({'state': su.get('state'), 'tool_name': su.get('tool_name'), 'info_name': info.get('name'),
                          'parameters': info.get('parameters'), 'output': info.get('output'),
                          'error': info.get('error')})
        if e.get('event') == 'result':
            r = e['result']
            result = {k: r.get(k) for k in ('status', 'response', 'error', 'denied_actions')}
    summary['tool_steps'] = steps
    summary['result'] = result
    hooks = []
    for h in lines(os.path.join(out, 'hooks.jsonl')):
        p = h['payload']
        hooks.append({'event': h['event'], 'payload_keys': sorted(p.keys()),
                      **({'toolCall': p.get('toolCall')} if h['event'] == 'PreToolUse' else {})})
    if hooks:
        summary['hook_calls'] = hooks
    listing = os.path.join(out, 'print-hooks.stdout')
    if os.path.exists(listing):
        data = json.loads(open(listing).read())
        summary['print_hooks'] = (data.get('command') or {}).get('data')
    stderr = open(os.path.join(out, 'stderr.txt')).read()
    summary['stderr_permission_lines'] = [l for l in stderr.splitlines() if 'permission' in l]
    json.dump(summary, sys.stdout, indent=1, ensure_ascii=False)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
