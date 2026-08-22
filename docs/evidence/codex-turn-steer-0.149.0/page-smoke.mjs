// Real browser smoke for Orbit's Codex mid-turn steer path. Chromium edits the rendered composer
// and clicks its actual Send button; CDP only drives the browser and retains the POST response.
// Auth/workspace variables are the same as api-smoke.mjs.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  assertDeliveryLifecycle,
  assertFinalAnswer,
  assertOneTurnContainsBothMessages,
  base,
  chooseWorkspace,
  conciseEvents,
  deadline,
  publicIdToUuid,
  readCodexThread,
  sleep,
  smokeApi,
  waitForSettled,
  waitForTool,
} from './smoke-lib.mjs';

const { api, token } = await smokeApi();
const workspaceId = await chooseWorkspace(api);
const marker = randomUUID().slice(0, 8);
const initialMarker = `PAGE_INITIAL_${marker}`;
const steerMarker = `PAGE_STEER_${marker}`;
const initialPrompt =
  `Remember ${initialMarker}. Use the shell tool to run sleep 20 and wait for it to finish. ` +
  'While it runs, a follow-up may arrive. After the tool finishes, obey the newest follow-up in ' +
  'this same turn. If none arrives, answer exactly PAGE_MISSED. Do not finish before the tool.';
const steerText = `Newest instruction ${steerMarker}: the final answer must be exactly PAGE_STEER_APPLIED_${marker}.`;
const expectedAnswer = `PAGE_STEER_APPLIED_${marker}`;

const created = await api('/sessions', {
  method: 'POST',
  body: JSON.stringify({
    title: `6R PAGE real steer ${marker}`,
    prompt: initialPrompt,
    workspaceId,
    provider: 'codex',
    permissionMode: 'dontAsk',
  }),
});
const sessionId = created.publicId || created.id;
const { event: toolEvent } = await waitForTool(api, sessionId);

