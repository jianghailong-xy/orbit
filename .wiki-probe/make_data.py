#!/usr/bin/env python3
"""TEMPORARY evidence probe: the reads the probe app draws, shaped as the server answers them — the same
rows the web phone screenshots are drawn from (/var/tmp/wk89-shots/probe-src/probe.tsx). Review holds
nothing, so every run is read by its own id (GET /api/wiki/changesets/:id)."""
import json, sys
from datetime import datetime, timedelta, timezone

NOW = datetime(2026, 9, 28, 9, 41, tzinfo=timezone.utc)
def ago(minutes):
    return (NOW - timedelta(minutes=minutes)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
def uuid(n):
    return f"0196b900-0000-7000-8000-{n:012d}"

SPACE, RUN_A, RUN_B, OWN_1, OWN_2, SESSION = uuid(1), uuid(21), uuid(22), uuid(23), uuid(24), uuid(31)
MAIN = '1588c3b' + '4' * 33
MODEL = 'qwen3.8-27b-fp8'

space = {"id": SPACE, "slug": "orbit", "title": "orbit", "repoUrlNorm": "github.com/jianghailong-xy/orbit", "rootCommitSha": MAIN,
         "settings": {"push": True, "autoAcceptReinforce": True, "reviewMode": "automatic", "automaticSpotChecks": False,
                      "maintenance": {"enabled": True, "workspaceId": "ws-orbit", "provider": "local-vllm", "dailyRunLimit": 8, "listId": "list"}},
         "createdAt": ago(60 * 24 * 5), "updatedAt": ago(60), "pendingOps": 0,
         "usage": {"days": 7, "sessionsPushed": 186, "searches": 41, "gets": 12, "entries": []}}

def entry(n, **over):
    e = {"id": uuid(n), "spaceId": SPACE, "kind": "pitfall", "status": "active", "trust": "auto", "currentRevision": 1,
         "title": "", "summary": "", "fields": {}, "topics": ["ui-design"], "aliases": [], "anchors": [], "anchorState": "unchecked",
         "anchorCheckedRef": None, "anchorCheckedAt": None, "tainted": False, "challenged": False, "unsupported": False, "pinned": False,
         "supersedesId": None, "supersededById": None, "validFrom": ago(125), "validTo": None, "recordedAt": ago(125), "retiredAt": None}
    e.update(over)
    return e

A1 = entry(41, title='captureBeyondViewport 重排致截图横向偏移', summary='CDP 截图开 captureBeyondViewport 会触发重排导致横向偏移；应设 false 并按元素 rect 裁切。',
           fields={"symptom": "并排截图出现横向错位", "cause": "captureBeyondViewport true 时触发重排", "fix": "设 false，按元素 rect 裁切"})
A2 = entry(42, kind='recipe', trust='unreviewed', title='重出 mock PNG 前先复现原图校验渲染管线', summary='先把原图复现一遍，确认字体与窗口一致再改。',
           fields={"steps": ["用原参数重出一张", "与原图逐像素比对", "再改"], "verify": {"command": "ls docs/mocks/*.png", "expectedExit": 0}})
A3 = entry(43, kind='convention', currentRevision=2, title='hover 只改可见性不改布局，kebab 预留占位淡入', summary='hover 时不引入新元素挤动布局，kebab 菜单槽位始终占位、默认隐藏。',
           fields={"rule": "hover 只改 opacity/visibility，不改尺寸", "scope": ["src/web/src/components/"]})
A4 = entry(44, kind='recipe', title='用 chromium headless 渲染 mock HTML 生成 PNG 效果图', summary='chromium --headless=new 配 --window-size 与 --force-device-scale-factor 出 PNG。')
A5 = entry(45, kind='convention', title='UI 效果图按仓库惯例放进 docs/mocks/', summary='批准的效果图（html 和 png）放进 docs/mocks/ 目录。')
A6 = entry(46, trust='unreviewed', title='antd Popover 挂在 line-height 0 的上标里会盖住被点的数字', summary='给按钮 display:inline-block; line-height:1.15。', topics=['web-client'])
A7 = entry(47, title='headless chromium 窗口最窄 500', summary='--window-size=393 实际 innerWidth=500，真 393 要套 iframe。')
A8 = entry(48, trust='confirmed', title='worktree index.lock 残留导致 git add 报 Exit 128', summary='先删掉残留的 index.lock 再提交。')
B = [entry(51 + i, kind='convention', trust='unreviewed' if i == 3 else 'auto', title=t, summary=t + '。', validFrom=ago(60 * 26), recordedAt=ago(60 * 26))
     for i, t in enumerate(['与 owner 协作一律用中文回复', '改 UI 先给效果图、分档选项等 owner 拍板', '先查 running 再判断会话开着', '发版前先 dispatch client.yml'])]
OWNER_DECISION = entry(61, kind='decision', trust='confirmed', title='iOS 对齐设计先出效果图并给 A/B/C 多方案，由 owner 拍板', summary='效果图先行，owner 选定再接线。')
RETIRED = entry(62, kind='concept', trust='confirmed', status='retired', title='狼人杀「板子」默认 12 人预女猎白', summary='与本代码库无关。', retiredAt=ago(300))
ENTRIES = [A1, A2, A3, A4, A5, A6, A7, A8, *B, OWNER_DECISION, RETIRED]
BY_ID = {e["id"]: e for e in ENTRIES}

def verdict(v, minutes=119):
    reason = {"supported": "The cited turn says so.", "partial": "One of the two cited turns backs it."}.get(v, "No cited record says it.")
    return {"verdict": v, "reason": reason, "model": MODEL, "at": ago(minutes), "duplicateOf": None, "evidence": "readable"}

def op(cs, n, seq, kind, decision, **over):
    o = {"id": uuid(n), "changesetId": cs, "seq": seq, "op": kind, "entryId": None, "baseRevision": None, "payload": {}, "similar": [],
         "tainted": False, "decision": decision, "decisionReason": None, "decisionNote": None, "resultEntryId": None, "resultRevision": 1,
         "decidedAt": ago(119), "appliedByMode": "automatic", "spotCheck": False, "verification": verdict("supported"), "verificationHistory": []}
    o.update(over)
    return o

RUN_A_OPS = [
    op(RUN_A, 101, 0, 'add', 'auto_applied', resultEntryId=A1["id"]),
    op(RUN_A, 102, 1, 'add', 'auto_applied', resultEntryId=A2["id"], verification=verdict('partial')),
    op(RUN_A, 103, 2, 'add', 'auto_applied', resultEntryId=A4["id"]),
    op(RUN_A, 104, 3, 'add', 'auto_applied', resultEntryId=A5["id"]),
    op(RUN_A, 105, 4, 'add', 'auto_applied', resultEntryId=A6["id"], verification=verdict('partial')),
    op(RUN_A, 106, 5, 'add', 'auto_applied', resultEntryId=A7["id"]),
    op(RUN_A, 107, 6, 'amend', 'auto_applied', entryId=A3["id"], baseRevision=1, resultRevision=2, payload={"changes": {"summary": A3["summary"]}}),
    op(RUN_A, 108, 7, 'reinforce', 'auto_applied', entryId=A8["id"], resultRevision=None, appliedByMode=None, verification=None),
    op(RUN_A, 109, 8, 'add', 'rejected', resultEntryId=uuid(70), appliedByMode=None, decisionReason='not_true',
       payload={"entry": {"title": "截图前必须重启 chromium"}}, verification=verdict('unsupported')),
]
RUN_B_OPS = [op(RUN_B, 121 + i, i, 'add', 'auto_applied', resultEntryId=e["id"], appliedByMode='tiered', verification=None, decidedAt=ago(60 * 26))
             for i, e in enumerate(B)]

def view(cs, origin, created, ops, mode, counts, revert):
    named = {x for o in ops for x in (o["entryId"], o["resultEntryId"]) if x}
    base = {"applied": 0, "auto": 0, "unreviewed": 0, "rejectedByCheck": 0, "toReview": 0}
    base.update(counts)
    return {"id": cs, "spaceId": SPACE, "origin": origin, "sessionId": SESSION if origin == 'maintenance' else None, "toolCallId": None,
            "rationale": 'Wiki maintenance' if origin == 'maintenance' else 'Import', "status": "settled", "createdAt": created,
            "decidedAt": None, "expiresAt": None, "ops": ops, "appliedByMode": mode,
            "entries": [e for e in ENTRIES if e["id"] in named], "counts": base, "revertible": revert is not None, "revert": revert}

run_a = view(RUN_A, 'maintenance', ago(125), RUN_A_OPS, 'automatic', {"applied": 8, "auto": 5, "unreviewed": 2, "rejectedByCheck": 1}, {"adds": 6, "amends": 1})
run_b = view(RUN_B, 'import', ago(60 * 26), RUN_B_OPS, 'tiered', {"applied": 4, "auto": 3, "unreviewed": 1}, {"adds": 4, "amends": 0})

def item(o, cs, origin, mode, at, e, **over):
    x = {"opId": o["id"], "changesetId": cs, "changesetAppliedByMode": mode, "op": o["op"], "decision": o["decision"], "origin": origin,
         "appliedByMode": o["appliedByMode"], "spotCheck": False, "at": at, "entryId": e["id"], "title": e["title"], "kind": e["kind"],
         "status": e["status"], "trust": e["trust"], "supersededById": None, "supersededByTitle": None, "reason": None}
    x.update(over)
    return x

timeline = [item(o, RUN_A, 'maintenance', 'automatic', ago(118 + i), BY_ID[o["resultEntryId"] or o["entryId"]])
            for i, o in enumerate(x for x in RUN_A_OPS if x["decision"] == 'auto_applied')]
timeline.append(item(op(OWN_1, 131, 0, 'add', 'accepted', appliedByMode=None), OWN_1, 'agent', None, ago(180), OWNER_DECISION))
timeline.append(item(op(OWN_2, 132, 0, 'retire', 'auto_applied', appliedByMode=None), OWN_2, 'owner', None, ago(300), RETIRED, reason='not this codebase'))
timeline += [item(o, RUN_B, 'import', 'tiered', ago(60 * 26 + i), B[i]) for i, o in enumerate(RUN_B_OPS)]

def detail(e):
    o = next((x for x in RUN_A_OPS if x["resultEntryId"] == e["id"] or (x["op"] == 'amend' and x["entryId"] == e["id"])), None)
    d = dict(e)
    d.update({"changesetId": RUN_A if o else None, "appliedByMode": o["appliedByMode"] if o else None, "verification": o["verification"] if o else None,
              "sources": [{"id": e["id"] + "-s1", "kind": "turn", "ref": SESSION, "locator": {"seq": 12, "turnId": uuid(32)}, "quote": e["summary"],
                           "quoteVerified": True, "state": "live", "tainted": False, "createdAt": ago(125)}],
              "history": [{"id": e["id"] + "-r1", "revision": e["currentRevision"], "title": e["title"], "summary": e["summary"],
                           "authorKind": "maintenance", "authorSessionId": SESSION, "changesetOpId": o["id"] if o else None, "createdAt": ago(120)}],
              "exposure": []})
    return d

POOL = [A1, A2, A4, A5, A3, A6]
article = {"spaceId": SPACE, "topic": {"slug": "ui-design", "title": "UI 设计", "category": "clients", "categoryTitle": "Clients & UI"},
           "part": 1, "kind": "subtopic", "title": "Orbit 仓库 UI 效果图生成与验收规范",
           "blocks": [{"heading": None, "sentences": [{"text": "Orbit 仓库规定 UI 变更先出效果图，批准的效果图放进 `docs/mocks/`。", "notes": [1]},
                                                      {"text": "效果图用 `chromium --headless=new` 渲染为 PNG。", "notes": [2]}]},
                      {"heading": "常见陷阱", "sentences": [{"text": "截图开 **captureBeyondViewport** 会触发重排，并排截图因此错位。", "notes": [3]},
                                                        {"text": "重出 PNG 前先复现原图，确认渲染管线一致。", "notes": [4]}]}],
           "footnotes": [{"n": i + 1, "entryId": e["id"], "revision": 1,
                          "entry": {k: e[k] for k in ("id", "kind", "title", "summary", "status", "trust", "currentRevision")}}
                         for i, e in enumerate([A5, A4, A1, A2])],
           "entryCount": len(POOL), "entryIds": [e["id"] for e in POOL], "entries": POOL, "chars": 180, "generatedAt": ago(90), "ref": MAIN,
           "model": MODEL, "overview": {"part": 0, "kind": "overview", "title": "UI 设计", "entryCount": 147},
           "parts": [{"part": 1, "kind": "subtopic", "title": "Orbit 仓库 UI 效果图生成与验收规范", "entryCount": len(POOL)}]}

bundle = {"now": NOW.strftime('%Y-%m-%dT%H:%M:%S.000Z'), "space": space, "entries": ENTRIES, "timeline": timeline,
          "runA": run_a, "runB": run_b, "unreviewed": detail(A2), "article": article}
text = json.dumps(bundle, ensure_ascii=False, indent=1)
assert '"""#' not in text
out = sys.argv[1]
with open(out, 'w', encoding='utf-8') as f:
    f.write('// GENERATED by make_data.py — TEMPORARY evidence probe.\n\nlet probeDataJSON = #"""\n' + text + '\n"""#\n')
print('wrote', out, len(text))
