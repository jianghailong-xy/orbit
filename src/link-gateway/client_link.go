package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nats-io/nats.go"
	"google.golang.org/protobuf/encoding/protojson"

	"orbit/link-gateway/linkpb"
)

// The test client's drills in MODE_LINK (scripts/runner-link/staging-check-link.sh): a runner's side of each path the
// gateway forwards, against a staging stack's real apiserver, NATS and Postgres. Each step is recorded, with what it
// saw, in a report the script reads besides the stack's own state. `link-gateway client -drill <name>`:
//
//	link     heartbeats and their facts by digest; a session created by its owner, its claim hint and its claim, sent
//	         again under the same request_id; the inbox hint and HeartbeatAck's hints; route answers relayed whatever
//	         their status, malformed requests refused, after_seq; durable events stored and acknowledged, in order, a
//	         gap refused, and credit exceeded by a burst; the live stream published only while a client watches it, and
//	         the turn prefix asked of this runner when the client opens the session; an answer large enough to travel in
//	         pieces, with a control frame written between two of them.
//	cancel   a claim sent while the claim lock is held elsewhere, and the connection dropped under it.
//	retry    heartbeats and reads every few hundred milliseconds for -for, while the script stops a backend and starts
//	         it again: every one of them must be answered.
//	slow     a runner that stops reading: frames of the live tier dropped while the connection stays, then the
//	         connection closed as a slow consumer.

// drillOptions are the client's flags for drills.
type drillOptions struct {
	name              string
	ownerEmail        string
	ownerPasswordFile string
	natsURL           string
	natsSeedFile      string
	reportFile        string
	runFor            time.Duration
	cancelAfter       time.Duration
	workDir           string
	session           string
}

type drillStep struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
	Ms     int64  `json:"ms"`
}

type drillReport struct {
	Drill string         `json:"drill"`
	OK    bool           `json:"ok"`
	Steps []drillStep    `json:"steps"`
	Facts map[string]any `json:"facts"`
}

// driver is the runner's side of one connection during a drill.
type driver struct {
	cl       *client
	cc       *clientConn
	log      *slog.Logger
	report   *drillReport
	runnerID string

	mu       sync.Mutex
	rpcs     map[string]chan *linkpb.RpcResult
	acks     chan *linkpb.HeartbeatAck
	eventAck chan *linkpb.EventAck
	hints    chan *linkpb.Hint
	credits  chan *linkpb.Credit
	prefixes chan *linkpb.TurnPrefixRequest
	// raw is the order frames arrived in, chunks included: "chunk:<frame>:<index>:<last>" or the body's name.
	raw    []string
	paused atomic.Bool
	closed *linkpb.Close
	// prefix is what this runner's turn has streamed so far, answered to every TurnPrefixRequest.
	prefix atomic.Pointer[linkpb.TurnPrefixResponse]
	facts  map[string]*linkpb.Fact
	seq    uint64
	rpcN   atomic.Int64
}

func runDrill(ctx context.Context, cl *client, o drillOptions) int {
	r := &drillReport{Drill: o.name, Facts: map[string]any{"processId": cl.o.processID}}
	finish := func() int {
		r.OK = len(r.Steps) > 0
		for _, s := range r.Steps {
			r.OK = r.OK && s.OK
		}
		b, _ := json.MarshalIndent(r, "", "  ")
		fmt.Println(string(b))
		if o.reportFile != "" {
			_ = os.WriteFile(o.reportFile, append(b, '\n'), 0o644)
		}
		if r.OK {
			return 0
		}
		return 1
	}
	d, err := dialDriver(ctx, cl, r)
	if err != nil {
		r.Steps = append(r.Steps, drillStep{Name: "connect", Detail: err.Error()})
		return finish()
	}
	defer d.close()
	switch o.name {
	case "link":
		d.linkDrill(ctx, o)
	case "cancel":
		d.cancelDrill(ctx, o)
	case "retry":
		d.retryDrill(ctx, o)
	case "slow":
		d.slowDrill(ctx, o)
	default:
		d.record("drill", false, time.Now(), "unknown drill "+o.name)
	}
	return finish()
}

