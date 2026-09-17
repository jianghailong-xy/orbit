#!/usr/bin/env bash
# The node_modules a git worktree does not have, laid out so that `@orbit/shared` and
# `@prisma/client` are THIS tree's and not the main checkout's. Run it once in a bare checkout and
# then build or test normally:
#
#   bash scripts/worktree-overlay.sh
#   cd src/apiserver && rm -rf build && npm test
#   cd src/web && npx vitest run
#
# It needs no container and no network, it is idempotent (a second run re-links what moved, skips
# the ~75MB copy and the generate, and costs a `tsc -p src/shared`), everything it writes is under
# `node_modules/` or `dist/` and therefore gitignored, and it writes NOTHING outside the tree it is
# run from. Leave what it lays down in place: an EXECUTABLE acceptance command runs in this same
# worktree after the session's turn, and deleting the overlay is how that goes red.
#
# THE RED IT EXISTS TO PREVENT
# ============================
# A worktree borrows the main checkout's node_modules, so `@orbit/shared` resolves over there.
# Its package.json points `exports.types` at the source and `exports.default` at `dist/index.js`
# (1a97b39e, deliberate — see src/apiserver/src/common/shared-package-resolution.spec.ts), so the
# compiler reads the source and is happy while the child process reads the MAIN checkout's `dist/`
# — a gitignored artifact nobody rebuilds, five days behind its own source on 2026-09-16 with the
# `codexRateLimitReset`, `planUsage`, `watch` and `realtime` modules missing outright. That does
# not surface as an assertion failure. It blows up on require:
#
#   build/runners/codex-reset-metrics.js:29
#     dispatchReason: [...Object.keys(NONE_REASONS), ...shared_1.CODEX_RATE_LIMIT_RESET_ENUMS.failureCode],
#   TypeError: Cannot read properties of undefined (reading 'failureCode')
#
# one whole-file `not ok` per spec that imports it, dozens in a row, with a green
# `tsc -p tsconfig.test.json` in front of them — which is exactly what makes it read as a code red.
# The one-line question that tells them apart:
#
#   (cd src/apiserver && node -e "console.log(require.resolve('@orbit/shared'))")
#
# An answer under /root/orbit is this; an answer inside your own tree is not. The last thing this
# script does is ask it and refuse when the answer is not in this tree.
#
# WHY NOT JUST REBUILD THE MAIN CHECKOUT'S dist
# =============================================
# `cd /root/orbit/src/shared && npm run build` fixes it for about as long as it takes the next
# session to need something else. Roughly 150 worktrees on this host read that one directory, each
# on a different commit; a build there publishes one branch's shared to all of them, and two
# sessions building it at once hand each other half-written `.js` files. The same argument covers
# `@prisma/client`: `prisma generate` in the main checkout rewrites the client every concurrent
# session is compiling against. So this script gives the tree its own of both and leaves
# /root/orbit alone — reading it is free, writing it is not ours to do.
#
# WHAT IT LAYS DOWN, AND WHY EACH PIECE IS THERE
# ==============================================
#   * node_modules, borrowed. A worktree has none, and `npm install` inside one tears the links
#     back down. The root, the apiserver's and src/shared's are linked from the main checkout.
#   * `src/node_modules/@orbit/shared` -> this tree's src/shared, with this tree's dist built. That
#     link sits closer to `src/apiserver/build/**` than the borrowed root does, so it is the one
#     node finds, and the dist beside it is the one the child process reads. This is the pair that
#     answers the red above; neither half works alone.
#   * `src/apiserver/node_modules` as a real directory, one symlink per package, because two
#     entries under it have to be ours. `@prisma/client` is COPIED and `.prisma` generated from
#     this branch's schema: node resolves a linked package by its realpath and would read the main
#     checkout's client straight back, which on a branch that adds a model compiles into
#     `Property 'x' does not exist on type 'PrismaService'` — the same class of harness red as the
#     shared dist, so it gets the same answer.
#   * `src/web/node_modules` likewise a real directory, for `@orbit/shared` and for the two vite
#     caches. Borrowed whole it is the same red wearing a different face: the main checkout's copy
#     has no `@orbit/shared` at all, so vitest falls back through it to the root's, and the stale
#     dist arrives during COLLECTION — `TypeError: Cannot read properties of undefined (reading
#     'maxTargetsPerWatch')` out of `WATCH_LIMITS`, one whole-file `(0 test)` rather than a failing
#     assertion. Two entries have to be ours and the rest are linked: `@orbit/shared` -> this tree's
#     src/shared, and `.vite`/`.vite-temp`, which vite puts under the web package's node_modules and
#     which ~150 worktrees would otherwise share one of. `@types/react-dom` is why the link loop
#     copies EVERY entry rather than the ones that look interesting: it is installed only here, the
#     root's `@types` does not carry it, and `tsc -b` goes red without it.
#
# WHAT IT DOES NOT DO
# ===================
# It does not compile the test tree (`rm -rf build && npm test` is the caller's, and it is what
# the acceptance command usually is), it does not start a PostgreSQL, and in the main checkout it
# skips the overlay entirely — there is nothing there to overlay. Callers that need `tsc` or
# `prisma` afterwards resolve their own: this script prints which tsc it used, so a run that picks
# up the wrong one says so rather than compiling a whole tree with it in silence.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"

