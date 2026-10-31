// Writes the probe's two criteria decision replies exactly as the apiserver builds them
// (criteriaDecisionReplyMessage), for the stub. Usage: node gen-messages.cjs <src/apiserver/build>
const path = require('node:path');
const build = process.argv[2];
const { criteriaDecisionReplyMessage } = require(path.join(build, 'projects/criteria-decision-reply.js'));
const { base62ToUuid } = require('node:module').createRequire(path.join(build, 'index.js'))('@orbit/shared');
const project = base62ToUuid('34nmPkyh9pd8tVm1fCv2Q');
const title = 'Runner link v1: runner ↔ control plane over WebSocket';
process.stdout.write(JSON.stringify({
  // Filed by a task's run (R1): the owner refused it.
  rejected: criteriaDecisionReplyMessage({
    decision: 'REJECT', intentId: base62ToUuid('34pX0YF3mJmoTBvNxc8Kt'), projectId: project, projectTitle: title,
    decidedAt: new Date('2026-10-31T11:30:00.000Z'), note: 'Keep criterion 2: the link test is what proves the switch.',
    clauses: ['criterion 2 stays at revision 1'], endedSessionId: null,
  }),
  // Filed by the project's coordinator (C2): the owner approved it.
  approved: criteriaDecisionReplyMessage({
    decision: 'APPROVE', intentId: base62ToUuid('34pX0YF3mJmoTBvNxc8Ku'), projectId: project, projectTitle: title,
    decidedAt: new Date('2026-10-31T11:20:00.000Z'), note: null,
    clauses: ['criterion 3 is now revision 2'], endedSessionId: null,
  }),
}, null, 1));