// dialDriver opens a connection saying the Hello a runner says, and starts reading it.
func dialDriver(ctx context.Context, cl *client, r *drillReport) (*driver, error) {
	d := &driver{
		cl: cl, log: cl.log, report: r, rpcs: map[string]chan *linkpb.RpcResult{},
		acks: make(chan *linkpb.HeartbeatAck, 64), eventAck: make(chan *linkpb.EventAck, 1024),
		hints: make(chan *linkpb.Hint, 256), credits: make(chan *linkpb.Credit, 16), prefixes: make(chan *linkpb.TurnPrefixRequest, 256),
		facts: map[string]*linkpb.Fact{},
	}
	cl.hello = drillHello(cl.o.processID)
	cl.onRaw = d.noteRaw
	cc, err := cl.connect(ctx)
	if err != nil {
		return nil, err
	}
	d.cc = cc
	d.runnerID = tokenRunnerID(cl.token)
	r.Facts["runnerId"] = d.runnerID
	r.Facts["connectionId"] = cc.id
	r.Facts["welcome"] = map[string]any{"mode": cc.welcome.GetMode().String(), "creditEvents": cc.welcome.GetCredit().GetMaxUnackedEvents(),
		"creditBytes": cc.welcome.GetCredit().GetMaxUnackedBytes(), "maxFrameBytes": cc.welcome.GetLimits().GetMaxFrameBytes()}
	go d.dispatch()
	return d, nil
}

// drillHello is what a runner's Hello declares (src/runner-go/link_client.go linkHello): an engine, the write
// contract this server speaks, and the platform.
func drillHello(process string) *linkpb.Hello {
	return &linkpb.Hello{
		ProcessId: process, RunnerVersion: "link-gateway-client/" + version, Os: runtime.GOOS,
		MinProtocolVersion: 1, MaxProtocolVersion: 1,
		SupportedProviders: []string{"claude"},
		WriteContract:      &linkpb.WriteContract{CapabilityRevision: 2, SchemaRevision: 2, ContractDigest: "bbdd980c70dc56bfd09dfc311c41b3fdff8727912642ee4f529d8ddf36d3a696"},
	}
}

// tokenRunnerID is the runnerId claim of a link token, read without checking it: the gateway did.
func tokenRunnerID(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		RunnerID string `json:"runnerId"`
	}
	_ = json.Unmarshal(payload, &claims)
	return claims.RunnerID
}

func (d *driver) close() { d.cl.closeConn(d.cc) }

func (d *driver) noteRaw(f *linkpb.Frame) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.raw) >= 100_000 {
		return
	}
	if c := f.GetChunk(); c != nil {
		d.raw = append(d.raw, fmt.Sprintf("chunk:%d:%d:%v", c.GetFrameId(), c.GetIndex(), c.GetLast()))
		return
	}
	d.raw = append(d.raw, bodyName(f))
}

// dispatch hands each frame to whoever waits for it, and answers turn prefix requests as the runner would.
func (d *driver) dispatch() {
	for {
		for d.paused.Load() {
			select {
			case <-d.cc.done:
				return
			case <-time.After(10 * time.Millisecond):
			}
		}
		var f *linkpb.Frame
		select {
		case f = <-d.cc.frames:
		case <-d.cc.done:
			return
		}
		switch body := f.GetBody().(type) {
		case *linkpb.Frame_RpcResult:
			d.mu.Lock()
			ch := d.rpcs[body.RpcResult.GetRequestId()]
			delete(d.rpcs, body.RpcResult.GetRequestId())
			d.mu.Unlock()
			if ch != nil {
				ch <- body.RpcResult
			}
		case *linkpb.Frame_HeartbeatAck:
			offerTo(d.acks, body.HeartbeatAck)
		case *linkpb.Frame_EventAck:
			offerTo(d.eventAck, body.EventAck)
		case *linkpb.Frame_Hint:
			offerTo(d.hints, body.Hint)
		case *linkpb.Frame_Credit:
			offerTo(d.credits, body.Credit)
		case *linkpb.Frame_TurnPrefixRequest:
			req := body.TurnPrefixRequest
			answer := &linkpb.TurnPrefixResponse{RequestId: req.GetRequestId(), SessionId: req.GetSessionId()}
			if p := d.prefix.Load(); p != nil {
				answer.TurnId, answer.Text, answer.Thinking, answer.ThroughLiveSeq = p.GetTurnId(), p.GetText(), p.GetThinking(), p.GetThroughLiveSeq()
			}
			_ = d.send(&linkpb.Frame{Body: &linkpb.Frame_TurnPrefixResponse{TurnPrefixResponse: answer}})
			offerTo(d.prefixes, req)
		case *linkpb.Frame_Close:
			d.mu.Lock()
			d.closed = body.Close
			d.mu.Unlock()
		}
	}
}

