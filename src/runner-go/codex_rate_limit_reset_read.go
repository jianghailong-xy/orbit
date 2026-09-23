package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// The Codex usage probe's half of docs/codex-rate-limit-reset-contract.md: each read of the
// runner's default Codex account also yields the PlanUsageRateLimitReset block (§2) the heartbeat
// carries — the provider's authoritative credit count, the account fingerprint (§3), when the read
// started and which read of which runner process it was. Nothing here consumes a credit; the reset
// steps (codex_rate_limit_reset_consume.go) make their reads through the same reader.
//
// The default account is the one the runner's own environment selects, exactly as for the usage
// windows: a runner started with OPENAI_API_KEY or OPENAI_BASE_URL reads no Codex usage at all
// (codexPlanUsageStateForEnv), so it reports no block and offers no reset. A session whose env
// overrides the account (CODEX_HOME, CODEX_API_KEY, OPENAI_*) never reaches the probe
// (codexSessionAccountSlot): another slot's session refreshes that slot's own snapshot, which carries
// no block (codex_account_usage.go). A default-account session's rolling rate-limit notifications
// never create or change a block.

const codexResetFetchedAtLayout = "2006-01-02T15:04:05.000Z"

// codexResetReader numbers and stamps the reset blocks of one runner process.
type codexResetReader struct {
	// This process's heartbeat leaseOwner: the generation of every block it reads.
	leaseOwner string
	// The sequence of the last read this process started; the first block is 1.
	sequence atomic.Int64

	mu        sync.Mutex
	lastIssue string
}

// readCodexPlanUsage makes the probe's reads on an initialized app-server: account/read for the
// auth mode, then account/rateLimits/read — without excludeResetCreditDetails — for the windows,
// the reset credits and the account id. A failed account/read costs only the block: the windows
// still arrive, and the cached block from the last good read ages as §2 says.
func (r *codexResetReader) readCodexPlanUsage(ctx context.Context, app *codexAppServer) (*PlanUsage, error) {
	started := time.Now()
	sequence := r.sequence.Add(1)
	account, accountErr := app.request(ctx, codexAccountReadMethod, map[string]interface{}{"refreshToken": false})
	rateLimits, err := app.request(ctx, codexRateLimitsReadMethod, nil)
	if err != nil {
		return nil, err
	}
	usage, err := parseCodexPlanUsage(rateLimits)
	if err != nil {
		return nil, err
	}
	if accountErr != nil {
		r.note(codexAccountReadMethod + " failed")
		return usage, nil
	}
	usage.RateLimitReset = r.block(account, rateLimits, started, sequence)
	return usage, nil
}

// block is the reset block of one read. The account id only feeds the fingerprint: nothing else
// of it, and nothing of account/read beyond the auth mode, leaves this function.
func (r *codexResetReader) block(account, rateLimits map[string]interface{}, started time.Time, sequence int64) *PlanUsageRateLimitReset {
	support, accountID, credits := codexRateLimitResetFromRead(account, rateLimits)
	block := &PlanUsageRateLimitReset{
		ProtocolVersion:       codexRateLimitResetProtocolVersion,
		Support:               support,
		RateLimitResetCredits: credits,
		FetchedAt:             started.UTC().Format(codexResetFetchedAtLayout),
		Generation:            r.leaseOwner,
		Sequence:              sequence,
	}
	issue := ""
	if accountID != "" {
		if key, err := loadCodexAccountFingerprintKey(); err != nil {
			// §3: an account that cannot be fingerprinted cannot be bound to an operation.
			issue = "the account fingerprint key is unusable: " + err.Error()
			block.Support, block.RateLimitResetCredits = codexResetAccountUnidentified, nil
		} else {
			block.AccountFingerprint = codexAccountFingerprint(key, accountID)
		}
	}
	if violations := codexRateLimitResetBlockViolations(*block); len(violations) > 0 {
		r.note("this process's block is invalid: " + strings.Join(violations, "; "))
		return nil
	}
	r.note(issue)
	return block
}

// note logs why a read offered no reset, once per distinct reason, and never with provider text:
// an app-server error message can name the account.
func (r *codexResetReader) note(issue string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if issue != "" && issue != r.lastIssue {
		logln("codex rate-limit reset unavailable:", issue)
	}
	r.lastIssue = issue
}

// loadCodexAccountFingerprintKey returns the runner-local fingerprint key, creating it on first
// use. It is read fresh each time, so every process sharing this machine home names an account
// the same way.
func loadCodexAccountFingerprintKey() ([]byte, error) {
	path := filepath.Join(machineHome(), codexAccountFingerprintKeyFile)
	key, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		key, err = createCodexAccountFingerprintKey(path)
	}
	if err != nil {
		return nil, err
	}
	if len(key) != codexAccountFingerprintKeySize {
		return nil, fmt.Errorf("%s does not hold a %d-byte key", path, codexAccountFingerprintKeySize)
	}
	return key, nil
}

// createCodexAccountFingerprintKey writes a new key into a private O_EXCL temp file and links it
// into place, so a racing process finds either no key or all of it, and the first link wins.
func createCodexAccountFingerprintKey(path string) ([]byte, error) {
	key := make([]byte, codexAccountFingerprintKeySize)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, machineHomePerm); err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(dir, codexAccountFingerprintKeyFile+".*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())
	_, writeErr := tmp.Write(key)
	syncErr := tmp.Sync()
	if err := errors.Join(writeErr, syncErr, tmp.Close()); err != nil {
		return nil, err
	}
	if err := os.Link(tmp.Name(), path); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return os.ReadFile(path)
		}
		return nil, err
	}
	return key, nil
}

// codexResetBlockSupersedes reports whether next may replace previous in the probe cache, in the
// order the control plane stores blocks (orderCodexResetSnapshot): a later read start, or the same
// millisecond and a later read of the same process.
func codexResetBlockSupersedes(next, previous *PlanUsageRateLimitReset) bool {
	switch {
	case next == nil:
		return false
	case previous == nil:
		return true
	case next.FetchedAt != previous.FetchedAt:
		return next.FetchedAt > previous.FetchedAt
	default:
		return next.Generation == previous.Generation && next.Sequence > previous.Sequence
	}
}
