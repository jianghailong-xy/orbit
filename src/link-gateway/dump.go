package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf8"

	"google.golang.org/protobuf/encoding/protodelim"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// dumpMain is `link-gateway dump`: frames in, one summary line (or protojson with -json) each out. Input is text,
// one frame per line as base64 or hex (the gateway logs an undecodable frame as raw=<base64>), or a binary
// capture of length-delimited frames (`link-gateway client -capture`). Pieces of a chunked frame are joined and
// the frame they make up is printed after them. It exits 1 if any frame did not decode.
func dumpMain(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("dump", flag.ContinueOnError)
	fs.SetOutput(stderr)
	asJSON := fs.Bool("json", false, "print each frame as protojson instead of a summary line")
	format := fs.String("format", "auto", "input format: auto, base64 or hex (one frame per line), or delimited (binary capture)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	in := stdin
	if fs.NArg() > 1 {
		fmt.Fprintln(stderr, "dump reads one file (or standard input)")
		return 2
	}
	if fs.NArg() == 1 && fs.Arg(0) != "-" {
		f, err := os.Open(fs.Arg(0))
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		defer f.Close()
		in = f
	}
	data, err := io.ReadAll(in)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if *format == "auto" && !(utf8.Valid(data) && !bytes.ContainsRune(data, 0)) {
		*format = "delimited"
	}
	d := &dumper{out: stdout, json: *asJSON}
	switch *format {
	case "auto", "base64", "hex":
		d.text(data, *format)
	case "delimited":
		d.delimited(data)
	default:
		fmt.Fprintf(stderr, "unknown -format %q\n", *format)
		return 2
	}
	if d.failed > 0 {
		fmt.Fprintf(stderr, "%d frame(s) did not decode\n", d.failed)
		return 1
	}
	return 0
}

type dumper struct {
	out    io.Writer
	json   bool
	chunks reassembler
	failed int
}

func (d *dumper) text(data []byte, format string) {
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if i := strings.Index(line, "raw="); i >= 0 {
			line = strings.Trim(strings.Fields(line[i+len("raw="):])[0], `"`)
		}
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		b, err := decodeFrameText(line, format)
		if err != nil {
			d.failed++
			fmt.Fprintf(d.out, "line %d: %v\n", n, err)
			continue
		}
		d.frame(b, fmt.Sprintf("line %d", n))
	}
}

// decodeFrameText reads one line as base64 or hex. With format auto it takes whichever reading decodes as a Frame,
// base64 first: a short hex string can be valid base64 too.
func decodeFrameText(s, format string) ([]byte, error) {
	var readings [][]byte
	if format != "hex" {
		for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
			if b, err := enc.DecodeString(s); err == nil {
				readings = append(readings, b)
				break
			}
		}
	}
	if format != "base64" {
		if b, err := hex.DecodeString(s); err == nil {
			readings = append(readings, b)
		}
	}
	if len(readings) == 0 {
		return nil, fmt.Errorf("not %s", map[string]string{"auto": "base64 or hex", "base64": "base64", "hex": "hex"}[format])
	}
	for _, b := range readings {
		if proto.Unmarshal(b, &linkpb.Frame{}) == nil {
			return b, nil
		}
	}
	return readings[0], nil
}

func (d *dumper) delimited(data []byte) {
	r := bufio.NewReader(bytes.NewReader(data))
	for n := 1; ; n++ {
		var f linkpb.Frame
		err := protodelim.UnmarshalFrom(r, &f)
		if errors.Is(err, io.EOF) {
			return
		}
		if err != nil {
			d.failed++
			fmt.Fprintf(d.out, "record %d: %v\n", n, err)
			return
		}
		d.print(&f, fmt.Sprintf("record %d", n))
	}
}

func (d *dumper) frame(b []byte, where string) {
	var f linkpb.Frame
	if err := proto.Unmarshal(b, &f); err != nil {
		d.failed++
		fmt.Fprintf(d.out, "%s: does not decode as a Frame: %v\n", where, err)
		return
	}
	d.print(&f, where)
}

func (d *dumper) print(f *linkpb.Frame, where string) {
	if d.json {
		b, _ := protojson.MarshalOptions{Multiline: true}.Marshal(f)
		fmt.Fprintf(d.out, "%s\n%s\n", where, b)
	} else {
		fmt.Fprintln(d.out, summarize(f))
	}
	if c := f.GetChunk(); c != nil {
		joined, err := d.chunks.add(c)
		if err != nil {
			d.failed++
			fmt.Fprintf(d.out, "%s: %v\n", where, err)
			return
		}
		if joined != nil {
			d.print(joined, where+" (joined)")
		}
	}
}