// offerTo queues v, dropping the oldest when full: a drill reads what it waits for, and what nobody waits for goes.
func offerTo[T any](ch chan T, v T) {
	for {
		select {
		case ch <- v:
			return
		default:
		}
		select {
		case <-ch:
		default:
		}
	}
}

func (d *driver) send(f *linkpb.Frame) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.cl.send(d.cc, f)
}

// record adds a step to the report.
func (d *driver) record(name string, ok bool, started time.Time, detail string) bool {
	d.report.Steps = append(d.report.Steps, drillStep{Name: name, OK: ok, Detail: detail, Ms: time.Since(started).Milliseconds()})
	if ok {
		d.log.Info("drill step", "step", name, "detail", detail)
	} else {
		d.log.Warn("drill step failed", "step", name, "detail", detail)
	}
	return ok
}

// step runs fn as one step; its detail is what it saw, its error why it does not hold.
func (d *driver) step(name string, fn func() (string, error)) bool {
	started := time.Now()
	detail, err := fn()
	if err != nil {
		if detail != "" {
			detail += ": "
		}
		return d.record(name, false, started, detail+err.Error())
	}
	return d.record(name, true, started, detail)
}

// rpc sends one tunnelled request and waits for its result.
func (d *driver) rpc(id, method, path string, body []byte, session string, afterSeq uint64) (*linkpb.RpcResult, error) {
	ch := make(chan *linkpb.RpcResult, 1)
	d.mu.Lock()
	d.rpcs[id] = ch
	d.mu.Unlock()
	if err := d.send(&linkpb.Frame{Body: &linkpb.Frame_Rpc{Rpc: &linkpb.Rpc{RequestId: id, SessionId: session, AfterSeq: afterSeq,
		Body: &linkpb.Rpc_Tunnel{Tunnel: &linkpb.TunnelRequest{Method: method, Path: path, JsonBody: body}}}}}); err != nil {
		return nil, err
	}
	select {
	case r := <-ch:
		return r, nil
	case <-d.cc.done:
		return nil, errors.New("the connection ended")
	case <-time.After(60 * time.Second):
		return nil, errors.New("no RpcResult within 60s")
	}
}

func (d *driver) nextID(prefix string) string {
	return fmt.Sprintf("%s-%s-%d", prefix, d.cl.o.processID[:8], d.rpcN.Add(1))
}

// heartbeat sends one beat and waits for its acknowledgement.
func (d *driver) heartbeat(hb *linkpb.Heartbeat) (*linkpb.HeartbeatAck, error) {
drain:
	for {
		select {
		case <-d.acks:
		default:
			break drain
		}
	}
	hb.ProcessId = d.cl.o.processID
	if err := d.send(&linkpb.Frame{Body: &linkpb.Frame_Heartbeat{Heartbeat: hb}}); err != nil {
		return nil, err
	}
	select {
	case a := <-d.acks:
		return a, nil
	case <-d.cc.done:
		return nil, errors.New("the connection ended")
	case <-time.After(30 * time.Second):
		return nil, errors.New("no HeartbeatAck within 30s")
	}
}

// drillFact is a heartbeat part as a runner reports it: its JSON and the digest of exactly those bytes.
func drillFact(kind string, value any) *linkpb.Fact {
	b, _ := json.Marshal(value)
	sum := sha256.Sum256(b)
	return &linkpb.Fact{Kind: kind, Sha256: hex.EncodeToString(sum[:]), Json: b}
}

