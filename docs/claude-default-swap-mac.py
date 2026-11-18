#!/usr/bin/env python3
"""Hand swap of two Claude Code logins on macOS, then swap back.

Usage: python3 -I claude-default-swap-mac.py ADDED_DIR [--probe-only]

A = Default (~/.claude, CLAUDE_CONFIG_DIR unset, oauthAccount in ~/.claude.json)
B = ADDED_DIR (oauthAccount in ADDED_DIR/.claude.json)

Storage per folder matches the runner (claudeKeychainCredentials): if
<dir>/.credentials.json exists it is the login (Claude Code's plaintext
fallback); otherwise the login-Keychain generic password with service
"Claude Code-credentials" (Default) or "Claude Code-credentials-<sha256(dir)[:8]>"
(added). Swap only claudeAiOauth inside each credentials JSON; never mcpOAuth.
Swap only oauthAccount in the two .claude.json files.

Every `security` call has a 30 s timeout: a call that blocks is a Keychain
dialog waiting for a person. Backs up first and restores on any failure.
"""
import json, os, sys, hashlib, subprocess, time, re, tempfile, urllib.request
HOME = os.path.expanduser("~")
B = os.path.abspath(sys.argv[1]); PROBE = "--probe-only" in sys.argv
AJ, BJ = HOME + "/.claude.json", B + "/.claude.json"
SA = "Claude Code-credentials"
SB = "Claude Code-credentials-" + hashlib.sha256(B.encode()).hexdigest()[:8]
A_FILE = os.path.join(HOME, ".claude", ".credentials.json")
B_FILE = os.path.join(B, ".credentials.json")
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
    # Hex on argv via -X (Claude Code's encoding). Do NOT use `security -i` here: interactive
    # stdin is line-buffered around LINE_MAX (~2 KiB), and Default's blob with mcpOAuth is
    # larger, so -i truncates the write and corrupts the item. ARG_MAX is large enough.
    hx = pw.encode().hex()
    r = sec("write " + svc, ["add-generic-password", "-U", "-a", account, "-s", svc, "-X", hx])
    if r.returncode or r.stderr.strip(): raise SystemExit(f"write {svc!r} failed: {r.returncode} {r.stderr.strip()}")

def load(p): return json.load(open(p))

def write_json(p, obj):
    st = os.stat(p); fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p), prefix=".swap.")
    with os.fdopen(fd, "w") as f: json.dump(obj, f, indent=2)
    os.chmod(tmp, st.st_mode & 0o777); os.rename(tmp, p)

def write_creds_file(path, blob):
    st = os.stat(path) if os.path.exists(path) else None
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".swap.")
    with os.fdopen(fd, "w") as f: f.write(blob)
    os.chmod(tmp, (st.st_mode & 0o777) if st else 0o600); os.rename(tmp, path)

class Store:
    """One folder's credential store: file if .credentials.json exists, else Keychain."""
    def __init__(self, label, file_path, svc):
        self.label, self.file_path, self.svc = label, file_path, svc
        self.kind = "file" if os.path.exists(file_path) else "keychain"
        self.account = None  # Keychain acct attr; set for keychain stores before write

    def read(self):
        if self.kind == "file":
            return open(self.file_path).read().rstrip("\n")
        return read_pw(self.svc)

    def write(self, blob):
        if self.kind == "file":
            write_creds_file(self.file_path, blob)
        else:
            write_pw(self.svc, self.account, blob)

storeA, storeB = Store("A", A_FILE, SA), Store("B", B_FILE, SB)

def ident(store, j):
    c = json.loads(store.read()); o = load(j).get("oauthAccount") or {}
    k = c["claudeAiOauth"]
    return {"store": store.kind, "keys": sorted(c.keys()), "refresh": h(k["refreshToken"]),
            "access": h(k["accessToken"]), "expiresAt": k["expiresAt"],
            "oauth.accountUuid": o.get("accountUuid", "")[:8], "oauth.email": o.get("emailAddress")}

