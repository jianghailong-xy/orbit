package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"orbit/link-gateway/linkpb"
)

// The shadow comparison (README.md, "Shadow comparison", which is the contract the runner's mirror follows).
// During the shadow period a runner works over HTTPS and mirrors to the gateway each heartbeat and event batch the
// HTTP side accepted, as two halves: the typed frame the link will carry after the cutover (Heartbeat, EventBatch),
// and an Rpc whose TunnelRequest is the HTTP request itself, byte for byte. Its request_id,
// "shadow:<connection id>:<typed frame id>", pairs the two. The gateway compares each pair as JSON values, counts the
// outcome and writes nothing anywhere: a mirror is never stored, never acknowledged and never forwarded.

const shadowPrefix = "shadow:"

// Bounds on the halves waiting for their other half. The two halves of a pair are sent back to back, so a half
// waits milliseconds; these only stop a runner that never sends the other half from holding memory. A half that
// leaves by any bound is counted as unpaired.
const (
	shadowTTL           = 60 * time.Second
	shadowMaxPending    = 64
	shadowMaxConnBytes  = 4 << 20
	shadowMaxTotalBytes = 256 << 20
)

// shadowPending counts the bytes every connection's waiting halves hold.
var shadowPending atomic.Int64

// shadowEntry is one half of a mirror.
type shadowEntry struct {
	kind      string // "heartbeat" or "events"
	heartbeat *linkpb.Heartbeat
	events    *linkpb.EventBatch
	request   *linkpb.TunnelRequest
	at        time.Time
	size      int
	side      string // "typed" or "raw"
}

type shadowState struct {
	c      *conn
	mu     sync.Mutex
	typedQ map[uint64]*shadowEntry
	rawQ   map[uint64]*shadowEntry
	bytes  int
	now    func() time.Time
}

func newShadowState(c *conn) *shadowState {
	return &shadowState{c: c, typedQ: map[uint64]*shadowEntry{}, rawQ: map[uint64]*shadowEntry{}, now: time.Now}
}

// typed takes the typed half of a mirror: the Heartbeat or EventBatch in frame frameID.
func (s *shadowState) typed(frameID uint64, e *shadowEntry, size int) {
	e.side, e.size = "typed", size
	s.mu.Lock()
	defer s.mu.Unlock()
	if raw := s.rawQ[frameID]; raw != nil {
		s.forget(s.rawQ, frameID)
		s.compare(frameID, e, raw)
		return
	}
	s.hold(s.typedQ, frameID, e)
}

// mirror takes the raw half: an Rpc whose request_id names its connection and typed frame.
func (s *shadowState) mirror(rpc *linkpb.Rpc, size int) {
	m := s.c.g.metrics
	connID, frameID, ok := parseShadowRequestID(rpc.GetRequestId())
	switch {
	case !ok || rpc.GetTunnel() == nil:
		m.shadowUnpaired.inc("raw", "malformed")
		s.c.log.Warn("shadow mirror refused: request_id is not shadow:<connection id>:<frame id> or carries no TunnelRequest",
			"request", rpc.GetRequestId())
		return
	case connID != s.c.id:
		// Its typed half was sent on another connection, which has closed since.
		m.shadowUnpaired.inc("raw", "wrong_connection")
		return
	}
	e := &shadowEntry{request: rpc.GetTunnel(), side: "raw", size: size}
	s.mu.Lock()
	defer s.mu.Unlock()
	if typed := s.typedQ[frameID]; typed != nil {
		s.forget(s.typedQ, frameID)
		s.compare(frameID, typed, e)
		return
	}
	s.hold(s.rawQ, frameID, e)
}

func parseShadowRequestID(id string) (connID string, frameID uint64, ok bool) {
	rest, found := strings.CutPrefix(id, shadowPrefix)
	if !found {
		return "", 0, false
	}
	i := strings.LastIndexByte(rest, ':')
	if i <= 0 {
		return "", 0, false
	}
	n, err := strconv.ParseUint(rest[i+1:], 10, 64)
	if err != nil {
		return "", 0, false
	}
	return rest[:i], n, true
}

