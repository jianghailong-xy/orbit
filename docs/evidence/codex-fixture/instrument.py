import sys
p = sys.argv[1]
s = open(p).read()
def sub(old, new):
    global s
    assert s.count(old) == 1, old
    s = s.replace(old, new)
# 1. log every app-server notification that matters, with a wall-clock stamp
sub('''		msg := read()
		params := rawObject(msg.Params)
		switch msg.Method {''', '''		msg := read()
		params := rawObject(msg.Params)
		if msg.Method == "error" || msg.Method == "turn/completed" || msg.Method == "turn/started" {
			raw, _ := json.Marshal(params)
			t.Logf("EVIDENCE [%s] %s notification %s: %s", rec.scenario, time.Now().Format("15:04:05.000"), msg.Method, raw)
		}
		switch msg.Method {''')
# 2. log the recorder's exchanges in order
sub('''	rec.mu.Lock()
	for _, exchange := range rec.seen {''', '''	rec.mu.Lock()
	for i, exchange := range rec.seen {
		gap := time.Duration(0)
		if i > 0 {
			gap = exchange.at.Sub(rec.seen[i-1].at)
		}
		t.Logf("EVIDENCE [%s] %s exchange %d: %s %s upgrade=%q auth=%.24s... -> %d (+%v since previous answer)", rec.scenario, exchange.at.Format("15:04:05.000"), i, exchange.Request.Method, exchange.Request.Path, headerOf(exchange.Request.Headers, "upgrade"), headerOf(exchange.Request.Headers, "authorization"), exchange.Response.Status, gap.Round(time.Millisecond))
	}
	for _, exchange := range rec.seen {''')
# 3. a control scenario: the same 429 without retry-after
sub('''		case "rateLimit":''', '''		case "rateLimitNoAdvice":
			jsonAnswer(http.StatusTooManyRequests, map[string]interface{}{"error": map[string]interface{}{
				"type": "rate_limit_exceeded", "code": "rate_limit_exceeded",
				"message": "Rate limit reached. Please try again in 2s.",
			}})
		case "rateLimit":''')
# 4. run the control and print every verdict
sub('''	target := os.Getenv("ORBIT_RECORD_CODEX_CHATGPT_FIXTURE")''', '''	_, noAdviceVerdict := record("rateLimitNoAdvice")
	for name, v := range map[string]recordedCodexVerdict{"turn": turnVerdict, "refresh": refreshVerdict, "usageLimit": usageVerdict, "rateLimit": rateVerdict, "rateLimitNoAdvice": noAdviceVerdict} {
		raw, _ := json.Marshal(v)
		t.Logf("EVIDENCE verdict %s: %s", name, raw)
	}
	target := os.Getenv("ORBIT_RECORD_CODEX_CHATGPT_FIXTURE")''')
open(p, 'w').write(s)
print("instrumented")
