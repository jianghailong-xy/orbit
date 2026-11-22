# Orbit Cloud browser (src/runner-go/browser_opener.go). The runner gives an engine, with the browser switch on, a page
# opener as BROWSER and its xdg-open first on PATH. A login shell's /etc/profile resets PATH: put that directory back in
# front, so `xdg-open https://...` still opens the page in the runner's shared Chrome. Without the opener as BROWSER
# (the switch off), this does nothing.
case "${BROWSER:-}" in
*/browser-opener/orbit-browser)
  case ":$PATH:" in
  *":${BROWSER%/orbit-browser}:"*) ;;
  *) PATH="${BROWSER%/orbit-browser}:$PATH"; export PATH ;;
  esac
  ;;
esac