// hold keeps a half until its other half arrives, making room by the bounds above first.
func (s *shadowState) hold(q map[uint64]*shadowEntry, frameID uint64, e *shadowEntry) {
	e.at = s.now()
	s.expireLocked()
	m := s.c.g.metrics
	if e.size > shadowMaxConnBytes {
		m.shadowUnpaired.inc(e.side, "evicted")
		return
	}
	if old := q[frameID]; old != nil {
		s.forget(q, frameID)
		m.shadowUnpaired.inc(old.side, "evicted")
	}
	for len(q) >= shadowMaxPending {
		s.evictOldest(q)
	}
	for s.bytes+e.size > shadowMaxConnBytes || (shadowPending.Load()+int64(e.size) > shadowMaxTotalBytes && s.bytes > 0) {
		if !s.evictOldest(s.typedQ, s.rawQ) {
			break
		}
	}
	if shadowPending.Load()+int64(e.size) > shadowMaxTotalBytes {
		m.shadowUnpaired.inc(e.side, "evicted")
		return
	}
	q[frameID] = e
	s.bytes += e.size
	shadowPending.Add(int64(e.size))
}

func (s *shadowState) forget(q map[uint64]*shadowEntry, frameID uint64) {
	if e := q[frameID]; e != nil {
		delete(q, frameID)
		s.bytes -= e.size
		shadowPending.Add(int64(-e.size))
	}
}

// evictOldest drops the half that has waited longest in any of qs, and reports whether there was one.
func (s *shadowState) evictOldest(qs ...map[uint64]*shadowEntry) bool {
	var oldestQ map[uint64]*shadowEntry
	var oldestID uint64
	var oldest *shadowEntry
	for _, q := range qs {
		for id, e := range q {
			if oldest == nil || e.at.Before(oldest.at) || (e.at.Equal(oldest.at) && id < oldestID) {
				oldestQ, oldestID, oldest = q, id, e
			}
		}
	}
	if oldest == nil {
		return false
	}
	s.forget(oldestQ, oldestID)
	s.c.g.metrics.shadowUnpaired.inc(oldest.side, "evicted")
	return true
}

// expire counts and drops the halves that waited longer than shadowTTL.
func (s *shadowState) expire() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
}

func (s *shadowState) expireLocked() {
	cutoff := s.now().Add(-shadowTTL)
	for _, q := range []map[uint64]*shadowEntry{s.typedQ, s.rawQ} {
		for id, e := range q {
			if e.at.Before(cutoff) {
				s.forget(q, id)
				s.c.g.metrics.shadowUnpaired.inc(e.side, "expired")
			}
		}
	}
}

// close counts the halves still waiting when the connection ends.
func (s *shadowState) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, q := range []map[uint64]*shadowEntry{s.typedQ, s.rawQ} {
		for id, e := range q {
			s.forget(q, id)
			s.c.g.metrics.shadowUnpaired.inc(e.side, "closed")
		}
	}
}

// shadowDiff is one field that differs, with what the log may say about it: never a payload's content.
type shadowDiff struct {
	field  string
	detail string
}

func (s *shadowState) compare(frameID uint64, typed, raw *shadowEntry) {
	m := s.c.g.metrics
	s.c.mu.Lock()
	hello := s.c.hello
	s.c.mu.Unlock()
	var diffs []shadowDiff
	switch typed.kind {
	case "heartbeat":
		diffs = compareHeartbeat(typed.heartbeat, raw.request, hello)
	case "events":
		diffs = compareEvents(typed.events, raw.request, hello)
		m.shadowEvents.add(float64(len(typed.events.GetEvents())))
	}
	if len(diffs) == 0 {
		m.shadowPairs.inc(typed.kind, "match")
		return
	}
	m.shadowPairs.inc(typed.kind, "mismatch")
	seen := map[string]bool{}
	details := make([]string, 0, len(diffs))
	for _, d := range diffs {
		if !seen[d.field] {
			seen[d.field] = true
			m.shadowMismatches.inc(typed.kind, d.field)
		}
		details = append(details, d.field+": "+d.detail)
	}
	s.c.log.Warn("shadow mismatch", "kind", typed.kind, "frame", frameID, "path", raw.request.GetPath(),
		"diffs", strings.Join(details, "; "))
}