// beat is a heartbeat of this runner: an engine installed and signed in, room for two sessions, the sessions given.
func (d *driver) beat(whole bool, sessions ...string) *linkpb.Heartbeat {
	if len(d.facts) == 0 {
		for _, f := range []*linkpb.Fact{
			drillFact("engines", []map[string]any{{"engine": "claude", "installed": true, "version": "2.3.0 (link drill)", "auth": "yes"}}),
			drillFact("runtimeDefaultModels", map[string]string{"claude": "claude-opus-5-5"}),
			drillFact("reposRoot", "/srv/link-drill/repos"),
			drillFact("runsAsRoot", false),
			drillFact("selfUpdate", map[string]string{"state": "disabledByEnv", "reason": "link-gateway client drill"}),
		} {
			d.facts[f.GetKind()] = f
		}
	}
	hb := &linkpb.Heartbeat{IdleCapacity: 2, SessionIds: sessions, SupportedProviders: []string{"claude"}}
	for _, kind := range []string{"engines", "runtimeDefaultModels", "reposRoot", "runsAsRoot", "selfUpdate"} {
		f := d.facts[kind]
		if whole {
			hb.Facts = append(hb.Facts, f)
		} else {
			hb.Facts = append(hb.Facts, &linkpb.Fact{Kind: f.GetKind(), Sha256: f.GetSha256()})
		}
	}
	return hb
}

// events sends a batch and waits for the session's acknowledgement.
func (d *driver) events(eb *linkpb.EventBatch, timeout time.Duration) (*linkpb.EventAck, error) {
	if err := d.send(&linkpb.Frame{Body: &linkpb.Frame_EventBatch{EventBatch: eb}}); err != nil {
		return nil, err
	}
	return d.nextEventAck(eb.GetSessionId(), timeout)
}

func (d *driver) nextEventAck(session string, timeout time.Duration) (*linkpb.EventAck, error) {
	deadline := time.After(timeout)
	for {
		select {
		case a := <-d.eventAck:
			if a.GetSessionId() == session {
				return a, nil
			}
		case <-d.cc.done:
			return nil, errors.New("the connection ended")
		case <-deadline:
			return nil, fmt.Errorf("no EventAck within %s", timeout)
		}
	}
}

// batch is a durable batch of seqs from..to, each event `pad` bytes of payload or so.
func (d *driver) batch(session string, from, to uint64, kind string, pad int) *linkpb.EventBatch {
	eb := &linkpb.EventBatch{SessionId: session}
	now := time.Now().UnixMilli()
	for seq := from; seq <= to; seq++ {
		var payload []byte
		switch kind {
		case "system":
			payload, _ = json.Marshal(map[string]any{"subtype": "link_drill", "n": seq, "pad": strings.Repeat("·", pad/2)})
		default:
			payload, _ = json.Marshal(map[string]any{"text": fmt.Sprintf("link drill event %d: <b>é & 中文</b>", seq)})
		}
		eb.Events = append(eb.Events, &linkpb.Event{Seq: seq, Type: kind, TsUnixMs: now, PayloadJson: payload})
	}
	return eb
}

// waitHint waits for a hint that satisfies match.
func (d *driver) waitHint(timeout time.Duration, match func(*linkpb.Hint) bool) (*linkpb.Hint, error) {
	deadline := time.After(timeout)
	for {
		select {
		case h := <-d.hints:
			if match(h) {
				return h, nil
			}
		case <-d.cc.done:
			return nil, errors.New("the connection ended")
		case <-deadline:
			return nil, fmt.Errorf("no such hint within %s", timeout)
		}
	}
}

