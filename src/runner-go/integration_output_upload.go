package main

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// The upload side of a check's output (contract §2.2 J-T4's output route, §2.9 LS2, design
// docs/landing-session-design.md §8 phase 3): what a check prints is streamed to the control plane
// in chunks while it runs, so a landing page can show it instead of the 16 KB tail a result alone
// carries.
//
// Only a v2 claim uploads. A legacy claim has no progress sender, so it gets no uploader and keeps
// exactly what it always had — the tail its result carries. The 16 KB tail is unchanged on every
// claim: `integrationOutput.text()` still answers it, and the uploader reads the same writes without
// taking anything away from that buffer.
const (
	// How much output one upload carries. The contract's chunk is small on purpose: a check that
	// prints for an hour must not make one request the whole log.
	integrationOutputChunkBytes = 16 * 1024
	// How often pending output is flushed while a check runs. A quiet check still says what it
	// printed promptly enough to watch.
	integrationOutputEvery = 2 * time.Second
	// How many trailing bytes are held back between flushes, so a secret (or a URL's userinfo)
	// split across two chunks is still matched whole by the redactor. It is one less than the
	// longest secret, or further back to the scheme of an address the text ends in whose authority
	// has not ended yet, capped either way: a value longer than this is redacted only when it
	// arrives whole.
	integrationOutputCarryMax = 256
	// The budget one flush has to reach the control plane. Uploads are best-effort and must never
	// hold a check's end for long.
	integrationOutputDrainTimeout = 10 * time.Second
	// Shortest environment value treated as a secret. Anything shorter would be a byte sequence
	// that occurs in ordinary output, and replacing it would mangle the log rather than redact it.
	integrationOutputMinSecret = 8
	// What a redacted secret reads as. English, like every word a person or an agent reads.
	integrationOutputRedacted = "[redacted]"
)

// integrationOutputSender sends one chunk. The transport's POST in the runloop, a recorder in a
// test. It takes a context because a send in flight when the job ends is abandoned.
type integrationOutputSender func(ctx context.Context, req IntegrationJobOutputRequest) error

// integrationLogRoute is the check the output now being written belongs to.
type integrationLogRoute struct {
	check IntegrationJobOutputCheck
}

func (r *integrationLogRoute) key() string {
	return fmt.Sprintf("%s/%d", r.check.Name, r.check.Index)
}

// integrationLogUploader is the writer's sink: it accumulates what a command prints and sends it in
// ordered chunks, one check at a time, while the command runs.
//
// One goroutine does every send, so chunks of one check cannot overtake each other and the seq
// numbering is a plain counter. Writes never wait on the network: they append under the mutex and
// signal the goroutine, which is what keeps a slow control plane from stalling a check. A send that
// is refused as a dead claim (409 STALE_CLAIM / ALREADY_FINAL or 404) stops the uploader: there is
// nothing left to write into, and the progress report will end the job.
type integrationLogUploader struct {
	ctx        context.Context
	send       integrationOutputSender
	redact     *integrationOutputRedactor
	chunkBytes int
	every      time.Duration
	carry      int

	mu      sync.Mutex
	current *integrationLogRoute
	pending []byte
	seq     map[string]int
	stopped bool
	noted   bool

	kick  chan struct{}
	flush chan flushRequest
	done  chan struct{}
	wg    sync.WaitGroup
}

type flushRequest struct {
	// route is the command's check, captured before it was detached: writes that arrive after
	// Close are dropped, and the pending bytes still belong to this check.
	route *integrationLogRoute
	ack   chan struct{}
}

func newIntegrationLogUploader(ctx context.Context, cmd IntegrationJobCommand) *integrationLogUploader {
	if cmd.outputSender == nil {
		return nil
	}
	redactor := cmd.outputRedactor
	if redactor == nil {
		redactor = newIntegrationOutputRedactor()
	}
	chunk := cmd.outputChunkBytes
	if chunk <= 0 {
		chunk = integrationOutputChunkBytes
	}
	every := cmd.outputEvery
	if every <= 0 {
		every = integrationOutputEvery
	}
	carry := redactor.carry()
	if carry > integrationOutputCarryMax {
		carry = integrationOutputCarryMax
	}
	u := &integrationLogUploader{
		ctx: ctx, send: cmd.outputSender, redact: redactor,
		chunkBytes: chunk, every: every, carry: carry,
		seq:   make(map[string]int),
		kick:  make(chan struct{}, 1),
		flush: make(chan flushRequest),
		done:  make(chan struct{}),
	}
	u.wg.Add(1)
	go u.loop()
	return u
}