die() { echo "worktree-overlay: $*" >&2; exit 2; }

# --- the borrowed node_modules --------------------------------------------------------------------
# Refresh a symlink, create a missing one, never touch a real directory: in the main checkout every
# one of these already exists and the block is skipped. That guard is the block's, not a nicety —
# when MAIN falls back to REPO source and target are the same path, and on a tree that has no
# node_modules at all the target does not exist yet, so `ln -sfn` made `node_modules -> node_modules`.
# The run still stopped at the `no tsc` below, but a second one left anyone checking by hand reading
# `Too many levels of symbolic links` instead, which is a broken environment rather than a missing
# `npm install`, and three self-referential links in the caller's tree that this script had made.
link() { if [ -L "$2" ] || [ ! -e "$2" ]; then ln -sfn "$1" "$2"; fi; }
MAIN="$(dirname "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")"
[ -d "$MAIN/node_modules" ] || MAIN="$REPO"
if [ "$MAIN" != "$REPO" ]; then
  echo "==> overlaying node_modules from $MAIN"
  link "$MAIN/node_modules"                "$REPO/node_modules"
  link "$MAIN/src/apiserver/node_modules"  "$API/node_modules"
  link "$MAIN/src/shared/node_modules"     "$REPO/src/shared/node_modules"
fi

# TypeScript 7 and Prisma 7 were installed per workspace, beside a root that hoisted the 5.9.3 that
# @nestjs/cli pinned, until the 2026-09-09 bumps (#74, #78) moved both to the root; so prefer the
# apiserver's copy of each and fall back to the root's. Resolved HERE and not up with the other
# constants, because "prefer" is a question about the links above: a worktree that has none of them
# yet answers "not executable" to both preferred paths, and both fallbacks then lie. The root had no
# prisma at all, so a run died at `prisma migrate deploy` with a container already up; and the
# root's tsc WAS that 5.9.3, so the guard below passed and a first run compiled a whole test tree
# with the wrong compiler without saying so. Hence also the version echo: which compiler built this
# tree is the thing that failed silently, so it is printed rather than assumed.
TSC="$API/node_modules/.bin/tsc"; [ -x "$TSC" ] || TSC="$REPO/node_modules/.bin/tsc"
PRISMA="$API/node_modules/.bin/prisma"; [ -x "$PRISMA" ] || PRISMA="$REPO/node_modules/.bin/prisma"
[ -x "$TSC" ]    || die "no tsc under $MAIN — run npm install in the main checkout first"
[ -x "$PRISMA" ] || die "no prisma under $MAIN — run npm install in the main checkout first"
echo "==> tsc $TSC ($("$TSC" --version))"