func tunnelStatus(r *linkpb.RpcResult) string {
	if t := r.GetTunnel(); t != nil {
		return fmt.Sprintf("%d %s", t.GetStatus(), clip(string(t.GetJsonBody()), 300))
	}
	return "failure " + r.GetFailure().GetCode() + " retryable=" + fmt.Sprint(r.GetFailure().GetRetryable())
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

// owner is the session's owner on the public API: who creates the session and watches it.
type owner struct {
	api    string
	client *http.Client
	token  string
}

func newOwner(cl *client, email, passwordFile string) (*owner, error) {
	password, err := os.ReadFile(passwordFile)
	if err != nil {
		return nil, err
	}
	o := &owner{api: cl.o.api, client: &http.Client{Timeout: 30 * time.Second, Transport: cl.api.Transport}}
	var login struct {
		AccessToken string `json:"accessToken"`
	}
	if status, body, err := o.call("POST", "/api/auth/login", map[string]string{"email": email, "password": strings.TrimSpace(string(password))}, &login); err != nil || status/100 != 2 {
		return nil, fmt.Errorf("signing in as %s: %d %s %v", email, status, clip(string(body), 200), err)
	}
	o.token = login.AccessToken
	return o, nil
}

func (o *owner) call(method, path string, in, out any) (int, []byte, error) {
	var body io.Reader
	if in != nil {
		b, _ := json.Marshal(in)
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, o.api+path, body)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if o.token != "" {
		req.Header.Set("Authorization", "Bearer "+o.token)
	}
	resp, err := o.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if out != nil && resp.StatusCode/100 == 2 {
		if err := json.Unmarshal(b, out); err != nil {
			return resp.StatusCode, b, err
		}
	}
	return resp.StatusCode, b, nil
}

// streamEvent is one event a client's SSE stream of a session carries.
type streamEvent struct {
	Seq     int64           `json:"seq"`
	Type    string          `json:"type"`
	TurnID  string          `json:"turnId"`
	Payload json.RawMessage `json:"payload"`
}

func (e streamEvent) text() string {
	var p struct {
		Text string `json:"text"`
	}
	_ = json.Unmarshal(e.Payload, &p)
	return p.Text
}

// watch opens the session's event stream as its owner, as a client does, until ctx ends.
func (o *owner) watch(ctx context.Context, session string) (<-chan streamEvent, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", o.api+"/api/sessions/"+session+"/events", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+o.token)
	req.Header.Set("Accept", "text/event-stream")
	client := &http.Client{Transport: o.client.Transport}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		return nil, fmt.Errorf("GET /api/sessions/%s/events answered %d", session, resp.StatusCode)
	}
	out := make(chan streamEvent, 4096)
	go func() {
		defer resp.Body.Close()
		defer close(out)
		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 1<<20), 16<<20)
		for scanner.Scan() {
			data, ok := strings.CutPrefix(scanner.Text(), "data:")
			if !ok {
				continue
			}
			var e streamEvent
			if json.Unmarshal([]byte(strings.TrimSpace(data)), &e) == nil && e.Type != "" {
				select {
				case out <- e:
				default:
				}
			}
		}
	}()
	return out, nil
}

// natsProbe reads a session's live subject as the apiserver's NATS user does: what the gateway published there.
type natsProbe struct {
	nc  *nats.Conn
	sub *nats.Subscription
}

func newNATSProbe(url, seedFile, session string) (*natsProbe, error) {
	seed, err := os.ReadFile(seedFile)
	if err != nil {
		return nil, err
	}
	kp, err := natsUserKey(string(seed))
	if err != nil {
		return nil, err
	}
	pub, _ := kp.PublicKey()
	nc, err := nats.Connect(url, nats.Name("link-gateway client drill probe"), nats.Nkey(pub, kp.Sign), nats.MaxReconnects(2))
	if err != nil {
		return nil, err
	}
	sub, err := nc.SubscribeSync(liveSubject(session))
	if err == nil {
		err = nc.Flush()
	}
	if err != nil {
		nc.Close()
		return nil, err
	}
	return &natsProbe{nc: nc, sub: sub}, nil
}

// published is how many live batches arrived within d, and their events' live_seqs.
func (p *natsProbe) published(d time.Duration) (int, []uint64) {
	n := 0
	var seqs []uint64
	deadline := time.Now().Add(d)
	for {
		m, err := p.sub.NextMsg(time.Until(deadline))
		if err != nil {
			return n, seqs
		}
		n++
		var f linkpb.Frame
		if (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(m.Data, &f) == nil {
			for _, e := range f.GetLiveBatch().GetEvents() {
				seqs = append(seqs, e.GetLiveSeq())
			}
		}
	}
}

func (p *natsProbe) close() { p.nc.Close() }
