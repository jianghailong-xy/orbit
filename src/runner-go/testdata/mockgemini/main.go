// Command mockgemini is a scripted stand-in for the Gemini API, for driving the
// Antigravity CLI (`agy`) offline in API-key mode. See README.md beside it for how
// to point agy at it and docs/antigravity-runtime-contract.md for what was measured
// with it.
//
// The prompt drives the reply: lines of the form `mock:<verb> <args>` in the most
// recent user message script what the "model" answers, one reply per model turn,
// so a test states its scenario in the prompt it sends rather than in a side file.
// Every request is appended to a JSONL log, and the server doubles as an HTTPS
// proxy (HTTPS_PROXY) that records every host the CLI tries to reach and refuses
// it unless -tunnel is set.
//
// Standard library only, so a test can `go build ./testdata/mockgemini` with no
// module changes.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"
)

var (
	addrFlag       = flag.String("addr", "127.0.0.1:0", "listen address")
	logFlag        = flag.String("log", "", "append one JSON line per request to this file")
	urlFileFlag    = flag.String("url-file", "", "write the base URL to this file once listening")
	modelsFlag     = flag.String("models", "gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.1-pro-preview,gemini-3.1-flash-lite-preview", "comma-separated model ids for GET /v1beta/models")
	chunkRunes     = flag.Int("chunk-runes", 12, "runes per streamed text chunk")
	chunkDelayFlag = flag.Duration("chunk-delay", 15*time.Millisecond, "pause between streamed chunks")
	wantKeyFlag    = flag.String("want-key", "", "if set, any other API key is answered with Gemini's API_KEY_INVALID error")
	tunnelFlag     = flag.Bool("tunnel", false, "as a proxy, really connect CONNECT requests (default: record and refuse them)")
	staticFlag     = flag.String("static", "", "serve GETs no Gemini route matches from this directory (e.g. an auto-update manifest for agy --release_base_url)")
)

func main() {
	flag.Parse()
	ln, err := net.Listen("tcp", *addrFlag)
	if err != nil {
		fmt.Fprintln(os.Stderr, "mockgemini:", err)
		os.Exit(1)
	}
	base := "http://" + ln.Addr().String()
	srv := &server{models: splitList(*modelsFlag)}
	if *logFlag != "" {
		f, err := os.OpenFile(*logFlag, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			fmt.Fprintln(os.Stderr, "mockgemini:", err)
			os.Exit(1)
		}
		defer f.Close()
		srv.log = f
	}
	if *urlFileFlag != "" {
		if err := os.WriteFile(*urlFileFlag, []byte(base+"\n"), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, "mockgemini:", err)
			os.Exit(1)
		}
	}
	fmt.Println("MOCKGEMINI_URL=" + base)

	httpSrv := &http.Server{Handler: srv}
	go func() {
		sigs := make(chan os.Signal, 1)
		signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
		<-sigs
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(ctx)
	}()
	if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, "mockgemini:", err)
		os.Exit(1)
	}
}

type server struct {
	models []string
	seq    atomic.Int64
	logMu  sync.Mutex
	log    io.Writer
}

// logEntry is one line of the request log. The API key itself is never written: only
// where it came from and how long it was, which is what a test needs to assert.
type logEntry struct {
	Seq       int64           `json:"seq"`
	Time      string          `json:"time"`
	Method    string          `json:"method"`
	Path      string          `json:"path,omitempty"`
	Query     string          `json:"query,omitempty"`
	Host      string          `json:"host,omitempty"`
	KeySource string          `json:"keySource,omitempty"`
	KeyLen    int             `json:"keyLen,omitempty"`
	UserAgent string          `json:"userAgent,omitempty"`
	Body      json.RawMessage `json:"body,omitempty"`
	Reply     string          `json:"reply,omitempty"`
}

func (s *server) record(e logEntry) {
	if s.log == nil {
		return
	}
	line, err := json.Marshal(e)
	if err != nil {
		return
	}
	s.logMu.Lock()
	defer s.logMu.Unlock()
	_, _ = s.log.Write(append(line, '\n'))
}