const profile = mkdtempSync(join(tmpdir(), 'orbit-page-smoke-'));
const chromium = spawn(
  '/usr/bin/chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
const chromiumExited = new Promise((resolve) => chromium.once('exit', resolve));
let cdp;

try {
  let stderr = '';
  const browserWs = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`chromium CDP timeout: ${stderr.slice(-1000)}`)), 15_000);
    chromium.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    chromium.once('exit', (code) => reject(new Error(`chromium exited before CDP was ready (${code})`)));
  });
  const debugUrl = new URL(browserWs);
  const target = await (
    await fetch(`http://${debugUrl.hostname}:${debugUrl.port}/json/new?${encodeURIComponent(`${base}/`)}`, {
      method: 'PUT',
    })
  ).json();

  class CDP {
    constructor(url) {
      this.nextId = 0;
      this.pending = new Map();
      this.listeners = new Map();
      this.ready = new Promise((resolve, reject) => {
        this.ws = new WebSocket(url);
        this.ws.onopen = resolve;
        this.ws.onerror = reject;
        this.ws.onmessage = ({ data }) => {
          const message = JSON.parse(data);
          if (message.id !== undefined) {
            const waiter = this.pending.get(message.id);
            if (waiter) {
              this.pending.delete(message.id);
              if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
              else waiter.resolve(message.result);
            }
            return;
          }
          for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
        };
      });
    }
    async call(method, params = {}) {
      await this.ready;
      const id = ++this.nextId;
      const answer = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
      this.ws.send(JSON.stringify({ id, method, params }));
      return answer;
    }
    on(method, listener) {
      this.listeners.set(method, [...(this.listeners.get(method) || []), listener]);
    }
    close() {
      this.ws.close();
    }
  }

  cdp = new CDP(target.webSocketDebuggerUrl);
  await Promise.all([cdp.call('Page.enable'), cdp.call('Runtime.enable'), cdp.call('Network.enable')]);
  const evaluate = async (expression) => {
    const answer = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (answer.exceptionDetails) throw new Error(`page evaluation failed: ${JSON.stringify(answer.exceptionDetails)}`);
    return answer.result?.value;
  };
  const waitFor = async (expression, description, maxMs = 30_000) => {
    for (const until = deadline(maxMs); Date.now() < until; ) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(`page timeout waiting for ${description}`);
  };

  await waitFor("document.readyState === 'complete'", 'initial page load');
  await evaluate(`localStorage.setItem('orbit_token', ${JSON.stringify(token)}); true`);
  await cdp.call('Page.navigate', { url: `${base}/sessions/${encodeURIComponent(sessionId)}` });
  await waitFor("document.readyState === 'complete' && !!document.querySelector('textarea')", 'session composer');

  let turnRequest;
  let turnResponse;
  cdp.on('Network.requestWillBeSent', (params) => {
    if (params.request.method === 'POST' && params.request.url.endsWith(`/api/sessions/${sessionId}/turns`)) {
      turnRequest = { requestId: params.requestId, postData: params.request.postData };
    }
  });
  cdp.on('Network.responseReceived', (params) => {
    if (turnRequest && params.requestId === turnRequest.requestId) {
      turnResponse = { requestId: params.requestId, status: params.response.status };
    }
  });

  const composerBeforeClick = await evaluate(`(() => {
    const textarea = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(steerText)});
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(steerText)} }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    return textarea.value;
  })()`);
  assert(composerBeforeClick === steerText, 'the rendered composer did not contain the steer text');
  await waitFor("!!document.querySelector('button[aria-label=\"Send\"]:not([disabled])')", 'enabled Send button');
  const clicked = await evaluate(`(() => {
    const button = document.querySelector('button[aria-label="Send"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert(clicked, 'the rendered Send button was not clicked');

  for (const until = deadline(20_000); Date.now() < until && !turnResponse; ) await sleep(100);
  assert(turnRequest && turnResponse, 'the page did not issue and finish its turns POST');
  const responseBody = await cdp.call('Network.getResponseBody', { requestId: turnResponse.requestId });
  const pageSendResponse = JSON.parse(responseBody.body);
  assert(turnResponse.status === 201, `page turns POST status=${turnResponse.status}, want 201`);
  assert(pageSendResponse.kind === 'steer', `page turns POST kind=${pageSendResponse.kind}, want steer`);
  const steerTurnId = pageSendResponse.turnId;
  assert(steerTurnId, `page turns POST omitted turnId: ${JSON.stringify(pageSendResponse)}`);

  const { detail, events } = await waitForSettled(api, sessionId);
  assert(detail.status === 'AWAITING_INPUT', `session status=${detail.status}, want AWAITING_INPUT`);
  assert(detail.numTurns === 1, `session numTurns=${detail.numTurns}, want 1`);
  const delivery = assertDeliveryLifecycle(events, steerTurnId);
  const thread = await readCodexThread(detail.runtimeSessionId);
  const threadEvidence = assertOneTurnContainsBothMessages(
    thread,
    initialMarker,
    steerMarker,
    publicIdToUuid(steerTurnId),
  );
  assertFinalAnswer(thread, expectedAnswer);
  await waitFor(`document.body.innerText.includes(${JSON.stringify(expectedAnswer)})`, 'final answer in rendered transcript');
  const ui = await evaluate(`(() => ({
    finalAnswerPresent: document.body.innerText.includes(${JSON.stringify(expectedAnswer)}),
    composerValue: document.querySelector('textarea')?.value || ''
  }))()`);
  assert(ui.finalAnswerPresent, 'the final answer was not rendered in the page');
  assert(ui.composerValue === '', `composer was not cleared after Send: ${JSON.stringify(ui.composerValue)}`);

  console.log(
    'PAGE_SMOKE_PASS=' +
      JSON.stringify({
        sessionId,
        initialOrbitTurnId: toolEvent.turnId,
        steerOrbitTurnId: steerTurnId,
        networkStatus: turnResponse.status,
        networkKind: pageSendResponse.kind,
        clicked,
        runtimeThreadId: detail.runtimeSessionId,
        codexTurnId: threadEvidence.codexTurnId,
        steerItemId: threadEvidence.steerItemId,
        steerClientId: threadEvidence.steerClientId,
        userMessageItemsInTurn: threadEvidence.userMessageItems,
        delivery,
        numTurns: detail.numTurns,
        status: detail.status,
        finalAnswer: expectedAnswer,
        ui,
        events: conciseEvents(events, steerTurnId),
      }),
  );
} finally {
  cdp?.close();
  chromium.kill('SIGTERM');
  const exited = await Promise.race([chromiumExited.then(() => true), sleep(5_000).then(() => false)]);
  if (!exited) {
    chromium.kill('SIGKILL');
    await chromiumExited;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(profile, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 4) console.error(`warning: could not remove Chromium profile ${profile}: ${error.message}`);
      else await sleep(200);
    }
  }
}
