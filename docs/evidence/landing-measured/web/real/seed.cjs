// Seeds the stack through Orbit's own code: the owner through the real HTTP bootstrap, the rest through the real
// services of this worktree's build (as the P-M2 pg spec does), then the coordinator's writes through the real HTTP
// API with the coordinator session's header. Prints the ids the capture needs as one JSON line.
const { randomUUID } = require('node:crypto');
const WT = process.env.WT;
const D = `${WT}/src/apiserver/dist`;
const { prismaClientFor } = require(`${D}/prisma/prisma-client.js`);
const { SessionsService } = require(`${D}/sessions/sessions.service.js`);
const { TasksService } = require(`${D}/tasks/tasks.service.js`);
const { ProjectsService } = require(`${D}/projects/projects.service.js`);
const { ProjectAcceptanceService } = require(`${D}/projects/project-acceptance.service.js`);
const { ProjectOpenItemService } = require(`${D}/projects/project-open-item.service.js`);
const { RunnerProjectsController } = require(`${D}/runner-api/runner-projects.controller.js`);
const API = `http://127.0.0.1:${process.env.API_PORT}/api`;
const json = { 'content-type': 'application/json' };

(async () => {
  const boot = await fetch(`${API}/auth/bootstrap`, { method: 'POST', headers: json, body: JSON.stringify({ email: process.env.OWNER_EMAIL, name: 'Owner', password: process.env.OWNER_PASSWORD }) });
  if (!boot.ok) throw new Error(`bootstrap ${boot.status} ${await boot.text()}`);
  const tokens = await boot.json();
  const db = prismaClientFor(process.env.DATABASE_URL);
  const ownerId = (await db.user.findFirstOrThrow({ where: { email: process.env.OWNER_EMAIL } })).id;
  const realtime = new Proxy({}, { get: () => () => undefined });
  const queue = { notifySessionQueued: () => undefined };
  const push = new Proxy({}, { get: () => () => Promise.resolve() });
  const sessions = new SessionsService(db, queue, realtime);
  const acceptance = new ProjectAcceptanceService(db, sessions);
  const projects = new ProjectsService(db, acceptance, sessions);
  const openItems = new ProjectOpenItemService(db, sessions, push);
  const tasks = new TasksService(db, sessions, realtime, undefined, undefined, undefined, openItems);
  const door = new RunnerProjectsController(projects, acceptance, {}, { assert: async () => { throw new Error('no credential'); } }, openItems);

  const runnerId = randomUUID();
  await db.runner.create({ data: { id: runnerId, ownerId, name: 'lm-runner', tokenHash: `hash-${runnerId}`, status: 'ONLINE', capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date() } });
  const repoUrl = 'https://git.invalid/orbit/staging.git';
  const make = async (title, { started }) => {
    const wsId = randomUUID(); const workWs = randomUUID(); const sessionId = randomUUID(); const projectId = randomUUID();
    // The coordination workspace HAS a repository.
    await db.workspace.create({ data: { id: wsId, ownerId, runnerId, name: `${title} coordination`, enabled: true, repoUrl } });
    await db.workspace.create({ data: { id: workWs, ownerId, runnerId, name: `${title} work`, enabled: true, repoUrl, workDir: `/srv/${projectId}` } });
    await db.session.create({ data: { id: sessionId, ownerId, creatorId: ownerId, workspaceId: wsId, assignedRunnerId: runnerId, title, prompt: title, provider: 'claude', status: 'AWAITING_INPUT', dispatchOrigin: 'USER', titleManagedByProject: true, numTurns: 1, startedAt: new Date(), runtimeSessionId: `rt-${sessionId}` } });
    await db.conversationTurn.create({ data: { sessionId, seq: 1, clientTurnId: SessionsService.initialTurnClientId(sessionId), kind: 'message', content: title, status: 'ANSWERED' } });
    await db.project.create({ data: { id: projectId, ownerId, title, coordinatorWorkspaceId: wsId, coordinatorSessionId: sessionId } });
    await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
    await projects.update(ownerId, projectId, { acceptanceCriteriaItems: [{ text: 'Staging DB password is rotated and every service reads the new one.', verificationMethod: 'VERIFICATION' }] });
    const [{ id: criterionId }] = await db.$queryRawUnsafe(`SELECT "id" FROM "project_acceptance_criterion_definition" WHERE "project_id" = '${projectId}'::uuid`);
    const task = async (t, status) => (await db.task.create({ data: { ownerId, creatorType: 'USER', creatorId: ownerId, title: t, projectId, assigneeId: workWs, completionCriterion: 'OWNER_CONFIRMED', status, autoRunWhenReady: true, criterionDefinitionId: criterionId, criterionRevision: 1 }, select: { id: true } })).id;
    return { wsId, workWs, sessionId, projectId, task };
  };
  const runner = { id: runnerId, ownerId };

  // A: a request with NO line, in a workspace that has a repository. Left for the browser to start.
  const A = await make('Rotate staging credentials', {});
  await A.task('Rotate the staging database password', 'OPEN');
  await A.task('Delete unused staging buckets', 'OPEN');
  await door.requestStart(runner, A.sessionId, A.projectId, { maxConcurrentTasks: 3, why: 'None of the tasks commits code yet, so there is no line to choose.' });

  // B: started on a project branch, with a merge check, so the coordinator's cardless writes are possible.
  const B = await make('Move cron jobs', {});
  const exemptTask = await B.task('Move cron jobs off the old VM', 'OPEN');
  await B.task('Delete unused staging buckets', 'OPEN');
  const filed = await door.requestStart(runner, B.sessionId, B.projectId, { line: 'PROJECT_BRANCH', maxConcurrentTasks: 3, mergeCheckCommand: 'npm test', why: 'The tasks build on one another.' });
  const [req] = await db.$queryRawUnsafe(`SELECT "id" FROM "project_open_item" WHERE "project_id" = '${B.projectId}'::uuid AND "kind" = 'START_REQUEST' AND "state" = 'OPEN'`);
  const digest = (await acceptance.standardSetConfirmation(ownerId, B.projectId)).currentVersion.digest;
  await acceptance.startProject(ownerId, B.projectId, { criteriaDigest: digest, automatic: true, maxConcurrentTasks: 3, mergeCheckCommand: 'npm test', line: 'PROJECT_BRANCH', requestId: req.id });

  // The coordinator's own cardless writes, through the real services' door for a session (the runner door's
  // body: `projects.update` / `tasks.update` with the coordinator session id), each with its reason.
  await projects.update(ownerId, B.projectId, { integration: { landingCheckCommand: 'npm run check:landing', landingCheckReason: 'The suite needs its own command to stay fast.' } }, B.sessionId);
  await tasks.update(ownerId, exemptTask, { landingCheckExempt: true, landingCheckExemptReason: 'Only moves cron entries; the landing check needs a database this task cannot reach.' }, B.sessionId);
  await projects.update(ownerId, B.projectId, { integration: { landingCheck: 'NONE', landingCheckReason: 'This project only changes infrastructure; the command has nothing to build.' } }, B.sessionId);

  console.log(JSON.stringify({ tokens, A: { projectId: A.projectId, sessionId: A.sessionId }, B: { projectId: B.projectId, sessionId: B.sessionId, exemptTask } }));
  await db.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
