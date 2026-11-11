#!/usr/bin/env python3
"""Seed a local Orbit stack with the SubAgent transcript the web evidence used the shape of:
one finished foreground `delegate` (explore, DONE) and one running background one (general,
RUNNING). Run after the apiserver and postgres are up. Ids are read back from the database, so
the script only needs the HTTP door for the account/workspace/session rows."""
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:3000"
PG = ["docker", "exec", "-i", "orbit-shot-pg", "psql", "-U", "orbit", "-d", "orbit", "-t", "-A", "-c"]


def call(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data, timeout=30) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode()[:500], file=sys.stderr)
        raise


def sql(query):
    out = subprocess.run(PG + [query], capture_output=True, text=True)
    if out.returncode != 0:
        print(out.stderr, file=sys.stderr)
        raise SystemExit(1)
    return out.stdout.strip()


def wait_api():
    for _ in range(90):
        try:
            call("GET", "/api/auth/setup-status")
            return
        except Exception:
            time.sleep(2)
    raise SystemExit("apiserver did not come up")


def main():
    wait_api()
    status = call("GET", "/api/auth/setup-status")
    if status.get("needsSetup"):
        login = call("POST", "/api/auth/bootstrap",
                     {"email": "owner@example.com", "name": "Owner", "password": "orbit-demo-1"})
    else:
        login = call("POST", "/api/auth/login",
                     {"email": "owner@example.com", "password": "orbit-demo-1"})
    token = login["accessToken"]
    user_id = sql("select id from \"user\" where email='owner@example.com'")

    # A runner-bound workspace: session creation refuses one with no machine behind it.
    runner_id = sql("select id from runner where owner_id='%s' limit 1" % user_id)
    if not runner_id:
        runner_id = sql("insert into runner (id, name, owner_id, token_hash, status, max_concurrent) "
                        "values (gen_random_uuid(), 'demo-runner', '%s', 'x', 'ONLINE', 4) returning id;"
                        % user_id)

    ws_id = sql("select id from workspace where name='SubAgent screens' order by created_at desc limit 1")
    if not ws_id:
        ws = call("POST", "/api/workspaces",
                  {"name": "SubAgent screens", "workDir": "/Users/long/orbit-demo"}, token)
        ws_id = sql("select id from workspace where name='SubAgent screens' order by created_at desc limit 1")
    sql("update workspace set runner_id='%s' where id='%s';" % (runner_id, ws_id))

    session_id = sql("select id from session where title='Quota poller retry' order by created_at desc limit 1")
    if not session_id:
        call("POST", "/api/sessions",
             {"workspaceId": ws_id,
              "title": "Quota poller retry",
              "prompt": "Add a retry with backoff to the quota poller."}, token)
        session_id = sql("select id from session where title='Quota poller retry' order by created_at desc limit 1")

    # Model names as the owner's provider tables serve them (subagentRunView's labels).
    sql("delete from model_provider where owner_id='%s';" % user_id)
    for slug, label, runtime, models in [
        ("demo-deepseek", "DeepSeek", "claude",
         [{"value": "deepseek-chat", "label": "DeepSeek Chat"}]),
        ("demo-openai", "OpenAI", "codex",
         [{"value": "gpt-5.6-sol", "label": "GPT-5.6 Sol"}]),
    ]:
        sql("insert into model_provider (id, slug, label, runtime, base_url, api_key_enc, models, owner_id, "
            "created_at, updated_at) "
            "values (gen_random_uuid(), '%s', '%s', '%s', 'http://127.0.0.1:9', 'x', $json$%s$json$, '%s', "
            "now(), now());"
            % (slug, label, runtime, json.dumps(models), user_id))

    now = int(time.time())
    iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + ".000Z"
    t0 = now - 120

    events = [
        (1, "user", {"text": "Add a retry with backoff to the quota poller."}, t0),
        (2, "assistant", {"text": "I'll split this: one SubAgent finds the callers, another writes the spec."}, t0 + 4),
        (3, "tool_use", {"id": "toolu_sa_fg", "name": "mcp__orbit__delegate",
                         "input": {"description": "Find every caller of pollQuota", "type": "explore",
                                   "prompt": "Find every caller of pollQuota in src/. Report file paths only."}}, t0 + 6),
        (4, "tool_use", {"id": "sa_fg_1", "name": "Grep",
                         "input": {"pattern": "pollQuota", "path": "src/"},
                         "parentToolUseId": "toolu_sa_fg"}, t0 + 9),
        (5, "tool_result", {"toolUseId": "sa_fg_1",
                            "content": "src/poller.ts:14\nsrc/quota.ts:88\nsrc/retry.ts:41",
                            "parentToolUseId": "toolu_sa_fg"}, t0 + 11),
        (6, "assistant", {"text": "Three callers: poller.ts, quota.ts and retry.ts.",
                          "parentToolUseId": "toolu_sa_fg"}, t0 + 13),
        (7, "tool_result", {"toolUseId": "toolu_sa_fg",
                            "content": json.dumps({"runId": "sa_fg", "status": "DONE",
                                                   "result": "Three callers, all in quota/.",
                                                   "changedFiles": [], "model": "deepseek-chat",
                                                   "costUsd": 0.03}, separators=(",", ":"))}, t0 + 16),
        (8, "tool_use", {"id": "toolu_sa_bg", "name": "mcp__orbit__delegate",
                         "input": {"description": "Write the backoff spec", "type": "general",
                                   "background": True,
                                   "prompt": "Write the backoff spec for the quota poller in docs/poller.spec.md."}}, t0 + 18),
        (9, "tool_result", {"toolUseId": "toolu_sa_bg",
                            "content": json.dumps({"runId": "sa_bg", "status": "running"},
                                                  separators=(",", ":"))}, t0 + 19),
        (10, "tool_use", {"id": "sa_bg_1", "name": "Edit",
                          "input": {"file_path": "docs/poller.spec.md", "old_string": "## Retry",
                                    "new_string": "## Retry\n\nExponential backoff, 5 attempts."},
                          "parentToolUseId": "toolu_sa_bg"}, t0 + 26),
        (11, "assistant", {"text": "Three callers, all in quota/. Changing the helper now."}, t0 + 30),
    ]
    sql("delete from run_event where session_id='%s';" % session_id)
    for seq, kind, payload, ts in events:
        sql("insert into run_event (id, session_id, seq, type, payload, created_at) values "
            "(gen_random_uuid(), '%s', %d, '%s', $json$%s$json$, '%s+00');"
            % (session_id, seq, kind, json.dumps(payload), iso(ts)))

    fg_decision = {
        "level": "S", "tierSource": "builtin", "optimizeFor": "cost",
        "engine": "claude", "provider": "demo-deepseek", "model": "deepseek-chat", "effort": None,
        "applied": True,
        "reasons": ["Tier S, set by the built-in explore default", "Optimize For: Cost",
                    "Cheapest of 5 providers with quota on this runner"],
        "candidates": [], "policyVersion": "1",
    }
    bg_decision = {
        "level": "M", "tierSource": "caller", "optimizeFor": "cost",
        "engine": "codex", "provider": "demo-openai", "model": "gpt-5.6-sol", "effort": None,
        "applied": True,
        "reasons": ["Tier M, set by the caller: one service plus its spec", "Optimize For: Cost",
                    "Cheapest of 5 providers with quota on this runner"],
        "candidates": [], "policyVersion": "1",
    }
    sql("delete from subagent_run where session_id='%s';" % session_id)
    sql("insert into subagent_run (id, owner_id, session_id, tool_use_id, type, definition_source, "
        "background, status, decision, result_summary, cost_usd, created_at, ended_at) values "
        "(gen_random_uuid(), '%s', '%s', 'toolu_sa_fg', 'explore', 'builtin', false, 'DONE', "
        "$json$%s$json$, 'Three callers, all in quota/.', 0.03, '%s+00', '%s+00');"
        % (user_id, session_id, json.dumps(fg_decision), iso(t0 + 16), iso(t0 + 57)))
    sql("insert into subagent_run (id, owner_id, session_id, tool_use_id, type, definition_source, "
        "background, status, decision, result_summary, cost_usd, created_at, ended_at) values "
        "(gen_random_uuid(), '%s', '%s', 'toolu_sa_bg', 'general', 'builtin', true, 'RUNNING', "
        "$json$%s$json$, null, 0, '%s+00', null);"
        % (user_id, session_id, json.dumps(bg_decision), iso(t0 + 18)))

    print(json.dumps({"session": session_id, "workspace": ws_id, "email": "owner@example.com"},
                     indent=2))


if __name__ == "__main__":
    main()