// The members of the HTTP heartbeat body that are typed fields of Heartbeat (or of the connection); every other
// member travels as a Fact named after it.
var heartbeatTypedMembers = map[string]bool{
	"status": true, "version": true, "leaseOwner": true, "idleCapacity": true, "supervisedSessionIds": true, "draining": true,
}

// compareHeartbeat compares a Heartbeat with the POST /runner/heartbeat request it mirrors (README.md).
func compareHeartbeat(hb *linkpb.Heartbeat, req *linkpb.TunnelRequest, hello *linkpb.Hello) []shadowDiff {
	var diffs []shadowDiff
	add := func(field, detail string, args ...any) {
		diffs = append(diffs, shadowDiff{field, fmt.Sprintf(detail, args...)})
	}
	if req.GetMethod() != "POST" || req.GetPath() != "/runner/heartbeat" {
		add("route", "%s %s is not POST /runner/heartbeat", req.GetMethod(), req.GetPath())
		return diffs
	}
	members, err := jsonObject(req.GetJsonBody())
	if err != nil {
		add("body", "%v", err)
		return diffs
	}

	if lo := stringMember(members, "leaseOwner"); !strings.EqualFold(lo, hb.GetProcessId()) {
		add("leaseOwner", "HTTP %q, link %q", lo, hb.GetProcessId())
	}
	if n, ok := numberMember(members, "idleCapacity"); !ok || n != strconv.FormatUint(uint64(hb.GetIdleCapacity()), 10) {
		add("idleCapacity", "HTTP %s, link %d", members["idleCapacity"], hb.GetIdleCapacity())
	}
	if d, ok := boolMember(members, "draining"); !ok || d != hb.GetDraining() {
		add("draining", "HTTP %s, link %t", members["draining"], hb.GetDraining())
	}
	if ids, ok := stringsMember(members, "supervisedSessionIds"); !ok || !sameSet(ids, hb.GetSessionIds()) {
		add("supervisedSessionIds", "HTTP %d, link %d session ids", len(ids), len(hb.GetSessionIds()))
	}
	if _, present := members["version"]; present {
		if v := stringMember(members, "version"); v != hello.GetRunnerVersion() {
			add("version", "HTTP %q, Hello %q", v, hello.GetRunnerVersion())
		}
	}
	if _, present := members["status"]; present {
		if st := stringMember(members, "status"); st != "ONLINE" {
			add("status", "HTTP %q: the link says nothing but online", st)
		}
	}

	facts := map[string]*linkpb.Fact{}
	for _, f := range hb.GetFacts() {
		if facts[f.GetKind()] != nil {
			add("fact_duplicate", "%s", f.GetKind())
		}
		facts[f.GetKind()] = f
	}
	for _, name := range sortedKeys(members) {
		if heartbeatTypedMembers[name] {
			continue
		}
		f := facts[name]
		switch {
		case f == nil:
			add("fact_missing", "%s", name)
		case len(f.GetJson()) == 0:
			add("fact_json_missing", "%s: a mirror carries every fact whole", name)
		default:
			if sum := sha256.Sum256(f.GetJson()); hex.EncodeToString(sum[:]) != f.GetSha256() {
				add("fact_digest", "%s: sha256 is not the digest of its json", name)
			}
			if !jsonEqual(f.GetJson(), members[name]) {
				add("fact_value", "%s: HTTP %s, link %s", name, sized(members[name]), sized(f.GetJson()))
			}
		}
	}
	kinds := make([]string, 0, len(facts))
	for kind := range facts {
		kinds = append(kinds, kind)
	}
	sort.Strings(kinds)
	for _, kind := range kinds {
		if _, ok := members[kind]; !ok || heartbeatTypedMembers[kind] {
			add("fact_extra", "%s", kind)
		}
	}
	return diffs
}

