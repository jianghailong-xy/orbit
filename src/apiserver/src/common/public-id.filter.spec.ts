import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ArgumentsHost,
  Controller,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Module,
  NotFoundException,
  Patch,
  CanActivate,
  UseGuards,
} from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { of } from 'rxjs';
import { uuidToBase62 } from '@orbit/shared';
import { MachineProtocol } from './machine-protocol';
import { PublicIdExceptionFilter } from './public-id.filter';
import { PublicIdInterceptor } from './public-id.interceptor';

/**
 * The failure half of the id rule, which for a long time did not exist.
 *
 * `PublicIdInterceptor` maps the value a handler RETURNS. A refusal is thrown, not returned, so it
 * went out unmapped: the 409 that refuses `PATCH /projects/:id` named the acceptance run standing
 * in the way by its `project_acceptance_run` primary key — a raw UUID, in a body whose success
 * twin on the same route was base62 throughout. AC1 of unit 25E says every public id above the API
 * line is base62; this is the exit that did not know that.
 *
 * What is asserted here is the pair: the same allowlist, over the same boundary, on both exits.
 */

const UUID = '01a02427-6cb5-7ae0-ae3c-ffe57116c33e';
const B62 = uuidToBase62(UUID);
const RAW_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The refusal the defect was found on, verbatim in shape: a code the caller switches on, prose,
 *  and the id of the row that is in the way. */
const refusal = () =>
  new HttpException(
    {
      statusCode: 409,
      error: 'Conflict',
      code: 'ACCEPTANCE_MISSING',
      message: 'the latest project acceptance concluded FAIL, not PASS',
      owner: 'USER',
      requiredAction: 'fix what the acceptance found, then run a new acceptance',
      runId: UUID,
      verdict: 'FAIL',
    },
    409,
  );

/** What Nest's base filter talks to. Capturing `reply` is how the serialized body is read without
 *  a socket. */
function adapter() {
  const sent: { body: unknown; status: number }[] = [];
  return {
    sent,
    ref: {
      isHeadersSent: () => false,
      reply: (_res: unknown, body: unknown, status: number) => sent.push({ body, status }),
      end: () => undefined,
    } as never,
  };
}

/**
 * An `ArgumentsHost` shaped like the one Nest hands a global filter — `new ExecutionContextHost([
 * req, res, next])`, so `getClass()` is null and the request is the only thing carrying context.
 * `boundary` is what `PublicIdInterceptor` would have parked there; `undefined` is a refusal
 * decided before it ever ran.
 */
