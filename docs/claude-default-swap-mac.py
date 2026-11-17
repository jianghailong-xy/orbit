#!/usr/bin/env python3
"""Hand swap of two Claude Code logins on macOS (login Keychain + oauthAccount), then swap back.
Usage: python3 -I claude-default-swap-mac.py ADDED_DIR [--probe-only]
A = Default (~/.claude, CLAUDE_CONFIG_DIR unset, Keychain "Claude Code-credentials", oauthAccount in ~/.claude.json)
B = ADDED_DIR (Keychain "Claude Code-credentials-<sha256(dir)[:8]>", oauthAccount in ADDED_DIR/.claude.json)
Every `security` call has a 30 s timeout: a call that blocks is a Keychain dialog waiting for a person."""
import json, os, sys, hashlib, subprocess, time, re, tempfile, urllib.request
HOME = os.path.expanduser("~")
B = os.path.abspath(sys.argv[1]); PROBE = "--probe-only" in sys.argv
AJ, BJ = HOME + "/.claude.json", B + "/.claude.json"
SA, SB = "Claude Code-credentials", "Claude Code-credentials-" + hashlib.sha256(B.encode()).hexdigest()[:8]
SEC = []  # (what, seconds, exit) for every security call
def h(s): return hashlib.sha256(s.encode()).hexdigest()[:10]
def sec(what, args, stdin=None):
    t = time.time()
    try:
        r = subprocess.run(["/usr/bin/security"] + args, input=stdin, capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        SEC.append((what, round(time.time() - t, 2), "TIMEOUT"))
        print("SECURITY CALL BLOCKED (Keychain dialog?):", what); raise RuntimeError("blocked: " + what)
    SEC.append((what, round(time.time() - t, 2), r.returncode)); return r
def acct(svc):
    r = sec("attrs " + svc, ["find-generic-password", "-s", svc])
    if r.returncode: raise SystemExit(f"no Keychain item {svc!r}: {r.stderr.strip()}")
    return re.search(r'"acct"<blob>="([^"]*)"', r.stdout).group(1)
def read_pw(svc):
    r = sec("read " + svc, ["find-generic-password", "-s", svc, "-w"])
    if r.returncode: raise SystemExit(f"read {svc!r} failed: {r.stderr.strip()}")
    return r.stdout.rstrip("\n")
def write_pw(svc, account, pw):
    # Through `security -i` on stdin, hex-encoded the way Claude Code writes it, so no token is on an argv.
    cmd = f'add-generic-password -U -a "{account}" -s "{svc}" -X "{pw.encode().hex()}"\n'
    r = sec("write " + svc, ["-i"], stdin=cmd)
    if r.returncode or r.stderr.strip(): raise SystemExit(f"write {svc!r} failed: {r.returncode} {r.stderr.strip()}")
def load(p): return json.load(open(p))
def write_json(p, obj):
    st = os.stat(p); fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p), prefix=".swap.")
    with os.fdopen(fd, "w") as f: json.dump(obj, f, indent=2)
    os.chmod(tmp, st.st_mode & 0o777); os.rename(tmp, p)
def ident(svc, j):
    c = json.loads(read_pw(svc)); o = load(j).get("oauthAccount") or {}
    k = c["claudeAiOauth"]
    return {"keys": sorted(c.keys()), "refresh": h(k["refreshToken"]), "access": h(k["accessToken"]), "expiresAt": k["expiresAt"],
            "oauth.accountUuid": o.get("accountUuid", "")[:8], "oauth.email": o.get("emailAddress")}