# --- this branch's Prisma client ------------------------------------------------------------------
# See the header for why it cannot be the main checkout's. The whole-directory link above is undone
# for the apiserver and rebuilt as one symlink per package, so that the two entries which have to be
# ours can be real directories. Never in the main checkout: generating there is how every concurrent
# session's tree goes red.
if [ "$MAIN" != "$REPO" ]; then
  NM="$API/node_modules"; MAIN_NM="$MAIN/src/apiserver/node_modules"
  # Where the main checkout's install put the two packages this step pairs, asked of Node rather
  # than named: npm kept both under the apiserver workspace until the 2026-09-09 dependabot bumps
  # (#74, #78) hoisted them to the root, and `$MAIN_NM/@prisma/client` then named nothing at all.
  pkg_dir() { ( cd "$MAIN/src/apiserver" && node -p "path.dirname(require.resolve('$1/package.json'))" ); }
  CLIENT_PKG="$(pkg_dir @prisma/client)" || die "no @prisma/client under $MAIN — run npm install in the main checkout first"
  PRISMA_PKG="$(pkg_dir prisma)" || die "no prisma under $MAIN — run npm install in the main checkout first"
  [ -L "$NM" ] && rm -f "$NM"
  mkdir -p "$NM/@prisma" "$NM/.prisma"
  for d in "$MAIN_NM"/* "$MAIN_NM"/.[!.]*; do
    [ -e "$d" ] || continue
    case "$(basename "$d")" in @prisma|.prisma|prisma) continue ;; esac
    link "$d" "$NM/$(basename "$d")"
  done
  for d in "$MAIN_NM/@prisma"/*; do
    [ -e "$d" ] || continue
    [ "$(basename "$d")" = "client" ] || link "$d" "$NM/@prisma/$(basename "$d")"
  done
  # The CLI goes beside the copy below, wherever it was installed. `prisma generate` resolves
  # `prisma` and `@prisma/client` from the schema's directory without following links, and refuses
  # with `Could not resolve @prisma/client` unless both sit in the same node_modules — so a private
  # client here with the CLI only at the root fails exactly as a missing client does.
  link "$PRISMA_PKG" "$NM/prisma"
  # A copy, ~75MB, once per worktree: `prisma generate` finds the package by walking up from the
  # schema's directory, and through a link it would find — and write beside — the main checkout's.
  # It also has to be in place BEFORE generating, which otherwise fails with `Could not resolve
  # @prisma/client`. Copied again when the main checkout's package.json differs from the copy's, so
  # a dependency bump reaches a worktree that already has one; the generated client goes with it.
  if [ ! -d "$NM/@prisma/client" ] || [ -L "$NM/@prisma/client" ] ||
     ! cmp -s "$CLIENT_PKG/package.json" "$NM/@prisma/client/package.json"; then
    echo "==> copying @prisma/client out of $CLIENT_PKG (this worktree needs its own)"
    rm -rf "$NM/@prisma/client" "$NM/.prisma/client"
    cp -r "$CLIENT_PKG" "$NM/@prisma/client" || die "could not copy @prisma/client"
  fi
  # ~6s, so only when this branch's schema is newer than what was generated from it last time.
  GENERATED="$NM/.prisma/client/index.d.ts"
  if [ ! -f "$GENERATED" ] || [ "$API/prisma/schema.prisma" -nt "$GENERATED" ]; then
    echo "==> generating this branch's Prisma client"
    ( cd "$API" && "$PRISMA" generate >/dev/null ) || die "prisma generate failed"
    [ -f "$GENERATED" ] || die "prisma generate wrote no $GENERATED"
  fi
fi

# --- this tree's @orbit/shared --------------------------------------------------------------------
echo "==> building @orbit/shared"
"$TSC" -p "$REPO/src/shared/tsconfig.json" || die "src/shared failed to compile"
mkdir -p "$REPO/src/node_modules/@orbit"
link "$REPO/src/shared" "$REPO/src/node_modules/@orbit/shared"

# --- this tree's src/web node_modules -------------------------------------------------------------
# The apiserver's treatment one package along, and for the same reason: see the header. The borrowed
# directory is undone and rebuilt as one symlink per entry — every entry, `@types/react-dom` being
# installed only here — so that `@orbit/shared` and vite's two cache directories can be ours.
if [ "$MAIN" != "$REPO" ]; then
  WEB_NM="$REPO/src/web/node_modules"; MAIN_WEB_NM="$MAIN/src/web/node_modules"
  [ -L "$WEB_NM" ] && rm -f "$WEB_NM"
  mkdir -p "$WEB_NM/@orbit"
  for d in "$MAIN_WEB_NM"/* "$MAIN_WEB_NM"/.[!.]*; do
    [ -e "$d" ] || continue
    # `.vite` (the pre-bundled deps) and `.vite-temp` (the bundled vite.config) are caches keyed by
    # nothing that tells one tree's sources from another's, and not linking them is worth more than
    # the red: at load 61, ProjectsPage.test.tsx cost 165.7s filling this tree's own pair and 45.8s
    # reading it back — where against the main checkout's shared pair it costs 107-180s every time.
    case "$(basename "$d")" in .vite|.vite-temp|@orbit) continue ;; esac
    link "$d" "$WEB_NM/$(basename "$d")"
  done
  link "$REPO/src/shared" "$WEB_NM/@orbit/shared"
fi

# --- the self-check ---------------------------------------------------------------------------
# Asked of node, from the two directories the specs run in, because every piece above exists to move
# these answers. A print alone would be a line nobody reads in a log nobody opens on a green run, so
# it is a refusal too: an overlay that did not take is worth more as an exit 2 here than as fifty
# whole-file `not ok`s twenty minutes from now. It is asked twice because the two fail apart — the
# apiserver's answer comes through `src/node_modules` and the web's through `src/web/node_modules`,
# so either block can stop laying its half down while the other keeps answering correctly.
for sub in src/apiserver src/web; do
  RESOLVED="$(cd "$REPO/$sub" && node -e "console.log(require.resolve('@orbit/shared'))" 2>&1)" ||
    die "node cannot resolve @orbit/shared from $sub: $RESOLVED"
  echo "==> require.resolve('@orbit/shared') from $sub = $RESOLVED"
  case "$RESOLVED" in
    "$REPO"/*) ;;
    *) die "@orbit/shared still resolves outside this tree from $sub — the overlay did not take" ;;
  esac
done
echo "==> OK: $REPO is ready to build and test"
exit 0
