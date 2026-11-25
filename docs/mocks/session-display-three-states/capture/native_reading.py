# Today's Apple (OrbitKit, Mac and iPhone) and Android drawing per fixture row, read from source at main 9f94177875
# (a reading, not a run: no Swift or Kotlin was executed). Function names follow the clients':
#   Apple: SessionStatusGlyph.make (K/App/SessionStatusGlyph.swift:100-205), SessionLine.make (K/App/SessionLine.swift:40-145),
#   SessionHeader.statusWord (:52-99) / displayRunState (:20-26), SessionRef.resolvedRunState (K/Models/Tasks.swift:365-374),
#   ShareMarkdown.runLabel (:87-104), OrbitLinkCard.statusWord (:301-315, legacy fields only), SessionTimeGrouping.
#   iPhone row cue: SessionLiveIndicator (A/Views/AgentsView.swift:1935-1977). Android: SessionLiveMark
#   (directory/SessionListPage.kt:153-170), SessionLine.kt, tasks/TaskLogic.kt, DirectoryModels.kt buckets.
# Run: python3 native_reading.py  -> native-before.json
import json, os
KNOWN={"PENDING","RUNNING","AWAITING_INPUT","SUCCEEDED","FAILED","INTERRUPTED","CANCELLED"}
RS={"QUEUED","RUNNING","AWAITING_INPUT","INTERRUPTED","SUCCEEDED","FAILED","ENDED"}
KNOWN={"PENDING","RUNNING","AWAITING_INPUT","SUCCEEDED","FAILED","INTERRUPTED","CANCELLED"}
RS={"QUEUED","RUNNING","AWAITING_INPUT","INTERRUPTED","SUCCEEDED","FAILED","ENDED"}
def after(er,lo,wf): 
    if (wf if wf is not None else er=="task_done"): return "SUCCEEDED"
    if er is None and lo=="FAILED": return "FAILED"
    return "ENDED"
def phasefields(p,legacy):
    ph=p.get("phase"); rel=p.get("released")
    if ph is None or rel is None: return None
    if rel: return after(p.get("endReason"),p.get("lastTurnOutcome"),p.get("workFinished"))
    if ph=="PENDING": return "QUEUED"
    if ph=="RUNNING":
        if legacy in("RUNNING","PENDING"): return "RUNNING"
        if legacy=="AWAITING_INPUT": return "AWAITING_INPUT"
        a=p.get("activity") or ""; return "RUNNING" if a in("","TURN") else "AWAITING_INPUT"
    return "INTERRUPTED" if p.get("lastTurnOutcome")=="INTERRUPTED" else "AWAITING_INPUT"
def resolve_status(st,er):
    return {"PENDING":"QUEUED","RUNNING":"RUNNING","AWAITING_INPUT":"AWAITING_INPUT","SUCCEEDED":"SUCCEEDED","FAILED":"FAILED",
            "INTERRUPTED":"INTERRUPTED" if not er else "ENDED","CANCELLED":"ENDED"}.get(st,"ENDED")
def eff(p):
    st=p.get("runStatus") if p.get("runStatus") in KNOWN else p.get("status")
    rs=p.get("runState") if p.get("runState") in RS else None
    if p.get("released") is False and st not in KNOWN and rs is None:
        ph=p.get("phase")
        if ph=="PENDING": return "QUEUED"
        if ph=="RUNNING": a=p.get("activity") or ""; return "RUNNING" if a in("","TURN") else "AWAITING_INPUT"
        if ph=="IDLE": return "INTERRUPTED" if p.get("lastTurnOutcome")=="INTERRUPTED" else "AWAITING_INPUT"
    if rs: return rs
    return resolve_status(st,p.get("endReason"))
def released_rs(p):
    if p.get("released") is not True: return None
    return after(p.get("endReason"),p.get("lastTurnOutcome"),p.get("workFinished"))
def disp(p):
    r=released_rs(p)
    if r: return r
    if p.get("released") is False and p.get("endReason") is not None and p.get("lastTurnOutcome")=="INTERRUPTED": return "INTERRUPTED"
    return eff(p)
