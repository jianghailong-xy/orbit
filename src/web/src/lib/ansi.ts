// Terminal programs (tsc, npm, git, …) colour their output with ANSI escape codes.
// The ESC byte is invisible in a <pre>, so those codes would otherwise leak into the
// transcript as literal "[41m"/"[0m" garbage. Strip them for display.
//
// The pattern only matches real ESC-prefixed CSI sequences, so a user's literal
// "arr[0]" or a typed "[41m" (no ESC) is left untouched.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.includes('\x1b') ? text.replace(ANSI_RE, '') : text;
}