// compareEvents compares an EventBatch with the POST /runner/sessions/<id>/events request it mirrors (README.md).
func compareEvents(eb *linkpb.EventBatch, req *linkpb.TunnelRequest, hello *linkpb.Hello) []shadowDiff {
	var diffs []shadowDiff
	add := func(field, detail string, args ...any) {
		diffs = append(diffs, shadowDiff{field, fmt.Sprintf(detail, args...)})
	}
	if want := "/runner/sessions/" + eb.GetSessionId() + "/events"; req.GetMethod() != "POST" || req.GetPath() != want {
		add("route", "%s %s is not POST %s", req.GetMethod(), req.GetPath(), want)
		return diffs
	}
	members, err := jsonObject(req.GetJsonBody())
	if err != nil {
		add("body", "%v", err)
		return diffs
	}
	for _, name := range sortedKeys(members) {
		if name != "leaseOwner" && name != "events" {
			add("batch_member", "%s is not carried by EventBatch", name)
		}
	}
	if lo := stringMember(members, "leaseOwner"); lo != "" && !strings.EqualFold(lo, hello.GetProcessId()) {
		add("leaseOwner", "HTTP %q, Hello %q", lo, hello.GetProcessId())
	}
	var events []json.RawMessage
	if raw, ok := members["events"]; ok && !isJSONNull(raw) {
		if err := json.Unmarshal(raw, &events); err != nil {
			add("body", "events is not an array")
			return diffs
		}
	}
	linkEvents := eb.GetEvents()
	if len(events) != len(linkEvents) {
		add("events_length", "HTTP %d, link %d events", len(events), len(linkEvents))
	}
	for i := range min(len(events), len(linkEvents)) {
		le := linkEvents[i]
		ev, err := jsonObject(events[i])
		if err != nil {
			add("body", "event %d: %v", i, err)
			continue
		}
		if n, ok := numberMember(ev, "seq"); !ok || n != strconv.FormatUint(le.GetSeq(), 10) {
			add("seq", "event %d: HTTP %s, link %d", i, ev["seq"], le.GetSeq())
		}
		if t := stringMember(ev, "type"); t != le.GetType() {
			add("type", "event %d: HTTP %q, link %q", i, t, le.GetType())
		}
		if ts, err := time.Parse(time.RFC3339Nano, stringMember(ev, "ts")); err != nil || ts.UnixMilli() != le.GetTsUnixMs() {
			add("ts", "event %d: HTTP %q, link %d ms", i, stringMember(ev, "ts"), le.GetTsUnixMs())
		}
		if t := stringMember(ev, "turnId"); t != le.GetTurnId() {
			add("turnId", "event %d: HTTP %q, link %q", i, t, le.GetTurnId())
		}
		payload, ok := ev["payload"]
		if !ok {
			payload = json.RawMessage("null")
		}
		if !jsonEqual(payload, le.GetPayloadJson()) {
			add("payload", "event %d (seq %d): HTTP %s, link %s", i, le.GetSeq(), sized(payload), sized(le.GetPayloadJson()))
		}
		for _, name := range sortedKeys(ev) {
			switch name {
			case "seq", "type", "ts", "turnId", "payload":
			default:
				add("event_member", "event %d: %s is not carried by Event", i, name)
			}
		}
	}
	return diffs
}

// jsonObject reads one JSON object, keeping each member's bytes as they are.
func jsonObject(b []byte) (map[string]json.RawMessage, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil || m == nil {
		return nil, fmt.Errorf("not a JSON object")
	}
	return m, nil
}