def qword(p): return "On hold" if p.get("waitingOn")=="HOLD" else "Queued"
def statusword(p):
    if (p.get("pendingApprovals") or 0)>0: return "Waiting for approval"
    d=disp(p); e=eff(p)
    if d=="QUEUED": return qword(p)
    if d=="RUNNING": return "Running"
    if d=="AWAITING_INPUT":
        if e=="RUNNING" or p.get("engineTurnActive"): return "Running"
        if (p.get("runningSubagentCount") or 0)>0: return "Running Agent"
        if e=="AWAITING_INPUT" and p.get("activity")=="WAITING": return "Waiting to resume"
        if (p.get("runningBgCount") or 0)>0: return "Background process running"
        return "Waiting for your reply"
    if d=="SUCCEEDED": return "Finished" if released_rs(p)=="SUCCEEDED" else "Succeeded"
    if d=="FAILED": return "Disconnected" if "offline" in (p.get("error") or "").lower() else "Failed"
    if d=="INTERRUPTED": return "Interrupted"
    return "Ended"
def glyph(p):
    if (p.get("pendingApprovals") or 0)>0: return ("pause.circle","warning")
    d=disp(p)
    if d=="QUEUED": return ("clock","neutral")
    if d=="RUNNING": return ("spinner","brand")
    if d=="AWAITING_INPUT":
        if p.get("engineTurnActive") or (p.get("runningSubagentCount") or 0)>0: return ("spinner","brand")
        if eff(p)=="AWAITING_INPUT" and p.get("activity")=="WAITING": return ("eye","neutral")
        if (p.get("runningBgCount") or 0)>0: return ("terminal"+(" (breathing)" if (p.get("runningBgJobCount") or 0)>0 else ""),"neutral")
        return ("message","neutral")
    if d=="SUCCEEDED": return ("checkmark.circle.fill","success")
    if d=="FAILED": return ("xmark.circle.fill","error")
    if d=="INTERRUPTED": return ("minus.circle","neutral")
    return ("checkmark.circle","neutral")
def line(p):
    if (p.get("pendingApprovals") or 0)>0: return ("Waiting for approval","approval")
    e=eff(p)
    if e=="RUNNING" or (e=="AWAITING_INPUT" and p.get("engineTurnActive")): return ("Running…","running")
    if e=="QUEUED": return (qword(p),"queued")
    if (p.get("runningSubagentCount") or 0)>0: return ("Running Agent…","running")
    if e=="AWAITING_INPUT" and p.get("activity")=="WAITING": return ("Waiting to resume","watching")
    if (p.get("runningBgCount") or 0)>0: return ("Background process running…","background")
    return (statusword(p),"preview")
def iphone(p):
    s,t=glyph(p)
    if s=="spinner": return "spinner 13pt (secondary)"
    if s=="eye": return "eye (secondary)"
    if s=="clock": return "clock (secondary)"
    if "breathing" in s: return "terminal, breathing"
    if s=="terminal": return "terminal (still)"
    if t=="warning": return "7pt orange dot"
    if t=="error": return "7pt red dot"
    return "nothing"
def android_mark(p):
    e=eff(p)
    if (p.get("pendingApprovals") or 0)>0: return "7dp needsYou dot"
    if e=="QUEUED": return "ic_clock 14dp"
    run = e=="RUNNING" or (e=="AWAITING_INPUT" and (p.get("engineTurnActive") or (p.get("runningSubagentCount") or 0)>0))
    if run: return "RowSpinner 14dp"
    if e=="AWAITING_INPUT" and p.get("activity")=="WAITING": return "ic_eye 14dp"
    if e=="AWAITING_INPUT" and (p.get("runningBgCount") or 0)>0: return "BreathingTerminal" if (p.get("runningBgJobCount") or 0)>0 else "ic_terminal 14dp"
    if disp(p)=="FAILED" and "offline" not in (p.get("error") or "").lower(): return "7dp error dot"
    return "nothing"
def apple_task(p):
    legacy=p.get("runStatus") if p.get("runStatus") in KNOWN else (p.get("status") if p.get("status") in KNOWN else "UNKNOWNST")
    r=phasefields(p,legacy)
    if r is None:
        rs=p.get("runState") if p.get("runState") in RS else None
        r=rs or (resolve_status(p.get("status"),p.get("endReason")) if p.get("status") else None)
    if r=="QUEUED" and p.get("waitingOn")=="HOLD": return "On hold"
    return {"QUEUED":"Queued","RUNNING":"Running","SUCCEEDED":"Finished","FAILED":"Failed","AWAITING_INPUT":"Awaiting reply","INTERRUPTED":"Interrupted","ENDED":"Ended"}.get(r,"—")
