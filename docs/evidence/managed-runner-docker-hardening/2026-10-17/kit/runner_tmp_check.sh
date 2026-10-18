#!/bin/sh
# D8 (task 34hXCWEWAgHqtrxZsMBOh): /tmp in a managed runner container, as the runner's own user, inside the D8 test
# host: its mount, a script, a program and a Go binary run from it, `go test` with the default temporary directory
# (in /tmp and on the data volume), and its size limit.
#   docker exec -i mr-<runner uuid> sh -s < runner_tmp_check.sh
echo "== /tmp at $(date -u +%FT%TZ) in $(hostname), as $(id -u):$(id -g)"
echo "-- mount: $(grep ' /tmp ' /proc/mounts)"
echo "-- environment: TMPDIR=${TMPDIR:-unset} GOTMPDIR=${GOTMPDIR:-unset}; go env GOTMPDIR='$(go env GOTMPDIR)' GOCACHE='$(go env GOCACHE)'"
echo "-- size: $(df -B1 /tmp | tail -n 1)"

printf '#!/bin/sh\necho "  a script ran from /tmp"\n' >/tmp/d8-script.sh && chmod +x /tmp/d8-script.sh
/tmp/d8-script.sh; echo "a script run from /tmp: exit=$?"
cp /bin/true /tmp/d8-true && /tmp/d8-true; echo "a program copied to /tmp: exit=$?"

mkdir -p /tmp/d8-go/hello
cat >/tmp/d8-go/go.mod <<'EOF'
module d8

go 1.27
EOF
cat >/tmp/d8-go/answer.go <<'EOF'
package d8

func Answer() int { return 42 }
EOF
cat >/tmp/d8-go/answer_test.go <<'EOF'
package d8

import "testing"

func TestAnswer(t *testing.T) {
	if Answer() != 42 {
		t.Fatal("not 42")
	}
}
EOF
cat >/tmp/d8-go/hello/main.go <<'EOF'
package main

import "fmt"

func main() { fmt.Println("  a Go binary ran from /tmp") }
EOF
cd /tmp/d8-go && go build -o /tmp/d8-hello ./hello && /tmp/d8-hello; echo "a Go binary built into /tmp: exit=$?"
cd /tmp/d8-go && go test -count=1 ./...; echo "go test, a module in /tmp, the default temporary directory: exit=$?"
rm -rf "$HOME/d8-go" && cp -r /tmp/d8-go "$HOME/d8-go"
cd "$HOME/d8-go" && go test -count=1 ./...; echo "go test, a module on the data volume ($HOME/d8-go), the default temporary directory: exit=$?"
cd "$HOME/d8-go" && go run ./hello; echo "go run, the default temporary directory: exit=$?"

echo "-- the size limit: writing 1100 MiB into /tmp"
dd if=/dev/zero of=/tmp/d8-fill bs=1M count=1100 2>"$HOME/d8-dd.txt"; echo "dd exit=$?: $(tr '\n' ' ' <"$HOME/d8-dd.txt")"
echo "written: $(stat -c %s /tmp/d8-fill) bytes; $(df -B1 /tmp | tail -n 1)"
rm -f "$HOME/d8-dd.txt"
rm -f /tmp/d8-fill
rm -rf /tmp/d8-script.sh /tmp/d8-true /tmp/d8-hello /tmp/d8-go "$HOME/d8-go"
echo "-- left in /tmp, none of them this check's: $(ls -A /tmp | tr '\n' ' ')"
