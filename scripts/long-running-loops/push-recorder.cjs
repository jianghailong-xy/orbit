// Preloaded into the drill's apiserver with NODE_OPTIONS=--require (stack.sh); not part of the built tree.
//
// Records every call of the real PushService.prototype.notifyLoopMissed in this process, then calls the original.
// The worker's own log line ("its owner is told") is printed before `this.push?.notifyLoopMissed(...)` and so says
// nothing about whether a PushService was injected; and an isolated stack configures neither APNs nor FCM, so the
// method returns at its first line (`if (!this.enabled) return`). A line in ORBIT_PUSH_RECORD_FILE is a call that
// reached the method on the instance Nest's dependency injection gave the worker, with its arguments as passed.
//
// The class is wrapped when the compiled module (dist/push/push.service.js) is first loaded, before Nest builds a
// provider of it; nothing else in the process is touched. Each line: when, this pid, the arguments, which class the
// receiver is an instance of, what the receiver's `enabled` read (the early return's condition), and when the
// original's promise settled, with what.
'use strict';
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const FILE = process.env.ORBIT_PUSH_RECORD_FILE;
const TARGET = `${path.sep}dist${path.sep}push${path.sep}push.service.js`;

function record(entry) {
  try {
    fs.appendFileSync(FILE, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    process.stderr.write(`push-recorder: could not append to ${FILE}: ${error && error.message}\n`);
  }
}

// What the receiver reads as, without the reading ever being what throws.
function readSafely(read) {
  try {
    const value = read();
    return value === undefined ? null : value;
  } catch (error) {
    return `unreadable: ${error && error.message}`;
  }
}

if (FILE) {
  const load = Module._load;
  let wrapped = false;
  Module._load = function lrlPushRecorderLoad(request, parent, isMain) {
    const exported = load.apply(this, arguments);
    if (wrapped || !exported || typeof exported.PushService !== 'function') return exported;
    let filename;
    try {
      filename = Module._resolveFilename(request, parent, isMain);
    } catch {
      return exported;
    }
    if (!filename.endsWith(TARGET)) return exported;
    const PushService = exported.PushService;
    const original = PushService.prototype.notifyLoopMissed;
    if (typeof original !== 'function') return exported;
    wrapped = true;
    let calls = 0;
    PushService.prototype.notifyLoopMissed = function recordedNotifyLoopMissed(...args) {
      const call = ++calls;
      const at = new Date().toISOString();
      const receiver = {
        instanceOfPushService: this instanceof PushService,
        constructor: this && this.constructor ? this.constructor.name : null,
        enabled: readSafely(() => this.enabled),
        apnsEnabled: readSafely(() => this.apnsEnabled),
        fcmEnabled: readSafely(() => this.fcm.enabled),
      };
      let result;
      try {
        result = original.apply(this, args);
      } catch (error) {
        record({ at, pid: process.pid, call, method: 'PushService.prototype.notifyLoopMissed', args, receiver, threw: String(error) });
        throw error;
      }
      Promise.resolve(result).then(
        (value) => record({ at, pid: process.pid, call, method: 'PushService.prototype.notifyLoopMissed', args, receiver,
          settledAt: new Date().toISOString(), resolved: value === undefined ? null : value }),
        (error) => record({ at, pid: process.pid, call, method: 'PushService.prototype.notifyLoopMissed', args, receiver,
          settledAt: new Date().toISOString(), rejected: String(error) }),
      );
      return result;
    };
    record({ at: new Date().toISOString(), pid: process.pid, event: 'wrapped', module: filename });
    return exported;
  };
}