// attach starts a new command's output: its writes belong to check from here, and its seq
// numbering continues whatever the same check already sent (the tree's recipe and the first check
// share one check's log, so the recipe's chunks are not overwritten by check 1's first chunk).
func (u *integrationLogUploader) attach(out *integrationOutput, check IntegrationJobOutputCheck) {
	u.mu.Lock()
	u.current = &integrationLogRoute{check: check}
	u.pending = nil
	u.mu.Unlock()
	out.attachSink(u)
}

// Write takes what the command printed. The bytes are copied: the caller reuses its buffer.
func (u *integrationLogUploader) Write(p []byte) {
	u.mu.Lock()
	if u.current == nil || u.stopped {
		u.mu.Unlock()
		return
	}
	u.pending = append(u.pending, p...)
	full := len(u.pending) >= u.chunkBytes
	u.mu.Unlock()
	if full {
		select {
		case u.kick <- struct{}{}:
		default:
		}
	}
}

// Close ends the current command's route: everything it printed is sent before this returns (or the
// send budget runs out), and writes that arrive afterwards — a child that outlived an ErrWaitDelay
// end still holds the pipe — are dropped rather than attributed to the next check.
func (u *integrationLogUploader) Close() {
	u.mu.Lock()
	route := u.current
	u.current = nil
	u.mu.Unlock()
	if route == nil {
		return
	}
	ack := make(chan struct{})
	select {
	case u.flush <- flushRequest{route: route, ack: ack}:
		select {
		case <-ack:
		case <-u.ctx.Done():
		}
	case <-u.ctx.Done():
	}
}

// loop is the one sender: the timer, a full buffer's kick and a route's final flush are serialised
// here, so the chunks of one check leave in exactly the order they were written.
func (u *integrationLogUploader) loop() {
	defer u.wg.Done()
	ticker := time.NewTicker(u.every)
	defer ticker.Stop()
	for {
		select {
		case <-u.done:
			u.drain(nil, true)
			return
		case req := <-u.flush:
			u.drain(req.route, true)
			close(req.ack)
		case <-ticker.C:
			u.drain(nil, false)
		case <-u.kick:
			u.drain(nil, false)
		}
	}
}

// drain sends what is pending, in chunks of at most chunkBytes. It holds back the last `carry`
// bytes between flushes so a secret split across two flushes is still whole when the redactor sees
// it, and an address the text ends in from its scheme on while its authority is unfinished; the
// final drain (a command's Close) sends everything. So the trailing word of a line that has not
// ended yet (anything that could begin a scheme) waits for the next write or for Close, and so does
// an address with no `/` or whitespace after its `://` yet, at most integrationOutputCarryMax bytes
// either way.
//
// Redaction happens FIRST, on the whole pending buffer, and the carry is taken from the redacted
// text: cutting the raw buffer and redacting only the part that is sent would send the first half of
// a secret whose second half happened to fall in the carry. What is held back is already redacted,
// so a later flush concatenating raw bytes after it redacts the same text again harmlessly.
func (u *integrationLogUploader) drain(route *integrationLogRoute, final bool) {
	u.mu.Lock()
	if route == nil {
		route = u.current
	}
	data := u.pending
	if route == nil || len(data) == 0 {
		u.mu.Unlock()
		return
	}
	if !final && len(data) <= u.carry {
		// Too little to know that no secret is cut in half: hold it until more output arrives (the
		// final drain sends it as it is).
		u.mu.Unlock()
		return
	}
	u.pending = nil
	stopped := u.stopped
	u.mu.Unlock()
	if stopped {
		return
	}
	text := u.redact.redact(string(data))
	keep := ""
	if !final {
		cut := len(text)
		if u.carry > 0 && len(text) > u.carry {
			cut = len(text) - u.carry
		}
		// An address the text ends in is held back from its scheme on while its authority is
		// unfinished, carry or no carry: sent now, `postgres://app:s3` would leave the rest of the
		// password to come as `cretPass@db`, which no rule can tell is a credential any more, and
		// `postgres://app:p@ss`, already redacted to `postgres://[redacted]@ss`, would leave
		// `@db` to make `ss` the host when it was the end of the password.
		if at := integrationUnfinishedURL(text); at < cut {
			cut = at
		}
		// With nothing to hold back the cut is len(text); the cut < len(text) bound keeps the rune
		// walk from reading text[len(text)].
		for cut > 0 && cut < len(text) && !utf8.RuneStart(text[cut]) {
			cut--
		}
		text, keep = text[:cut], text[cut:]
	}
	pieces := splitUTF8Chunks(text, u.chunkBytes)
	key := route.key()
	u.mu.Lock()
	seq := u.seq[key]
	u.seq[key] = seq + len(pieces)
	if keep != "" {
		// Older than anything written since the buffer was taken above, so it goes in front.
		u.pending = append([]byte(keep), u.pending...)
	}
	u.mu.Unlock()
	ctx, cancel := context.WithTimeout(u.ctx, integrationOutputDrainTimeout)
	defer cancel()
	for i, piece := range pieces {
		req := IntegrationJobOutputRequest{
			Check: route.check,
			Seq:   seq + i,
			Text:  piece,
		}
		if err := u.send(ctx, req); err != nil {
			if integrationProgressStopSignal(err) {
				u.mu.Lock()
				u.stopped = true
				u.pending = nil
				noted := u.noted
				u.noted = true
				u.mu.Unlock()
				if !noted {
					logln("integration output: this claim is no longer the control plane's; stopping the upload")
				}
			} else if !u.noted {
				u.mu.Lock()
				noted := u.noted
				u.noted = true
				u.mu.Unlock()
				if !noted {
					logln("integration output: a chunk was not delivered, carrying on:", err)
				}
			}
			return
		}
	}
}