def android_task(p):
    ph=p.get("phase"); rel=p.get("released")
    if ph is not None and rel is not None:
        if rel: r={"SUCCEEDED":"FINISHED"}.get(after(p.get("endReason"),p.get("lastTurnOutcome"),p.get("workFinished")),after(p.get("endReason"),p.get("lastTurnOutcome"),p.get("workFinished")))
        elif ph=="PENDING": r="QUEUED"
        elif ph=="RUNNING":
            st=p.get("runStatus") or p.get("status")
            r="RUNNING" if st in("RUNNING","PENDING","QUEUED") else "AWAITING_INPUT" if st=="AWAITING_INPUT" else ("RUNNING" if (p.get("activity") or "") in("","TURN") else "AWAITING_INPUT")
        else: r="INTERRUPTED" if p.get("lastTurnOutcome")=="INTERRUPTED" else "AWAITING_INPUT"
    elif p.get("runState") in RS: r=p["runState"]
    elif p.get("status"):
        st=p["status"]; r={"PENDING":"QUEUED","RUNNING":"RUNNING","AWAITING_INPUT":"AWAITING_INPUT","SUCCEEDED":"SUCCEEDED","FAILED":"FAILED","INTERRUPTED":"INTERRUPTED" if not p.get("endReason") else "ENDED","CANCELLED":"ENDED"}.get(st)
    else: r=None
    if r=="QUEUED": return "On hold" if (rel is not None and p.get("waitingOn")=="HOLD") else "Queued"
    return {"FINISHED":"Finished","RUNNING":"Running","AWAITING_INPUT":"Awaiting reply","SUCCEEDED":"Finished","FAILED":"Failed","INTERRUPTED":"Interrupted","ENDED":"Ended"}.get(r,"—")
def apple_group(p):
    if (p.get("pendingApprovals") or 0)>0: return "Needs you"
    failed = disp(p)=="FAILED" if (p.get("phase") is not None and p.get("released") is not None) else eff(p)=="FAILED"
    if failed and p.get("retryAt") is None: return "Needs you"
    e=eff(p)
    if e in("RUNNING","QUEUED") or (e=="FAILED" and p.get("retryAt") is not None): return "Working"
    return "—"
def android_group(p):
    if (p.get("pendingApprovals") or 0)>0: return "Needs you"
    failed = disp(p)=="FAILED" if (p.get("phase") is not None and p.get("released") is not None) else p.get("status")=="FAILED"
    if failed and p.get("retryAt") is None: return "Needs you"
    st=p.get("status")
    if st in("RUNNING","PENDING") or (st=="FAILED" and p.get("retryAt") is not None): return "Working"
    return "—"

def apple_link(p):
    """OrbitLinkCard.statusWord (:301-315): the glyph label for resolveOptional(runState, sessionState, status) alone,
    with no counts, held word or success word passed (LinkPreviews.swift:117-120)."""
    rs=p.get("runState") if p.get("runState") in RS else resolve_status(p.get("status"),p.get("endReason"))
    return {"QUEUED":"Queued","RUNNING":"Running","AWAITING_INPUT":"Waiting for your reply","SUCCEEDED":"Succeeded",
            "FAILED":(p.get("error") or "Failed"),"INTERRUPTED":"Interrupted","ENDED":"Ended"}[rs]

APPLE_ICON={"clock":"clock","spinner":"spinner","message":"message","minus.circle":"minus-circle","checkmark.circle.fill":"check-circle-filled",
    "xmark.circle.fill":"close-circle-filled","checkmark.circle":"check-circle","pause.circle":"pause-circle","eye":"eye","terminal":"terminal",
    "terminal (breathing)":"terminal","wifi.slash":"unplug","clock.arrow.circlepath":"retry"}
APPLE_TONE={"brand":"blue","success":"green","warning":"amber","error":"red","neutral":"grey"}
def apple_glyph(p):
    s,t=glyph(p)
    return {"icon":APPLE_ICON[s],"tone":("queued" if s=="clock" else APPLE_TONE[t]),"motion":"spin" if s=="spinner" else "breathing" if "breathing" in s else None}
