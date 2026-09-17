#!/usr/bin/env bash
#
# nav-push-gate.sh — one push mechanism per stack, and the model does not know its shell.
#
# The native clients (macOS + iOS, sharing src/macos/OrbitApp) used to carry three ways onto a
# navigation stack — `List(selection:)` implicit push, `navigationDestination(isPresented:)`
# boolean push, `NavigationLink` value push — stacked on the *same* stack in the compact shell.
# That is what stranded a highlighted session row you could not open: SwiftUI's stack held one
# truth and AppModel's flat `String?` held another, and nothing arbitrated between them. The
# refactor collapsed every push onto the stack itself (`NavState` / `NavNode` in OrbitKit, with
# AppModel's selection properties now readings of it); this gate keeps a second mechanism from
# coming back.
#
# It is a plain text scan on purpose — it runs on ubuntu-latest (see client.yml), so a PR that
# only touches a View is still held to the rule where no Swift toolchain is available.
#
# Usage: bash scripts/ci/nav-push-gate.sh     # exit 0 = clean, 1 = violation, 2 = bad checkout
#
# Each rule below prints *why* it is blocked and what to write instead — that text is the point
# of this script, so read it before deleting a hit.

set -uo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd) || exit 2
cd -- "$repo_root" || exit 2

# The SwiftUI layers this gate scans: the shared OrbitApp sources (both shells render these) and
# the thin iOS shell, which is where T0 spelled its stopgap flag. OrbitKit is out of scope — it
# is the UI-free value layer and holds no SwiftUI view.
sources=(src/macos/OrbitApp/Sources/OrbitApp src/ios/Sources)

for dir in "${sources[@]}"; do
  if [ ! -d "$dir" ]; then
    echo "nav-push-gate: $dir is missing from $repo_root — is this a full checkout?" >&2
    exit 2
  fi
done

violations=0

# ---------------------------------------------------------------------------
# Rule 1 — no boolean pushes.
# ---------------------------------------------------------------------------
boolean_pushes=$(grep -rn "navigationDestination(isPresented:" "${sources[@]}" \
                   --include='*.swift' || true)
if [ -n "$boolean_pushes" ]; then
  cat <<EOF