// close stops the uploader after a final drain. Called from the progress reporter's close, while
// its send context is still alive.
func (u *integrationLogUploader) close() {
	close(u.done)
	u.wg.Wait()
}

// splitUTF8Chunks cuts text into pieces of at most size bytes, never inside a UTF-8 sequence: the
// control plane stores text and a cut rune would arrive as a replacement character. A piece is at
// most size+3 bytes when the boundary had to move back.
func splitUTF8Chunks(text string, size int) []string {
	if len(text) == 0 {
		return nil
	}
	if size <= 0 {
		return []string{text}
	}
	var pieces []string
	for len(text) > size {
		cut := size
		for cut > 0 && !utf8.RuneStart(text[cut]) {
			cut--
		}
		if cut == 0 {
			cut = size
		}
		pieces = append(pieces, text[:cut])
		text = text[cut:]
	}
	if len(text) > 0 {
		pieces = append(pieces, text)
	}
	return pieces
}

// integrationOutputRedactor removes the machine's own secrets from a chunk before it is uploaded
// (contract §2.2 J-T4, §2.9 LS2's "redacted before it is persisted"): the runner token this process
// authenticated with, environment values that are credentials by their name (ORBIT_USER_TOKEN and
// every *_TOKEN / *_SECRET / *_PASSWORD / *_API_KEY style variable), and the userinfo of any URL a
// command prints — a git remote's, and a database's or a message broker's just the same.
type integrationOutputRedactor struct {
	secrets       []string
	urlCredential *regexp.Regexp
}

// The userinfo half of a URL, scheme included: `https://user:token@host` and `https://token@host`
// are both a credential the machine holds and neither may reach the control plane, and neither may
// `https://token:@host`, a token given as a user with an empty password. The scheme is any
// RFC 3986 scheme (ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )), not a list: a check prints
// `postgres://app:pw@db`, `amqp://user:pw@mq` or `mongodb+srv://admin:pw@cluster` as readily as a
// git remote, and naming only https, ftp and ssh let every one of those through whole. A password
// with no user in front of it — `redis://:pw@cache`, the form a cache's address usually takes — is
// userinfo too. Nothing asks for a word boundary before the scheme: `_postgres://` and
// `jdbc:postgresql://` find their scheme where it begins, and what the replacement keeps is whatever
// scheme the rule matched, so a wider start costs a reader nothing.
//
// The userinfo runs to the LAST `@` of the authority, as net/url's Parse reads it and as the
// control plane's own redactor (src/apiserver/src/common/secret-redaction.ts) does: a raw `@` in a
// database's or a broker's password is common, and ending at the first one sent
// `postgres://app:p@ss@db` on as `postgres://[redacted]@ss@db`. The authority ends at the first `/`
// or whitespace after the `://`. Unlike net/url and the control plane's rule, a `?` or `#` does not
// end it: a raw one in a password (`postgres://app:abc#123@db`) would then end the address before
// its `@` and send the password whole, and what that costs the other way is the host of an address
// whose query follows it with no path between (`http://host?to=a@b` reads `http://[redacted]@b`).
// An `@` after the authority's `/` (`https://example.com/@scope/pkg`) is a path's and is left
// alone, and so is an empty userinfo (`http://@host`), which holds nothing.
var integrationURLCredential = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*://)[^/\s]+@`)

