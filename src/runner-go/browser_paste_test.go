package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"orbit/linkpb"
)

// Paste into the browser (browser_paste.go) against a fake DevTools endpoint: /json/list and one WebSocket per page,
// answering Runtime.evaluate with the page's focus score and recording Input.insertText.

const pasteSample = "密码 Pässwörd 🔑"

type fakeDevTools struct {
	srv *httptest.Server
	// scores is each page's answer to the focus probe, by page name.
	scores map[string]int
	mu     sync.Mutex
	// inserted is each Input.insertText, as "page:text".
	inserted []string
}

func newFakeDevTools(t *testing.T, scores map[string]int) *fakeDevTools {
	t.Helper()
	d := &fakeDevTools{scores: scores}
	mux := http.NewServeMux()
	mux.HandleFunc("/json/list", func(w http.ResponseWriter, r *http.Request) {
		var list []map[string]string
		names := make([]string, 0, len(scores))
		for name := range scores {
			names = append(names, name)
		}
		slices.Sort(names)
		for _, name := range names {
			list = append(list, map[string]string{
				"type": "page", "url": "https://example.test/" + name,
				"webSocketDebuggerUrl": "ws://" + r.Host + "/devtools/page/" + name,
			})
		}
		list = append(list, map[string]string{"type": "service_worker", "url": "https://example.test/sw.js",
			"webSocketDebuggerUrl": "ws://" + r.Host + "/devtools/page/sw"})
		_ = json.NewEncoder(w).Encode(list)
	})
	mux.HandleFunc("/devtools/page/", func(w http.ResponseWriter, r *http.Request) {
		page := strings.TrimPrefix(r.URL.Path, "/devtools/page/")
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		for {
			_, data, err := c.Read(r.Context())
			if err != nil {
				return
			}
			var cmd struct {
				ID     int            `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if err := json.Unmarshal(data, &cmd); err != nil {
				t.Errorf("a command that is not JSON: %v", err)
				return
			}
			// An event first, which the client must skip.
			_ = c.Write(r.Context(), websocket.MessageText, []byte(`{"method":"Page.frameNavigated","params":{}}`))
			var result any = map[string]any{}
			switch cmd.Method {
			case "Runtime.evaluate":
				result = map[string]any{"result": map[string]any{"type": "number", "value": d.scores[page]}}
			case "Input.insertText":
				d.mu.Lock()
				d.inserted = append(d.inserted, page+":"+cmd.Params["text"].(string))
				d.mu.Unlock()
			default:
				t.Errorf("unexpected %s", cmd.Method)
			}
			out, _ := json.Marshal(map[string]any{"id": cmd.ID, "result": result})
			_ = c.Write(r.Context(), websocket.MessageText, out)
		}
	})
	d.srv = httptest.NewServer(mux)
	t.Cleanup(d.srv.Close)
	return d
}

func (d *fakeDevTools) insertedTexts() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.inserted)
}

// The text goes, exactly and once, to the page whose field has focus, not to a background tab or the shown page
// without a field.
func TestPasteInsertsTheExactTextIntoTheFocusedField(t *testing.T) {
	d := newFakeDevTools(t, map[string]int{"background": 0, "focused-field": 6, "visible": 1})
	if err := insertBrowserText(context.Background(), d.srv.URL, pasteSample); err != nil {
		t.Fatalf("insert: %v", err)
	}
	if got := d.insertedTexts(); len(got) != 1 || got[0] != "focused-field:"+pasteSample {
		t.Fatalf("inserted %q", got)
	}
}

func TestPasteWithNoFieldFocusedIsRefusedAndInsertsNothing(t *testing.T) {
	d := newFakeDevTools(t, map[string]int{"shown": 2, "background": 0})
	err := insertBrowserText(context.Background(), d.srv.URL, pasteSample)
	if err != errBrowserPasteNoField {
		t.Fatalf("err = %v", err)
	}
	none := newFakeDevTools(t, map[string]int{"background": 0})
	if err := insertBrowserText(context.Background(), none.srv.URL, pasteSample); err != errBrowserPasteNoFocus {
		t.Fatalf("err = %v", err)
	}
	if len(d.insertedTexts())+len(none.insertedTexts()) != 0 {
		t.Fatal("something was inserted")
	}
}

// A page is shown but none has the window's focus: Chrome's own UI has it (the address bar), which DevTools cannot
// reach, so the text goes through the display's clipboard instead, exactly and once.
func TestPasteWithTheFocusInChromesOwnUIGoesThroughTheClipboard(t *testing.T) {
	var got []string
	prev := pasteIntoBrowserUI
	pasteIntoBrowserUI = func(_ context.Context, text string) error { got = append(got, text); return nil }
	t.Cleanup(func() { pasteIntoBrowserUI = prev })
	d := newFakeDevTools(t, map[string]int{"shown": 1, "background": 0})
	if err := insertBrowserText(context.Background(), d.srv.URL, pasteSample); err != nil {
		t.Fatalf("insert: %v", err)
	}
	if len(got) != 1 || got[0] != pasteSample || len(d.insertedTexts()) != 0 {
		t.Fatalf("through the clipboard %q, inserted %q", got, d.insertedTexts())
	}
}

func TestPasteOverTheCapIsRefusedWithoutAskingTheBrowser(t *testing.T) {
	d := newFakeDevTools(t, map[string]int{"focused-field": 6})
	err := insertBrowserText(context.Background(), d.srv.URL, strings.Repeat("x", browserPasteMaxBytes+1))
	if err == nil || strings.Contains(err.Error(), "xxx") {
		t.Fatalf("err = %v", err)
	}
	if len(d.insertedTexts()) != 0 {
		t.Fatal("something was inserted")
	}
}

// A managed runner declares link-stream-paste-v1; a StreamPaste on an open stream is inserted and answered, in order,
// and its failure is answered with the error, which never quotes the text.
func TestALinkStreamPasteIsInsertedAndAnswered(t *testing.T) {
	asManagedRunner(t)
	vnc := listenVNC(t)
	r := newLinkStreamRig(t, true, vnc.path)
	if !slices.Contains(r.conn.hello.GetCapabilities(), linkStreamPasteCapability) {
		t.Fatal("a managed runner did not declare paste")
	}
	var mu sync.Mutex
	var got []string
	r.m.work.streams.paste = func(_ context.Context, text string) error {
		mu.Lock()
		defer mu.Unlock()
		got = append(got, text)
		if text == "fail" {
			return errBrowserPasteNoField
		}
		return nil
	}
	r.open(streamOne, linkpb.StreamKind_STREAM_KIND_VNC)
	vnc.accepted(t)
	r.next(t) // StreamOpened
	paste := func(id uint32, text string) {
		r.conn.send(&linkpb.Frame{Body: &linkpb.Frame_StreamPaste{StreamPaste: &linkpb.StreamPaste{StreamId: streamOne, PasteId: id, Text: text}}})
	}
	paste(1, pasteSample)
	if a := r.next(t).GetStreamPasted(); a.GetStreamId() != streamOne || a.GetPasteId() != 1 || a.GetError() != "" {
		t.Fatalf("StreamPasted %v", a)
	}
	paste(2, "fail")
	if a := r.next(t).GetStreamPasted(); a.GetPasteId() != 2 || a.GetError() != errBrowserPasteNoField.Error() {
		t.Fatalf("StreamPasted %v", a)
	}
	// A paste for a stream that is not open is dropped.
	r.conn.send(&linkpb.Frame{Body: &linkpb.Frame_StreamPaste{StreamPaste: &linkpb.StreamPaste{StreamId: streamTwo, PasteId: 3, Text: "x"}}})
	r.quiet(t, 200*time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 2 || got[0] != pasteSample {
		t.Fatalf("pasted %q", got)
	}
}