def phone_cue(p, android):
    """iPhone SessionLiveIndicator / Android SessionLiveMark: first line, before the time; settled states draw nothing."""
    m=android_mark(p) if android else None
    s,t=glyph(p)
    if android:
        if "needsYou" in m: return {"icon":"dot-filled","tone":"amber"}
        if "error" in m: return {"icon":"dot-filled","tone":"red"}
        if "clock" in m: return {"icon":"clock","tone":"grey"}
        if "Spinner" in m: return {"icon":"spinner","tone":"grey","motion":"spin"}
        if "eye" in m: return {"icon":"eye","tone":"grey"}
        if "Terminal" in m: return {"icon":"terminal","tone":"grey","motion":"breathing"}
        if "terminal" in m: return {"icon":"terminal","tone":"grey"}
        return {"icon":"none"}
    if s=="spinner": return {"icon":"spinner","tone":"grey","motion":"spin"}
    if s in ("eye","clock"): return {"icon":s,"tone":"grey"}
    if s.startswith("terminal"): return {"icon":"terminal","tone":"grey","motion":"breathing" if "breathing" in s else None}
    if t=="warning": return {"icon":"dot-filled","tone":"amber"}
    if t=="error": return {"icon":"dot-filled","tone":"red"}
    return {"icon":"none"}
LT={"approval":"approval","running":"running","queued":"queued","preview":"preview","watching":"watching","background":"background"}
TASK_TONE={"Queued":"grey","On hold":"grey","Running":"blue","Finished":"green","Failed":"red","Awaiting reply":"amber","Interrupted":"grey","Ended":"grey","—":"grey"}

here=os.path.dirname(os.path.abspath(__file__))
rows=json.load(open(os.path.join(here,"..","fixture.json")))
out={}
for client in ("mac","iphone","android"):
    android = client=="android"
    data=[]
    for r in rows:
        p=r["payload"]; l,lt=line(p)
        g=apple_glyph(p)
        word=statusword(p)
        task=android_task(p) if android else apple_task(p)
        grp=android_group(p) if android else apple_group(p)
        grp="-" if grp=="—" else grp
        item={"row":r["row"],"group":grp,"groupAfter":grp,
              "list":{**(g if client=="mac" else phone_cue(p,android)),"line":l,"lineTone":LT[lt]},
              "run":{"word":task,"tone":TASK_TONE.get(task,"grey")},
              "md":{"word":task}}
        if client=="mac":
            item["header"]={**g,"word":word}
            item["link"]={"word":apple_link(p)}
        else:
            item["value"]={"word":word}
            item["header"]=None
            item["link"]=None if android else {"word":apple_link(p)}
        data.append(item)
    out[client]={"rows":data}
out["mac"].update(surfaces=[["header","Session header word (SessionHeader.headerWord, Mac status bar)"],["run","Task run label (SessionRef.resolvedRunState)"],["link","Link card, session (OrbitLinkCard.statusWord)"],["md","Shared Markdown, Runs line (ShareMarkdown.runLabel)"]],
    listNote="Mac sidebar row: StatusGlyphView leads the row (AgentsView.swift:1771-1800); the orange approval count capsule stays as it is.")
out["iphone"].update(surfaces=[["value","Row value, VoiceOver (SessionHeader.statusWord)"],["header","Conversation header (no state word: the centre is the hand-over / waiting / question capsule)"],["run","Task run label (SessionRef.resolvedRunState)"],["link","Link card, session (OrbitLinkCard.statusWord)"],["md","Shared Markdown, Runs line (ShareMarkdown.runLabel)"]],
    listNote="iPhone row: SessionLiveIndicator sits on the first line before the time (AgentsView.swift:1841-1850, 1935-1977). After: the state icon keeps that slot; marks go to the right end of the second line.")
out["android"].update(surfaces=[["value","Row value, TalkBack (SessionHeader.statusWord)"],["header","Conversation header (no state word: centre capsule, as iOS)"],["run","Task run label (TaskLogic resolvedRunState)"],["md","Copied task Markdown, Runs line"]],
    listNote="Android row: SessionLiveMark sits on the first line before the time (SessionListPage.kt:131-134, 153-170). After: as iPhone.")
json.dump(out,open(os.path.join(here,"native-before.json"),"w"),indent=1)
print("wrote native-before.json")