// The end of a text that may still turn out to be a URL's userinfo once more output arrives: a
// scheme (or the start of one), `scheme:`, `scheme:/`, `scheme://`, and an authority no `/` or
// whitespace has ended yet, with or without an `@` in it: one that has its `@` may still get
// another, and the userinfo runs to the last. Every proper prefix of what integrationURLCredential
// matches is matched here, and so is every text that a match may still grow out of, so a flush that
// stops where this begins never sends half an address.
var integrationURLCredentialTail = regexp.MustCompile(`(?i)[a-z][a-z0-9+.-]*(?::(?:/(?:/[^/\s]*)?)?)?$`)

// integrationUnfinishedURL is where an address that text ends in begins while its authority is
// unfinished, or len(text) when there is none. Only the last integrationOutputCarryMax bytes are
// looked at, so this hold-back is capped like a secret's carry: an address longer than that from its
// scheme to its last `@` is redacted only when it arrives whole, and a long run that merely reads
// like an address's start (a trailing word is a scheme until something a scheme cannot hold follows
// it, and an authority runs until a `/` or whitespace ends it) is not kept off the page until the
// command ends.
func integrationUnfinishedURL(text string) int {
	from := len(text) - integrationOutputCarryMax
	if from < 0 {
		from = 0
	}
	if at := integrationURLCredentialTail.FindStringIndex(text[from:]); at != nil {
		return from + at[0]
	}
	return len(text)
}

func newIntegrationOutputRedactor(extra ...string) *integrationOutputRedactor {
	r := &integrationOutputRedactor{urlCredential: integrationURLCredential}
	seen := make(map[string]bool)
	add := func(value string) {
		if len(value) < integrationOutputMinSecret || seen[value] {
			return
		}
		seen[value] = true
		r.secrets = append(r.secrets, value)
	}
	for _, value := range extra {
		add(value)
	}
	for _, entry := range os.Environ() {
		name, value, ok := strings.Cut(entry, "=")
		if ok && credentialEnvName(name) {
			add(value)
		}
	}
	// Longest first: a token that contains another secret is replaced whole before the shorter
	// one can split it.
	sort.Slice(r.secrets, func(i, j int) bool { return len(r.secrets[i]) > len(r.secrets[j]) })
	return r
}

// credentialEnvName reports whether an environment variable's name says its value is a credential.
// Over-inclusion is the safe direction: redacting a value that was not a secret costs a reader a
// word, and missing one costs the account its token.
func credentialEnvName(name string) bool {
	upper := strings.ToUpper(name)
	switch upper {
	case "ORBIT_USER_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN", "NPM_TOKEN":
		return true
	}
	for _, suffix := range []string{
		"_TOKEN", "_SECRET", "_PASSWORD", "_PASSWD", "_API_KEY", "_ACCESS_KEY", "_PRIVATE_KEY", "_CREDENTIALS",
	} {
		if strings.HasSuffix(upper, suffix) {
			return true
		}
	}
	return false
}

// carry is the number of trailing bytes a flush holds back, one less than the longest secret, so a
// secret straddling the boundary is still whole in the next flush.
func (r *integrationOutputRedactor) carry() int {
	longest := 0
	for _, secret := range r.secrets {
		if len(secret) > longest {
			longest = len(secret)
		}
	}
	if longest <= 1 {
		return 0
	}
	return longest - 1
}

func (r *integrationOutputRedactor) redact(text string) string {
	for _, secret := range r.secrets {
		text = strings.ReplaceAll(text, secret, integrationOutputRedacted)
	}
	return r.urlCredential.ReplaceAllString(text, "${1}"+integrationOutputRedacted+"@")
}
