#!/usr/bin/env bash
set -Eeuo pipefail

output="dist/pages"
while (($#)); do
  case "$1" in
    --output)
      [[ $# -ge 2 ]] || { echo "--output needs a directory" >&2; exit 2; }
      output="$2"
      shift 2
      ;;
    *)
      echo "usage: $0 [--output DIR]" >&2
      exit 2
      ;;
  esac
done

diagnostics="${PAGES_DIAGNOSTICS_FILE:-dist/pages-build-diagnostics.txt}"
on_error() {
  local code=$?
  local line=${BASH_LINENO[0]:-unknown}
  local command=${BASH_COMMAND:-unknown}
  mkdir -p "$(dirname "$diagnostics")"
  {
    echo "GitHub Pages build failed"
    echo "exit_code=$code"
    echo "line=$line"
    echo "command=$command"
  } > "$diagnostics"
  echo "::error title=GitHub Pages build failed::line $line: $command (exit $code)" >&2
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "### GitHub Pages build failed"
      echo
      echo "- Exit code: `$code`"
      echo "- Script line: `$line`"
      echo "- Command: `$command`"
      echo "- Diagnostics artifact: `$diagnostics`"
    } >> "$GITHUB_STEP_SUMMARY"
  fi
  exit "$code"
}
trap on_error ERR

rm -rf "$output"
mkdir -p "$output"
cp -R site/. "$output/"
# GitHub Pages must serve the copied static tree as-is. Keep this empty file even though
# `test -s` is false: its presence disables Jekyll processing deterministically.
: > "$output/.nojekyll"

required_files=(
  "$output/index.html"
  "$output/404.html"
  "$output/assets/site.css"
  "$output/assets/brand/logo.svg"
  "$output/assets/brand/favicon.svg"
  "$output/assets/social/og-image.svg"
  "$output/assets/product/hero-preview.svg"
  "$output/assets/README.md"
  "$output/.nojekyll"
)
for file in "${required_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "missing required Pages artifact: $file" >&2
    exit 1
  fi
done

node scripts/check-pages-links.mjs "$output"

{
  echo "# GitHub Pages build"
  echo
  echo "- source: site/"
  echo "- source_sha: $(git rev-parse HEAD)"
  echo "- output: $output"
  echo "- deployment_branch: gh-pages"
  echo "- preservation: peaceiris/actions-gh-pages keep_files=true (appcast.xml)"
  echo "- local_link_check: passed (appcast.xml is preserved by the release workflow)"
} > "$output/build-report.md"

echo "GitHub Pages build complete: $output"
echo "source_sha=$(git rev-parse HEAD)"
echo "files=$(find "$output" -type f | wc -l | tr -d ' ')"
