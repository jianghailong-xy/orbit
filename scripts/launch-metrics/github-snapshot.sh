#!/usr/bin/env bash
# Save one JSON snapshot of the GitHub signals the launch review reads (docs/launch-tracking.md).
#
# GitHub keeps traffic (views, clones, referrers, popular paths) for 14 days only and release
# download counts are running totals, so this must run at least daily for the whole review window.
# Stars, forks, issues and discussions keep their timestamps and are read back at review time.
#
# Usage: scripts/launch-metrics/github-snapshot.sh [OUT_DIR]
#   OUT_DIR defaults to $ORBIT_LAUNCH_METRICS_DIR, then /var/lib/orbit-launch-metrics.
#   Needs `gh` authenticated with push access to the repository (the traffic API requires it).
set -euo pipefail

repo="${ORBIT_GITHUB_REPO:-jianghailong-xy/orbit}"
out_dir="${1:-${ORBIT_LAUNCH_METRICS_DIR:-/var/lib/orbit-launch-metrics}}/github"
mkdir -p "$out_dir"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

gh api "repos/$repo" \
  --jq '{stars: .stargazers_count, forks: .forks_count, watchers: .subscribers_count, open_issues_and_prs: .open_issues_count}' \
  > "$tmp/repo.json"
gh api "repos/$repo/traffic/views" > "$tmp/views.json"
gh api "repos/$repo/traffic/clones" > "$tmp/clones.json"
gh api "repos/$repo/traffic/popular/referrers" > "$tmp/referrers.json"
gh api "repos/$repo/traffic/popular/paths" > "$tmp/paths.json"
gh api --paginate "repos/$repo/releases?per_page=100" \
  --jq '.[] | {tag: .tag_name, prerelease, published_at, downloads: ([.assets[].download_count] | add // 0)}' \
  | jq -s '{total: (map(.downloads) | add // 0), by_tag: map(select(.downloads > 0))}' > "$tmp/releases.json"

taken_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -n --arg taken_at "$taken_at" --arg repo "$repo" \
  --slurpfile repo_stats "$tmp/repo.json" \
  --slurpfile views "$tmp/views.json" \
  --slurpfile clones "$tmp/clones.json" \
  --slurpfile referrers "$tmp/referrers.json" \
  --slurpfile paths "$tmp/paths.json" \
  --slurpfile releases "$tmp/releases.json" \
  '{taken_at: $taken_at, repo: $repo, repo_stats: $repo_stats[0],
    traffic: {views: $views[0], clones: $clones[0], referrers: $referrers[0], paths: $paths[0]},
    release_downloads: $releases[0]}' > "$tmp/snapshot.json"

target="$out_dir/$(date -u +%Y-%m-%dT%H%M%SZ).json"
mv "$tmp/snapshot.json" "$target"
echo "$target"