var modelPath = regexp.MustCompile(`^/v1(?:beta|alpha)?/models/([^/:]+)(?::([A-Za-z]+))?$`)

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	e := logEntry{
		Seq:       s.seq.Add(1),
		Time:      time.Now().UTC().Format(time.RFC3339Nano),
		Method:    r.Method,
		Path:      r.URL.Path,
		Query:     redactKey(r.URL.Query()),
		UserAgent: r.UserAgent(),
	}
	if r.Method == http.MethodConnect || r.URL.IsAbs() {
		e.Path, e.Host = "", r.Host
		s.proxy(w, r, &e)
		s.record(e)
		return
	}
	key, source := apiKey(r)
	e.KeySource, e.KeyLen = source, len(key)
	body, _ := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if json.Valid(body) {
		e.Body = body
	}
	defer func() { s.record(e) }()

	if *wantKeyFlag != "" && key != *wantKeyFlag {
		e.Reply = "error 400 API_KEY_INVALID"
		writeError(w, 400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.",
			map[string]interface{}{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "API_KEY_INVALID", "domain": "googleapis.com"})
		return
	}

	if r.Method == http.MethodGet && (r.URL.Path == "/v1beta/models" || r.URL.Path == "/v1/models") {
		models := make([]interface{}, 0, len(s.models))
		for _, id := range s.models {
			models = append(models, modelInfo(id))
		}
		e.Reply = "models"
		writeJSON(w, 200, map[string]interface{}{"models": models})
		return
	}
	m := modelPath.FindStringSubmatch(r.URL.Path)
	if m == nil && *staticFlag != "" && r.Method == http.MethodGet {
		if path := filepath.Join(*staticFlag, filepath.FromSlash(filepath.Clean("/"+r.URL.Path))); fileExists(path) {
			e.Reply = "static"
			http.ServeFile(w, r, path)
			return
		}
	}
	if m == nil {
		e.Reply = "error 404"
		writeError(w, 404, "NOT_FOUND", "mockgemini has no route for "+r.Method+" "+r.URL.Path)
		return
	}
	model, method := m[1], m[2]
	switch {
	case r.Method == http.MethodGet && method == "":
		e.Reply = "model"
		writeJSON(w, 200, modelInfo(model))
	case r.Method == http.MethodPost && method == "countTokens":
		e.Reply = "countTokens"
		writeJSON(w, 200, map[string]interface{}{"totalTokens": approxTokens(len(body))})
	case r.Method == http.MethodPost && (method == "streamGenerateContent" || method == "generateContent"):
		var req genRequest
		if err := json.Unmarshal(body, &req); err != nil {
			e.Reply = "error 400 bad body"
			writeError(w, 400, "INVALID_ARGUMENT", "mockgemini could not parse the request: "+err.Error())
			return
		}
		reply, label := pickReply(&req)
		e.Reply = label
		usage := reply.usageFor(len(body))
		if method == "generateContent" {
			serveWhole(w, r, model, reply, usage)
		} else {
			serveStream(w, r, model, reply, usage, r.URL.Query().Get("alt") == "sse")
		}
	default:
		e.Reply = "error 404"
		writeError(w, 404, "NOT_FOUND", "mockgemini has no route for "+r.Method+" "+r.URL.Path)
	}
}

// proxy records the host a client tried to reach through HTTPS_PROXY. It refuses by
// default, which keeps a test offline and makes "did the CLI try to phone home" a
// question the log answers.
func (s *server) proxy(w http.ResponseWriter, r *http.Request, e *logEntry) {
	if r.Method != http.MethodConnect || !*tunnelFlag {
		e.Reply = "proxy refused"
		http.Error(w, "mockgemini: outbound connection refused", http.StatusForbidden)
		return
	}
	upstream, err := net.DialTimeout("tcp", r.Host, 10*time.Second)
	if err != nil {
		e.Reply = "proxy dial failed: " + err.Error()
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		upstream.Close()
		e.Reply = "proxy cannot hijack"
		http.Error(w, "cannot hijack", http.StatusInternalServerError)
		return
	}
	client, buf, err := hj.Hijack()
	if err != nil {
		upstream.Close()
		e.Reply = "proxy hijack failed"
		return
	}
	e.Reply = "proxy tunnelled"
	_, _ = client.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n"))
	go func() {
		defer upstream.Close()
		defer client.Close()
		go func() {
			if n := buf.Reader.Buffered(); n > 0 {
				pending, _ := buf.Reader.Peek(n)
				_, _ = upstream.Write(pending)
			}
			_, _ = io.Copy(upstream, client)
		}()
		_, _ = io.Copy(client, upstream)
	}()
}

// --- request shape (only what the script reads) ---

type genRequest struct {
	Contents []content        `json:"contents"`
	Tools    []map[string]any `json:"tools"`
}