✗ navigationDestination(isPresented:) — the boolean push is back.

  Why this is blocked: on iOS a \`List(selection:)\` only answers a click inside a
  NavigationSplitView sidebar/content — a plain NavigationStack list does not — so the compact
  shell pushes rows itself, with one \`navigationDestination(for:)\` per stack, and the stack
  itself is the only copy of what is on screen. An \`isPresented\` boolean is a second copy of that,
  kept outside the stack: with two of them on one stack the page landed with a nil selection after
  enough push/pop churn, and a selected row could be drawn highlighted while the tap went nowhere.

  Write instead: push a NavNode through the section's own stack — AppModel's \`push(_:)\` /
  \`nav.replaceTop(...)\` (the section projections), reached via \`route(to:)\` or one of the named
  entry points (\`openSession\`, \`composeWithAgent\`, \`openWatch\`, …). A list row that carries its
  own destination is a \`Button\` calling \`AppModel.push(_:)\`, with one
  \`navigationDestination(for: NavNode.self)\` per stack: \`NavigationLink(value:)\` pushes the same
  frame but also draws the platform's disclosure indicator, which iOS 17/18 gives no usable way to
  hide. (Settings' form keeps its \`NavigationLink(value:)\` on purpose — a form row beside a
  hand-drawn chevron, not one of the compact list rows.)

  Hits:
$(printf '%s\n' "$boolean_pushes" | sed 's/^/    /')
EOF
  violations=$((violations + 1))
else
  echo "✓ no \`navigationDestination(isPresented:)\` — pushes go onto the stack, not beside it"
fi

# ---------------------------------------------------------------------------
# Rule 2 — `List(selection:)` binds a projection of the section's stack, never an AppModel
# property that stores the selection itself.
# ---------------------------------------------------------------------------

# Print the declaration of \`var <name>\` in the SwiftUI layer, from its header line through the
# line that closes its brace. A stack projection reads \`nav.\` in that body; a stored property
# cannot. Searched by name across the layer rather than in AppModel.swift alone so a projection
# declared in an extension still reads as one.
declaration_of() {
  local name=$1 decl file line
  decl=$(grep -rnE "^[[:space:]]*(@[A-Za-z]+[[:space:]]+)*(private|fileprivate|internal|public|static|nonisolated|lazy)*[[:space:]]*var[[:space:]]+${name}\b" \
           "${sources[@]}" --include='*.swift' | head -n 1 || true)
  [ -n "$decl" ] || return 0
  file=${decl%%:*}
  line=$(printf '%s' "${decl#*:}" | cut -d: -f1)
  awk -v start="$line" '
    NR < start { next }
    { depth += gsub(/\{/, "{"); depth -= gsub(/\}/, "}"); print }
    NR > start && depth <= 0 { exit }
    NR == start && depth <= 0 { exit }
  ' "$file"
}

# Call sites only — a doc comment that names \`List(selection:)\` (several do, explaining this very
# rule) is not a binding.
selection_sites=$(grep -rn "List(selection:" "${sources[@]}" --include='*.swift' \
                    | grep -vE ':[0-9]+:[[:space:]]*//' || true)
selection_hits=""
while IFS= read -r site; do
  [ -n "$site" ] || continue
  names=$(printf '%s\n' "$site" \
            | grep -oE '\$(model|app)\.[A-Za-z_][A-Za-z0-9_]*' \
            | sed -E 's/^\$(model|app)\.//' | sort -u || true)
  for name in $names; do
    body=$(declaration_of "$name")
    printf '%s' "$body" | grep -q 'nav\.' && continue
    if [ -n "$body" ]; then
      selection_hits="$selection_hits$(printf '%s' "$site" | sed 's/^/    /')"$'\n'
      selection_hits="$selection_hits      └ \$$name is stored, not a projection — see AppModel.swift"$'\n'
    else
      selection_hits="$selection_hits$(printf '%s' "$site" | sed 's/^/    /')"$'\n'
      selection_hits="$selection_hits      └ no \`var $name\` reading \`nav.\` found in this layer"$'\n'
    fi
  done
done <<< "$selection_sites"

if [ -n "$selection_hits" ]; then
  cat <<EOF
✗ \`List(selection:)\` is bound to something that stores the selection itself.

  Why this is blocked: \`nav\` is the ONE copy of the navigation state (see the \`var nav = NavState()\`
  comment in AppModel.swift). A stored \`String?\` beside it is a second copy that can disagree with
  what the stack is showing — the highlighted row that opens nothing. That is the whole reason this
  refactor exists; a stored selection reintroduces it.

  Write instead: bind the section's own stack, as a projection — a computed property on AppModel
  whose getter reads \`nav\` and whose setter moves the stack (\`replaceTop\` / \`pop\` / \`push\`), the
  shape of \`selectedWatchID\` / \`selectedRunnerID\` / \`selectedUserID\` / \`selectedTaskID\` in
  AppModel.swift. The three-column shells bind \`List(selection:)\` to it; the compact shell ignores
  it and lets the rows carry their own destinations.

  Hits:
$selection_hits
EOF
  violations=$((violations + 1))
else
  echo "✓ every \`List(selection:)\` binds a projection of the section's stack"
fi

# ---------------------------------------------------------------------------
# Rule 3 — the model does not know which shell it is drawn in.
# ---------------------------------------------------------------------------

# T0's stopgap flag, as a family: an identifier that tells the *model* about its shell. Written as
# a pattern rather than the literal name so this script is not itself a hit of the repo-wide grep
# the refactor's acceptance runs.
shell_flags=$(grep -rnE '\b(uses|knows|needs|has)[A-Z][A-Za-z]*Shell\b|\b(is|in)[A-Z][A-Za-z]*Shell\b|\b[A-Za-z]*Shell(Flag|Mode|Specific|Aware|Dependent)\b' \
                "${sources[@]}" --include='*.swift' || true)
if [ -n "$shell_flags" ]; then
  cat <<EOF
✗ a shell flag on the model — AppModel is being told which shell it lives in.

  Why this is blocked: the model is shape-blind. Compact-vs-three-column is a *projection* the view
  decides (\`SessionListPresentation.resolve(isCompactWidth:)\`) and passes in as a parameter
  (\`rowNavigation: SessionRowNavigation\`), not a fact the model keeps. T0 added such a flag as a
  stopgap, and every question it answered is a read of the stack now: "is the section at its root"
  is \`path.isEmpty\`, "which console is open" is \`path.last\`. A flag beside the stack is a second
  notion of where the app is, and it drifts.

  Write instead: read the stack (\`nav\` / \`NavState\`'s derived facts, e.g. \`sectionAtRoot\`,
  \`focusedConsoleSessionID\`), or let the view make the shape decision and pass it down.

  Hits:
$(printf '%s\n' "$shell_flags" | sed 's/^/    /')
EOF
  violations=$((violations + 1))
else
  echo "✓ no shell-awareness flag on the model — the view decides the shape"
fi

if [ "$violations" -ne 0 ]; then
  echo
  echo "nav-push-gate: $violations rule(s) violated. See the explanations above."
  exit 1
fi

echo "nav-push-gate: OK — one push mechanism per stack, in ${sources[*]}"