function hostWith(request: Record<string | symbol, unknown>): ArgumentsHost {
  const response = {};
  return {
    getType: () => 'http',
    getClass: () => null,
    getArgByIndex: (i: number) => (i === 0 ? request : response),
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;
}

/** A request that has been through the interceptor for `controller`, exactly as a real one has by
 *  the time a service throws. */
function requestFor(controller: object): Record<string | symbol, unknown> {
  const request: Record<string | symbol, unknown> = {};
  const context = {
    getType: () => 'http',
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  new PublicIdInterceptor().intercept(context, { handle: () => of(null) }).subscribe();
  return request;
}

class AgentFacingController {}
@MachineProtocol()
class MachineController {}

function through(exception: unknown, request: Record<string | symbol, unknown>) {
  const { sent, ref } = adapter();
  new PublicIdExceptionFilter(ref).catch(exception, hostWith(request));
  assert.equal(sent.length, 1, 'the base filter still answers the request');
  return sent[0];
}

test('a refusal from an agent-facing route names its row in base62', () => {
  const { body, status } = through(refusal(), requestFor(AgentFacingController));
  const served = body as Record<string, unknown>;

  assert.equal(status, 409);
  assert.equal(served.runId, B62, 'this is the id the CLI prints and hands back');
  assert.equal(served.runPublicId, B62, 'and the twin, as on every success body');
  assert.ok(
    !RAW_UUID.test(JSON.stringify(served)),
    `a raw uuid survived the refusal body: ${JSON.stringify(served)}`,
  );
  // The rest of the refusal is untouched — it is what the caller switches on.
  assert.equal(served.code, 'ACCEPTANCE_MISSING');
  assert.equal(served.owner, 'USER');
  assert.equal(served.verdict, 'FAIL');
});

test('a refusal from the machine protocol keeps the uuid the runner keys by', () => {
  const { body } = through(refusal(), requestFor(MachineController));
  const served = body as Record<string, unknown>;

  assert.equal(served.runId, UUID, 'a runner compares this against what it has on disk');
  assert.equal(served.runPublicId, B62, 'the twin is additive here, exactly as on success');
});

test('a refusal decided before the interceptor ran adds the twin and rewrites nothing', () => {
  // A guard runs ahead of every interceptor, so nothing parked the boundary. Unknown resolves to
  // the conservative half: adding a name is reversible, re-keying one silently is not.
  const { body } = through(refusal(), {});
  const served = body as Record<string, unknown>;

  assert.equal(served.runId, UUID);
  assert.equal(served.runPublicId, B62);
});

test('bodies with nothing to map are served exactly as Nest would serve them', () => {
  const request = requestFor(AgentFacingController);

  const text = through(new NotFoundException('project not found'), request);
  assert.deepEqual(text.body, { statusCode: 404, message: 'project not found', error: 'Not Found' });

  const validation = through(
    new HttpException({ statusCode: 400, message: ['runId must be a public id'] }, 400),
    request,
  );
  assert.deepEqual(validation.body, { statusCode: 400, message: ['runId must be a public id'] });

  const unknown = through(new Error('boom'), request);
  assert.equal(unknown.status, HttpStatus.INTERNAL_SERVER_ERROR);
  assert.equal((unknown.body as { statusCode: number }).statusCode, 500);
});

test('an id inside an opaque payload is left alone', () => {
  // Same rule as the success path: only allowlisted FIELD NAMES are touched, so a third-party id
  // that merely looks like one — and a message that merely contains a uuid — comes out verbatim.
  const { body } = through(
    new HttpException(
      { statusCode: 409, id: 'toolu_01ABC', message: `ref refs/orbit-base/${UUID} is gone` },
      409,
    ),
    requestFor(AgentFacingController),
  );
  const served = body as Record<string, unknown>;
  assert.equal(served.id, 'toolu_01ABC');
  assert.equal(served.message, `ref refs/orbit-base/${UUID} is gone`);
});

// ----------------------------------------------------------------------------------------------
// The same thing over a socket, because the handshake between the two exits is what could rot:
// the filter reads a decision the interceptor parked on the request, and only real Nest wires the
// two stages in the order that makes that true.
// ----------------------------------------------------------------------------------------------

class Refuse implements CanActivate {
  canActivate(): boolean {
    throw new HttpException({ statusCode: 403, message: 'no', runId: UUID }, 403);
  }
}

@Controller('projects')
class LiveProjectsController {
  @Patch(':id')
  update(): unknown {
    throw refusal();
  }
}

@MachineProtocol()
@Controller('runner/machine')
class LiveMachineController {
  @Patch(':id')
  update(): unknown {
    throw refusal();
  }
}

@Controller('guarded')
@UseGuards(Refuse)
class LiveGuardedController {
  @Patch(':id')
  update(): unknown {
    return {};
  }
}

@Module({ controllers: [LiveProjectsController, LiveMachineController, LiveGuardedController] })
class LiveModule {}

test('over real HTTP, the 409 that started this carries base62', async (t) => {
  const app = await NestFactory.create(LiveModule, { logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalInterceptors(new PublicIdInterceptor());
  app.useGlobalFilters(new PublicIdExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  const patch = async (path: string) => {
    const response = await fetch(`${base}${path}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'DONE' }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  const agentFacing = await patch('/api/projects/349bHrtPbgwiouD3cfCVP');
  assert.equal(agentFacing.status, 409);
  assert.equal(agentFacing.body.runId, B62);
  assert.ok(
    !RAW_UUID.test(JSON.stringify(agentFacing.body)),
    `the reproduction still leaks: ${JSON.stringify(agentFacing.body)}`,
  );

  const machine = await patch('/api/runner/machine/349bHrtPbgwiouD3cfCVP');
  assert.equal(machine.status, 409);
  assert.equal(machine.body.runId, UUID, 'the machine protocol keeps its keys');
  assert.equal(machine.body.runPublicId, B62);

  // Thrown a stage earlier than any interceptor: the twin is added, the source is not rewritten.
  const guarded = await patch('/api/guarded/x');
  assert.equal(guarded.status, 403);
  assert.equal(guarded.body.runId, UUID);
  assert.equal(guarded.body.runPublicId, B62);
});