func isJSONNull(b json.RawMessage) bool { return bytes.Equal(bytes.TrimSpace(b), []byte("null")) }

// stringMember is a string member's value; absent, null or not a string reads as "".
func stringMember(m map[string]json.RawMessage, name string) string {
	var s string
	_ = json.Unmarshal(m[name], &s)
	return s
}

// numberMember is a number member as a whole number's decimal digits; absent or null reads as "0", as Go's
// omitempty leaves a zero out.
func numberMember(m map[string]json.RawMessage, name string) (string, bool) {
	raw, ok := m[name]
	if !ok || isJSONNull(raw) {
		return "0", true
	}
	var n json.Number
	if err := json.Unmarshal(raw, &n); err != nil {
		return "", false
	}
	if i, err := strconv.ParseInt(n.String(), 10, 64); err == nil {
		return strconv.FormatInt(i, 10), true
	}
	if f, err := strconv.ParseFloat(n.String(), 64); err == nil && f == float64(uint64(f)) {
		return strconv.FormatUint(uint64(f), 10), true
	}
	return n.String(), true
}

// boolMember is a boolean member; absent or null reads as false.
func boolMember(m map[string]json.RawMessage, name string) (bool, bool) {
	raw, ok := m[name]
	if !ok || isJSONNull(raw) {
		return false, true
	}
	var v bool
	err := json.Unmarshal(raw, &v)
	return v, err == nil
}

// stringsMember is an array-of-strings member; absent or null reads as empty.
func stringsMember(m map[string]json.RawMessage, name string) ([]string, bool) {
	raw, ok := m[name]
	if !ok || isJSONNull(raw) {
		return nil, true
	}
	var v []string
	err := json.Unmarshal(raw, &v)
	return v, err == nil
}

// sameSet compares two lists of ids as sets: the control plane reads supervised sessions as a set.
func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	x, y := append([]string(nil), a...), append([]string(nil), b...)
	sort.Strings(x)
	sort.Strings(y)
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}

func sortedKeys(m map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// jsonEqual compares two JSON texts as values, so that what an encoder is free to vary cannot read as a
// difference: whitespace, the order of an object's members, escapes (\u003c and <, \u00e9 and é) and how a number
// is spelled (1, 1.0, 1e0). Go's encoding/json compacts a json.RawMessage and escapes <, > and & as it marshals, so
// the body of an HTTP request and a frame built from the same value need not be the same bytes.
func jsonEqual(a, b []byte) bool {
	x, err := decodeJSONValue(a)
	if err != nil {
		return false
	}
	y, err := decodeJSONValue(b)
	if err != nil {
		return false
	}
	return jsonValueEqual(x, y)
}

func decodeJSONValue(b []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var v any
	if err := d.Decode(&v); err != nil {
		return nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, fmt.Errorf("data after the JSON value")
	}
	return v, nil
}

func jsonValueEqual(a, b any) bool {
	switch x := a.(type) {
	case nil:
		return b == nil
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case string:
		y, ok := b.(string)
		return ok && x == y
	case json.Number:
		y, ok := b.(json.Number)
		return ok && numbersEqual(x, y)
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !jsonValueEqual(x[i], y[i]) {
				return false
			}
		}
		return true
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, v := range x {
			w, ok := y[k]
			if !ok || !jsonValueEqual(v, w) {
				return false
			}
		}
		return true
	}
	return false
}

// numbersEqual compares two JSON numbers by value. Integers are compared exactly; anything else as float64, which
// is what both encoders produced the number from.
func numbersEqual(x, y json.Number) bool {
	if x == y {
		return true
	}
	if i, err := strconv.ParseInt(string(x), 10, 64); err == nil {
		if j, err := strconv.ParseInt(string(y), 10, 64); err == nil {
			return i == j
		}
	}
	f, errX := strconv.ParseFloat(string(x), 64)
	g, errY := strconv.ParseFloat(string(y), 64)
	return errX == nil && errY == nil && f == g
}
