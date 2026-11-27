// Presses the lab provider's Sign in button (authorize.html) in the remote Chrome through its DevTools, from inside the
// runner container: the xdg-open part of scenarios/browser_cli_sign_in.sh, where no owner is asked.
//   node click-sign-in.mjs "Lab OAuth: sign in"
const title = process.argv[2];
const pages = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = pages.find((t) => t.type === 'page' && t.title === title);
if (!page) {
  console.log('no provider page');
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve));
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.getElementById("go").click()' } }));
await new Promise((resolve) => ws.addEventListener('message', resolve));
ws.close();
console.log('clicked');