def whose(store, j):
    tok = json.loads(store.read())["claudeAiOauth"]["accessToken"]; oa = load(j)["oauthAccount"]
    req = urllib.request.Request("https://api.anthropic.com/api/oauth/profile",
        headers={"Authorization": "Bearer " + tok, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-cli"})
    p = json.load(urllib.request.urlopen(req, timeout=20))
    a, g = p["account"]["uuid"], p["organization"]["uuid"]
    return (f"token account {a[:8]} org {g[:8]} | oauthAccount {oa['accountUuid'][:8]} "
            f"{oa['organizationUuid'][:8]} " +
            ("MATCH" if (a, g) == (oa["accountUuid"], oa["organizationUuid"]) else "MISMATCH"))

def status(label):
    for name, d, store, j in (("A", None, storeA, AJ), ("B", B, storeB, BJ)):
        env = dict(os.environ); env.pop("CLAUDE_CONFIG_DIR", None)
        if d: env["CLAUDE_CONFIG_DIR"] = d
        r = subprocess.run(["claude", "auth", "status"], env=env, capture_output=True, text=True, timeout=120)
        print(f"--- [{label}] claude auth status, folder {name} ({d or '~/.claude, CLAUDE_CONFIG_DIR unset'}) "
              f"store={store.kind} exit={r.returncode}")
        print(r.stdout.strip() or r.stderr.strip())
        print(f"--- [{label}] token owner via /api/oauth/profile, folder {name}:", whose(store, j))

def swap():
    pa, pb = json.loads(storeA.read()), json.loads(storeB.read())
    pa["claudeAiOauth"], pb["claudeAiOauth"] = pb["claudeAiOauth"], pa["claudeAiOauth"]  # other keys stay
    ja, jb = load(AJ), load(BJ); ja["oauthAccount"], jb["oauthAccount"] = jb["oauthAccount"], ja["oauthAccount"]
    storeA.write(json.dumps(pa, separators=(",", ":"))); storeB.write(json.dumps(pb, separators=(",", ":")))
    write_json(AJ, ja); write_json(BJ, jb)

def report():
    print("security calls (what, seconds, exit):"); [print("  ", s) for s in SEC]
    print("slowest security call:", max((s[1] for s in SEC), default=0),
          "s; any TIMEOUT:", any(s[2] == "TIMEOUT" for s in SEC))
    print("any Keychain dialog / blocked security call:", any(s[2] == "TIMEOUT" for s in SEC))

print("claude", subprocess.run(["claude", "--version"], capture_output=True, text=True).stdout.strip(),
      "| B =", B, "| services:", SA, "/", SB)
print("storage: A=", storeA.kind, A_FILE if storeA.kind == "file" else SA,
      "| B=", storeB.kind, B_FILE if storeB.kind == "file" else SB)
print("exists .credentials.json:", os.path.exists(A_FILE), os.path.exists(B_FILE))

if storeA.kind == "keychain":
    storeA.account = acct(SA)
    print("Keychain A acct attr equal $USER:", storeA.account == os.environ.get("USER"))
if storeB.kind == "keychain":
    storeB.account = acct(SB)
    print("Keychain B acct attr equal $USER:", storeB.account == os.environ.get("USER"))
elif storeB.kind == "file":
    # Confirm the Keychain item for B is absent (the mixed layout this measures).
    r = sec("probe-absent " + SB, ["find-generic-password", "-s", SB])
    print(f"Keychain item {SB!r} present:", r.returncode == 0)

for store in (storeA, storeB):
    left = (json.loads(store.read())["claudeAiOauth"]["expiresAt"] / 1000 - time.time()) / 60
    print(f"{store.label} ({store.kind}): access token expires in {left:.0f} min")
    if left < 30: raise SystemExit("too near expiry; a CLI run could refresh — try later")

before = {"A": ident(storeA, AJ), "B": ident(storeB, BJ)}; print("identity before:", json.dumps(before))
if PROBE: report(); sys.exit(0)

bk = tempfile.mkdtemp(prefix="claude-swap-backup-", dir=HOME)  # outside every config dir
json.dump({"A": storeA.read(), "B": storeB.read(), "AJ": load(AJ)["oauthAccount"], "BJ": load(BJ)["oauthAccount"],
           "A_kind": storeA.kind, "B_kind": storeB.kind}, open(bk + "/backup.json", "w"))

def restore_from_backup():
    b = json.load(open(bk + "/backup.json"))
    storeA.write(b["A"]); storeB.write(b["B"])
    ja, jb = load(AJ), load(BJ); ja["oauthAccount"], jb["oauthAccount"] = b["AJ"], b["BJ"]
    write_json(AJ, ja); write_json(BJ, jb)

try:
    status("before")
    t0 = time.time(); swap()
    mid = {"A": ident(storeA, AJ), "B": ident(storeB, BJ)}; print("identity after swap:", json.dumps(mid))
    assert mid["A"]["refresh"] == before["B"]["refresh"] and mid["B"]["refresh"] == before["A"]["refresh"]
    status("after swap")
    swap()  # roll back by swapping the live state back
    print(f"swapped window {time.time() - t0:.1f}s")
except BaseException as e:
    print("FAILED mid-swap:", repr(e), "— restoring both from the backup taken seconds ago")
    restore_from_backup()

after = {"A": ident(storeA, AJ), "B": ident(storeB, BJ)}; print("identity after swap-back:", json.dumps(after))
status("after swap-back")
ok = after == before; print("RESTORED (credential hashes, expiry and oauthAccount equal to before):", ok)
report()
if ok:
    os.remove(bk + "/backup.json"); os.rmdir(bk); print("backup removed")
else:
    print("NOT RESTORED — backup kept at", bk)
sys.exit(0 if ok else 3)