type content struct {
	Role  string `json:"role"`
	Parts []struct {
		Text             string          `json:"text"`
		Thought          bool            `json:"thought"`
		FunctionCall     json.RawMessage `json:"functionCall"`
		FunctionResponse json.RawMessage `json:"functionResponse"`
	} `json:"parts"`
}

func (c content) text() string {
	var b strings.Builder
	for _, p := range c.Parts {
		if !p.Thought && p.Text != "" {
			if b.Len() > 0 {
				b.WriteString("\n")
			}
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

// isModelTurn: a content the model produced. agy sends tool results back as
// functionResponse parts under role "model" rather than "user", so a model content
// holding nothing but tool results is not a turn of its own.
func (c content) isModelTurn() bool {
	if c.Role != "model" {
		return false
	}
	for _, p := range c.Parts {
		if len(p.FunctionResponse) == 0 {
			return true
		}
	}
	return false
}

func (r *genRequest) declaresTools() bool {
	for _, t := range r.Tools {
		if len(t) > 0 {
			return true
		}
	}
	return false
}

// --- the script ---

// reply is one model turn: what one generateContent call answers.
type reply struct {
	parts      []map[string]interface{}
	finish     string
	sleep      time.Duration
	hang       bool
	errCode    int
	errStatus  string
	errMessage string
	retryDelay string
	usage      []int // prompt, output, thoughts, cached; nil = estimated
}

var directive = regexp.MustCompile(`(?m)^[ \t]*mock:([a-z-]+)[ \t]*(.*?)[ \t]*$`)

// pickReply finds the most recent user message carrying `mock:` lines and answers the
// model turn the conversation has reached since it: the first reply for the request
// that carries the message, the second once one model turn (a tool call) has come
// back, and so on. Retries of the same request get the same reply. A request with no
// tools (titles, summaries and other side calls) is never scripted, so a scenario can
// not leak into them.
func pickReply(req *genRequest) (reply, string) {
	if !req.declaresTools() {
		return textReply("mock reply: " + summarize(lastUserText(req))), "text (no tools declared)"
	}
	for i := len(req.Contents) - 1; i >= 0; i-- {
		c := req.Contents[i]
		if c.Role != "user" {
			continue
		}
		lines := directive.FindAllStringSubmatch(c.text(), -1)
		if len(lines) == 0 {
			continue
		}
		replies := parseScript(lines)
		turn := 0
		for _, later := range req.Contents[i+1:] {
			if later.isModelTurn() {
				turn++
			}
		}
		if turn >= len(replies) {
			return textReply("mock: script finished"), fmt.Sprintf("script past end (turn %d of %d)", turn+1, len(replies))
		}
		return replies[turn], fmt.Sprintf("script turn %d of %d: %s", turn+1, len(replies), replies[turn].label())
	}
	return textReply("mock reply: " + summarize(lastUserText(req))), "text (no script)"
}

func parseScript(lines [][]string) []reply {
	var replies []reply
	cur := reply{}
	open := false
	closeReply := func() {
		replies = append(replies, cur)
		cur, open = reply{}, false
	}
	for _, l := range lines {
		verb, arg := l[1], l[2]
		switch verb {
		case "text", "think":
			p := map[string]interface{}{"text": strings.ReplaceAll(arg, `\n`, "\n")}
			if verb == "think" {
				p["thought"] = true
			}
			cur.parts = append(cur.parts, p)
			open = true
		case "tool":
			name, args, _ := strings.Cut(arg, " ")
			var parsed map[string]interface{}
			if err := json.Unmarshal([]byte(strings.TrimSpace(args)), &parsed); err != nil || parsed == nil {
				parsed = map[string]interface{}{}
			}
			cur.parts = append(cur.parts, map[string]interface{}{
				"functionCall": map[string]interface{}{"name": name, "args": parsed},
				// Gemini 3 models return a signature with the first call of a turn and
				// expect it back; the CLI must round-trip it, so the mock hands one out.
				"thoughtSignature": "bW9ja2dlbWluaQ==",
			})
			closeReply()
		case "error":
			fields := strings.Fields(arg)
			cur.errCode, cur.errStatus = 500, "INTERNAL"
			if len(fields) > 0 {
				if n, err := strconv.Atoi(fields[0]); err == nil {
					cur.errCode = n
				}
			}
			if len(fields) > 1 {
				cur.errStatus = fields[1]
			}
			rest := []string{}
			for _, f := range fields[min(2, len(fields)):] {
				if v, ok := strings.CutPrefix(f, "retryDelay="); ok {
					cur.retryDelay = v
					continue
				}
				rest = append(rest, f)
			}
			cur.errMessage = strings.Join(rest, " ")
			if cur.errMessage == "" {
				cur.errMessage = "mockgemini scripted error"
			}
			closeReply()
		case "finish":
			cur.finish = arg
			open = true
		case "sleep":
			if d, err := time.ParseDuration(arg); err == nil {
				cur.sleep = d
			}
			open = true
		case "usage":
			for _, f := range strings.Fields(arg) {
				n, _ := strconv.Atoi(f)
				cur.usage = append(cur.usage, n)
			}
			open = true
		case "hang":
			cur.hang = true
			closeReply()
		}
	}
	if open || len(replies) == 0 {
		if len(cur.parts) == 0 {
			cur.parts = append(cur.parts, map[string]interface{}{"text": "mock: done"})
		}
		closeReply()
	} else if last := replies[len(replies)-1]; last.errCode == 0 && !last.hang && hasCall(last) {
		replies = append(replies, textReply("mock: tool result received"))
	}
	return replies
}

func hasCall(r reply) bool {
	for _, p := range r.parts {
		if p["functionCall"] != nil {
			return true
		}
	}
	return false
}

func (r reply) label() string {
	switch {
	case r.errCode != 0:
		return fmt.Sprintf("error %d %s", r.errCode, r.errStatus)
	case r.hang:
		return "hang"
	case hasCall(r):
		for _, p := range r.parts {
			if fc, ok := p["functionCall"].(map[string]interface{}); ok {
				return "tool " + fmt.Sprint(fc["name"])
			}
		}
	}
	return "text"
}

func textReply(text string) reply {
	return reply{parts: []map[string]interface{}{{"text": text}}}
}

func (r reply) usageFor(bodyLen int) map[string]interface{} {
	out, thoughts := 0, 0
	for _, p := range r.parts {
		if t, ok := p["text"].(string); ok {
			n := approxTokens(len(t))
			if p["thought"] == true {
				thoughts += n
			} else {
				out += n
			}
		}
		if fc := p["functionCall"]; fc != nil {
			raw, _ := json.Marshal(fc)
			out += approxTokens(len(raw))
		}
	}
	prompt, cached := approxTokens(bodyLen), 0
	for i, v := range r.usage {
		switch i {
		case 0:
			prompt = v
		case 1:
			out = v
		case 2:
			thoughts = v
		case 3:
			cached = v
		}
	}
	u := map[string]interface{}{
		"promptTokenCount":     prompt,
		"candidatesTokenCount": out,
		"totalTokenCount":      prompt + out + thoughts,
	}
	if thoughts > 0 {
		u["thoughtsTokenCount"] = thoughts
	}
	if cached > 0 {
		u["cachedContentTokenCount"] = cached
	}
	return u
}

// --- responses ---

// chunks splits a reply into streamed pieces the way the API does: text and thoughts
// arrive a few words at a time, a function call arrives whole.
func (r reply) chunks() [][]map[string]interface{} {
	var out [][]map[string]interface{}
	for _, p := range r.parts {
		text, isText := p["text"].(string)
		if !isText {
			out = append(out, []map[string]interface{}{p})
			continue
		}
		for _, piece := range splitRunes(text, *chunkRunes) {
			q := map[string]interface{}{"text": piece}
			if p["thought"] == true {
				q["thought"] = true
			}
			out = append(out, []map[string]interface{}{q})
		}
	}
	return out
}

func responseChunk(model, id string, parts []map[string]interface{}, finish string, usage map[string]interface{}) map[string]interface{} {
	cand := map[string]interface{}{"content": map[string]interface{}{"role": "model", "parts": parts}, "index": 0}
	if finish != "" {
		cand["finishReason"] = finish
	}
	resp := map[string]interface{}{"candidates": []interface{}{cand}, "modelVersion": model, "responseId": id}
	if usage != nil {
		resp["usageMetadata"] = usage
	}
	return resp
}

func serveStream(w http.ResponseWriter, r *http.Request, model string, rep reply, usage map[string]interface{}, sse bool) {
	if !pause(r.Context(), rep.sleep) {
		return
	}
	if rep.errCode != 0 {
		writeScriptedError(w, rep)
		return
	}
	flusher, _ := w.(http.Flusher)
	if sse {
		w.Header().Set("Content-Type", "text/event-stream")
	} else {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(200)
	id := randomID()
	chunks := rep.chunks()
	first := true
	send := func(v map[string]interface{}) {
		raw, _ := json.Marshal(v)
		if sse {
			fmt.Fprintf(w, "data: %s\r\n\r\n", raw)
		} else {
			if first {
				w.Write([]byte("["))
			} else {
				w.Write([]byte(",\r\n"))
			}
			w.Write(raw)
		}
		first = false
		if flusher != nil {
			flusher.Flush()
		}
	}
	for i, parts := range chunks {
		last := i == len(chunks)-1
		if last && !rep.hang {
			send(responseChunk(model, id, parts, finishOr(rep.finish), usage))
		} else {
			send(responseChunk(model, id, parts, "", nil))
		}
		if !last && !pause(r.Context(), *chunkDelayFlag) {
			return
		}
	}
	if rep.hang {
		// Hold the stream open until the client gives up on it: the shape of a model
		// that is still thinking when the user interrupts.
		<-r.Context().Done()
		return
	}
	if !sse {
		w.Write([]byte("]"))
	}
}

func serveWhole(w http.ResponseWriter, r *http.Request, model string, rep reply, usage map[string]interface{}) {
	if !pause(r.Context(), rep.sleep) {
		return
	}
	if rep.errCode != 0 {
		writeScriptedError(w, rep)
		return
	}
	if rep.hang {
		<-r.Context().Done()
		return
	}
	writeJSON(w, 200, responseChunk(model, randomID(), rep.parts, finishOr(rep.finish), usage))
}

func writeScriptedError(w http.ResponseWriter, rep reply) {
	var details []interface{}
	if rep.retryDelay != "" {
		details = append(details, map[string]interface{}{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": rep.retryDelay})
	}
	writeError(w, rep.errCode, rep.errStatus, rep.errMessage, details...)
}

func writeError(w http.ResponseWriter, code int, status, message string, details ...interface{}) {
	body := map[string]interface{}{"code": code, "message": message, "status": status}
	if len(details) > 0 {
		body["details"] = details
	}
	writeJSON(w, code, map[string]interface{}{"error": body})
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func modelInfo(id string) map[string]interface{} {
	return map[string]interface{}{
		"name":                       "models/" + id,
		"baseModelId":                id,
		"version":                    "001",
		"displayName":                id,
		"inputTokenLimit":            1048576,
		"outputTokenLimit":           65536,
		"supportedGenerationMethods": []string{"generateContent", "countTokens"},
		"thinking":                   true,
	}
}

// --- helpers ---

func apiKey(r *http.Request) (string, string) {
	if k := r.Header.Get("x-goog-api-key"); k != "" {
		return k, "x-goog-api-key"
	}
	if k := r.URL.Query().Get("key"); k != "" {
		return k, "query"
	}
	if a := r.Header.Get("Authorization"); a != "" {
		return strings.TrimPrefix(a, "Bearer "), "authorization"
	}
	return "", ""
}

func redactKey(q map[string][]string) string {
	if len(q) == 0 {
		return ""
	}
	var b strings.Builder
	for k, vs := range q {
		for _, v := range vs {
			if k == "key" {
				v = "<redacted>"
			}
			if b.Len() > 0 {
				b.WriteString("&")
			}
			b.WriteString(k + "=" + v)
		}
	}
	return b.String()
}

func lastUserText(req *genRequest) string {
	for i := len(req.Contents) - 1; i >= 0; i-- {
		if req.Contents[i].Role == "user" {
			if t := req.Contents[i].text(); t != "" {
				return t
			}
		}
	}
	return ""
}

func summarize(s string) string {
	s = strings.TrimSpace(s)
	if line, _, ok := strings.Cut(s, "\n"); ok {
		s = line
	}
	if utf8.RuneCountInString(s) > 120 {
		s = string([]rune(s)[:120]) + "…"
	}
	return s
}

func splitRunes(s string, n int) []string {
	if n <= 0 {
		return []string{s}
	}
	runes := []rune(s)
	var out []string
	for len(runes) > n {
		out = append(out, string(runes[:n]))
		runes = runes[n:]
	}
	return append(out, string(runes))
}

func pause(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	select {
	case <-time.After(d):
		return true
	case <-ctx.Done():
		return false
	}
}

func finishOr(reason string) string {
	if reason == "" {
		return "STOP"
	}
	return reason
}

func approxTokens(n int) int { return n/4 + 1 }

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func randomID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func splitList(s string) []string {
	var out []string
	for _, f := range strings.Split(s, ",") {
		if f = strings.TrimSpace(f); f != "" {
			out = append(out, f)
		}
	}
	return out
}