def whose(svc, j):
    tok = json.loads(read_pw(svc))["claudeAiOauth"]["accessToken"]; oa = load(j)["oauthAccount"]
    req = urllib.request.Request("https://api.anthropic.com/api/oauth/profile", headers={"Authorization": "Bearer " + tok, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-cli"})
    p = json.load(urllib.request.urlopen(req, timeout=20))
    a, g = p["account"]["uuid"], p["organization"]["uuid"]
    return f"token account {a[:8]} org {g[:8]} | oauthAccount {oa['accountUuid'][:8]} {oa['organizationUuid'][:8]} " + ("MATCH" if (a, g) == (oa["accountUuid"], oa["organizationUuid"]) else "MISMATCH")
def status(label):
    for name, d, svc, j in (("A", None, SA, AJ), ("B", B, SB, BJ)):
        env = dict(os.environ); env.pop("CLAUDE_CONFIG_DIR", None)
        if d: env["CLAUDE_CONFIG_DIR"] = d
        r = subprocess.run(["claude", "auth", "status"], env=env, capture_output=True, text=True, timeout=120)
        print(f"--- [{label}] claude auth status, folder {name} ({d or '~/.claude, CLAUDE_CONFIG_DIR unset'}) exit={r.returncode}")
        print(r.stdout.strip() or r.stderr.strip())
        print(f"--- [{label}] token owner via /api/oauth/profile, folder {name}:", whose(svc, j))
def swap(accA, accB):
    pa, pb = json.loads(read_pw(SA)), json.loads(read_pw(SB))
    pa["claudeAiOauth"], pb["claudeAiOauth"] = pb["claudeAiOauth"], pa["claudeAiOauth"]   # other keys (mcpOAuth) stay
    ja, jb = load(AJ), load(BJ); ja["oauthAccount"], jb["oauthAccount"] = jb["oauthAccount"], ja["oauthAccount"]
    write_pw(SA, accA, json.dumps(pa, separators=(",", ":"))); write_pw(SB, accB, json.dumps(pb, separators=(",", ":")))
    write_json(AJ, ja); write_json(BJ, jb)
def report():
    print("security calls (what, seconds, exit):"); [print("  ", s) for s in SEC]
    print("slowest security call:", max((s[1] for s in SEC), default=0), "s; any TIMEOUT:", any(s[2] == "TIMEOUT" for s in SEC))
print("claude", subprocess.run(["claude", "--version"], capture_output=True, text=True).stdout.strip(), "| B =", B, "| services:", SA, "/", SB)
print("exists .credentials.json:", os.path.exists(HOME + "/.claude/.credentials.json"), os.path.exists(B + "/.credentials.json"))
accA, accB = acct(SA), acct(SB); print("Keychain acct attrs equal $USER:", accA == os.environ.get("USER"), accB == os.environ.get("USER"))
for svc in (SA, SB):
    left = (json.loads(read_pw(svc))["claudeAiOauth"]["expiresAt"] / 1000 - time.time()) / 60
    print(f"{svc}: access token expires in {left:.0f} min")
    if left < 30: raise SystemExit("too near expiry; a CLI run could refresh — try later")
before = {"A": ident(SA, AJ), "B": ident(SB, BJ)}; print("identity before:", json.dumps(before))
if PROBE: report(); sys.exit(0)
bk = tempfile.mkdtemp(prefix="claude-swap-backup-", dir=HOME)   # 0700, outside every config dir; deleted at the end
json.dump({"A": read_pw(SA), "B": read_pw(SB), "AJ": load(AJ)["oauthAccount"], "BJ": load(BJ)["oauthAccount"]}, open(bk + "/backup.json", "w"))
def restore_from_backup():
    b = json.load(open(bk + "/backup.json"))
    write_pw(SA, accA, b["A"]); write_pw(SB, accB, b["B"])
    ja, jb = load(AJ), load(BJ); ja["oauthAccount"], jb["oauthAccount"] = b["AJ"], b["BJ"]; write_json(AJ, ja); write_json(BJ, jb)
try:
    status("before")
    t0 = time.time(); swap(accA, accB)
    mid = {"A": ident(SA, AJ), "B": ident(SB, BJ)}; print("identity after swap:", json.dumps(mid))
    assert mid["A"]["refresh"] == before["B"]["refresh"] and mid["B"]["refresh"] == before["A"]["refresh"]
    status("after swap")
    swap(accA, accB)   # roll back by swapping the live state back
    print(f"swapped window {time.time() - t0:.1f}s")
except BaseException as e:
    print("FAILED mid-swap:", repr(e), "— restoring both from the backup taken seconds ago")
    restore_from_backup()
after = {"A": ident(SA, AJ), "B": ident(SB, BJ)}; print("identity after swap-back:", json.dumps(after))
status("after swap-back")
ok = after == before; print("RESTORED (Keychain hashes, expiry and oauthAccount equal to before):", ok)
report()
if ok:
    os.remove(bk + "/backup.json"); os.rmdir(bk); print("backup removed")
else:
    print("NOT RESTORED — backup kept at", bk)
sys.exit(0 if ok else 3)
