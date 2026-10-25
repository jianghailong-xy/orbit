# iOS: signing in to a self-hosted server at `http://<ip>`

**The question.** The login page takes an instance address, and `ServerURL.normalize` keeps an
explicit `http://` scheme, so `http://192.168.1.5:2086` reaches `URLSession` unchanged — what the
client decides is only whether the address is well formed. Whether the request *leaves the app* is
the OS's call: Apple's ATS documentation says connections to IP addresses stopped being exempt in
iOS 17 — "Add individual IP addresses and classless inter-domain routing (CIDR) ranges in the
`NSExceptionDomains` dictionary" — and a refusal there is indistinguishable, on the login page, from
an unreachable server: `LoginFailure.unreachable`, "Couldn't reach the server — check the instance
URL and your network connection", is what a `URLError` becomes.

**What ships.** `src/ios/Support/Info.plist`:

- `NSAllowsArbitraryLoads` — named hosts over http (`http://orbit.example.com`).
- `NSExceptionDomains` over both address families, each listed as its two `/1` halves
  (`0.0.0.0/1` + `128.0.0.0/1`, `::/1` + `8000::/1`). A `/0` key is treated as a flag rather than
  an address and matches nothing — Apple's confirmed workaround for r.114040682
  ([forums 731217](https://developer.apple.com/forums/thread/731217), linked from
  [747421](https://developer.apple.com/forums/thread/747421)).
- `NSLocalNetworkUsageDescription` — the sentence iOS 14+ asks for before an app may reach a
  local-network address, which is exactly where a self-hosted server lives.
- `NSAllowsLocalNetworking` is deliberately **absent**: its presence makes iOS 10+ ignore
  `NSAllowsArbitraryLoads` outright, so pairing the two would cancel half of this.

`SelfHostedHTTPAddressWiringTests` (OrbitKit; runs in the Linux gate on every PR) parses the
shipped file and holds it to that shape, so dropping or neutralizing the block fails a test rather
than a login.

**How it was measured.** `probe-harness/run.sh` builds a one-request app twice — once with
`INFOPLIST_FILE` pointed at the file above (and the built `.app`'s own plist dumped into the
results, so the run shows what actually shipped inside the bundle), once with no ATS dictionary at
all — and asks each build three URLs on the newest iPhone simulator. Readings, run **38016314525**
(macos-15 runner, Xcode 26.3, iOS 26 simulator, runner's own address 192.168.64.2):

| arm | plist | URL | URLSession |
| --- | --- | --- | --- |
| `shipped` | shipped file | `http://192.168.64.2:8099/` | **ok 200** |
| `control` | none | `http://192.168.64.2:8099/` | **ok 200** |
| `control-named` | none | `http://neverssl.com/` | refused, `NSURLErrorDomain -1022` |
| `shipped-named` | shipped file | `http://neverssl.com/` | failed, `-1001` (timeout — see below) |
| `control-public` | none | `http://1.1.1.1/` | refused, `NSURLErrorDomain -1022` |
| `shipped-public` | shipped file | `http://1.1.1.1/` | **ok 200** |

**What the readings say.**

1. `control-named` refused with `-1022`: ATS is enforced in this environment — a run where nothing
   is refused would be measuring nothing, which is the arm the script asserts on.
2. `control-public` refused with `-1022`: on iOS 26 the documented rule **still applies to a
   public IP literal** — `http://1.1.1.1/` never opens a connection without an exception.
3. `shipped-public` 200: the `/1` halves are what let that same address through. The exception is
   load-bearing, not a leftover.
4. `control` (the runner's own LAN address) 200: the same cleartext request to a directly
   reachable address was **allowed even with no ATS keys** — the rule's reach on this OS does not
   include the machine's own address. This is why the probe's first clean run (38014869364, both
   arms 200) proved nothing, and why the two refusal arms above are now in the script.
5. `shipped` 200: the case the change exists for — the app carrying this plist signs in to a
   self-hosted server at `http://<ip>`.
6. `shipped-named` timed out (`-1001`) on this run: `neverssl.com` did not answer inside the
   probe's 20 s. The same arm answered 200 in run 38015680419. It is the only arm that needs a
   third party to answer, so the script reports it rather than asserting on it — the run went red
   on this arm before that was fixed, which is why the artifact's own summary shows a `!!` line.

**What this does not cover.**

- The iOS 14+ **local-network permission prompt**: the simulator does not enforce it. On a device,
  a LAN address raises it, and the first request can be refused while the prompt is up — TN3179
  suggests `waitsForConnectivity` or a retry, and Orbit's sessions set neither, so a first-tap
  failure followed by a working retry is expected on a LAN server.
- Cellular/VPN paths, and iOS 17.x devices that still enforce the IP rule exactly as documented.
- The App Review justification `NSAllowsArbitraryLoads` asks for; this block is what that
  justification describes.
- Android (release sets `usesCleartextTraffic="false"`) and macOS (its plist, generated in
  `src/macos/scripts/build-dmg.sh`, carries no ATS block) — both out of scope by decision on
  2026-10-10.

**Re-running.** The job is dispatch-only and off by default:

```
gh workflow run client.yml --ref <branch> -f ios_http_ip_probe=true
```

Its results ride the `ios-http-ip-probe` artifact (`summary.txt` plus each arm's console). Push
first, dispatch after: a push to the branch that matches client.yml's paths cancels a queued or
running run of the same workflow on that ref (concurrency group `client-<ref>`, which includes the
push-triggered run).
