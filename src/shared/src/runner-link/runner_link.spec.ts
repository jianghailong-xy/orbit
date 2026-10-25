import { describe, expect, it } from 'vitest';
import {
  create,
  equals,
  fromBinary,
  isFieldSet,
  toBinary,
  type DescMessage,
  type Message,
  type MessageInitShape,
} from '@bufbuild/protobuf';
import * as pb from './v1/runner_link_pb';

type Sample = { schema: DescMessage; message: Message };

/** The bytes of an ASCII JSON text. */
const json = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

function sample<Desc extends DescMessage>(schema: Desc, init: MessageInitShape<Desc>): Sample {
  return { schema, message: create(schema, init) as Message };
}

/**
 * Every message of contracts/runner-link/v1/runner_link.proto with every field set to something
 * other than its default, so a round trip that drops or mangles a field shows up as a difference. A
 * message with a oneof appears once per member: Frame once per body.
 */
function samples(): Sample[] {
  const writeContract = { capabilityRevision: 2, schemaRevision: 2, contractDigest: 'bbdd980c70dc56bf' };
  const managedInstance = { generation: '7', podUid: 'pod-uid-1' };
  const resume = { sessionId: 'ses-1', lastSeq: 41n, turnId: 'turn-9' };
  const limits = { maxFrameBytes: 256 * 1024 };
  const credit = { maxUnackedEvents: 512, maxUnackedBytes: 8n * 1024n * 1024n };
  const sessionState = { sessionId: 'ses-1', durableSeq: 40n, leaseHeld: true };
  const approval = { sessionId: 'ses-1', approvalId: 'apr-1' };
  const watchers = { sessionId: 'ses-1', watchers: 2 };
  const hints = {
    inboxSessionIds: ['ses-1', 'ses-2'],
    claim: true,
    approvals: [approval],
    watchers: [watchers, { sessionId: 'ses-2', watchers: 1 }],
  };
  const release = { version: '0.1.235', rollback: true };
  const inbox = { sessionId: 'ses-1' };
  const tunnelRequest = { method: 'POST', path: '/runner/sessions/ses-1/merge-result', jsonBody: json('{"ok":true}') };
  const tunnelResponse = { status: 409, jsonBody: json('{"code":"STALE_CLAIM"}'), retryAfterMs: 2000 };
  const failure = { code: 'BACKEND_UNAVAILABLE', message: 'no backend answered', retryable: true, retryAfterMs: 1500 };
  const fact = { kind: 'modelCatalog', sha256: '9f86d081884c7d65', json: json('{"claude":[]}') };
  const event = { seq: 41n, type: 'assistant', tsUnixMs: 1792900000123n, turnId: 'turn-9', payloadJson: json('{"text":"done"}') };
  const rejected = { seq: 39n, code: 'PAYLOAD_INVALID', message: 'payload is not a JSON object' };
  const liveEvent = { liveSeq: 7n, type: 'text_delta', tsUnixMs: 1792900000050n, turnId: 'turn-9', payloadJson: json('{"text":"do"}') };

  const messages: Sample[] = [
    sample(pb.ChunkSchema, { frameId: 12n, index: 1, last: true, data: new Uint8Array([0x0a, 0x0b, 0x0c]) }),
    sample(pb.HelloSchema, {
      processId: 'lease-owner-1',
      runnerVersion: '0.1.236',
      os: 'linux',
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
      capabilities: ['source-pin/v1', 'integration-job/v1'],
      supportedProviders: ['claude', 'codex'],
      writeContract,
      managedInstance,
      sessions: [resume, { sessionId: 'ses-2', lastSeq: 3n }],
    }),
    sample(pb.WriteContractSchema, writeContract),
    sample(pb.ManagedInstanceSchema, managedInstance),
    sample(pb.SessionResumeSchema, resume),
    sample(pb.WelcomeSchema, {
      protocolVersion: 1,
      mode: pb.Mode.LINK,
      heartbeatIntervalMs: 30000,
      limits,
      credit,
      sessions: [sessionState],
      hints,
      release,
      connectionId: 'conn-1',
    }),
    sample(pb.LimitsSchema, limits),
    sample(pb.SessionStateSchema, sessionState),
    sample(pb.AssignedReleaseSchema, release),
    sample(pb.TokenRefreshSchema, { token: 'eyJhbGciOiJFZERTQSJ9.e30.c2ln', expiresAtUnixMs: 1792900000000n }),
    sample(pb.RedirectSchema, { url: 'wss://link-cell-2.example/runner', token: 'eyJhbGciOiJFZERTQSJ9.e30.Y2VsbDI' }),
    sample(pb.DrainSchema, { reconnectAfterMs: 4200 }),
    sample(pb.CloseSchema, { code: pb.CloseCode.SUPERSEDED, message: 'a newer connection took over', retryAfterMs: 1000 }),
    sample(pb.HintSchema, { kind: { case: 'inbox', value: inbox } }),
    sample(pb.HintSchema, { kind: { case: 'claim', value: {} } }),
    sample(pb.HintSchema, { kind: { case: 'commands', value: {} } }),
    sample(pb.HintSchema, { kind: { case: 'approval', value: approval } }),
    sample(pb.HintSchema, { kind: { case: 'watchers', value: watchers } }),
    sample(pb.InboxHintSchema, inbox),
    sample(pb.ClaimHintSchema, {}),
    sample(pb.CommandsHintSchema, {}),
    sample(pb.ApprovalHintSchema, approval),
    sample(pb.WatchersHintSchema, watchers),
    sample(pb.HintStateSchema, hints),
    sample(pb.RpcSchema, { requestId: 'req-1', sessionId: 'ses-1', afterSeq: 40n, body: { case: 'tunnel', value: tunnelRequest } }),
    sample(pb.TunnelRequestSchema, tunnelRequest),
    sample(pb.RpcResultSchema, { requestId: 'req-1', outcome: { case: 'tunnel', value: tunnelResponse } }),
    sample(pb.RpcResultSchema, { requestId: 'req-1', outcome: { case: 'failure', value: failure } }),
    sample(pb.TunnelResponseSchema, tunnelResponse),
    sample(pb.FailureSchema, failure),
    sample(pb.HeartbeatSchema, {
      processId: 'lease-owner-1',
      draining: true,
      idleCapacity: 3,
      sessionIds: ['ses-1', 'ses-2'],
      supportedProviders: ['claude', 'codex', 'cursor'],
      facts: [fact, { kind: 'repos', sha256: '2c26b46b68ffc68f' }],
    }),
    sample(pb.FactSchema, fact),
    sample(pb.HeartbeatAckSchema, {
      mode: pb.Mode.HTTP,
      reconcileJson: json('{"cancelSessionIds":["ses-3"],"maxConcurrent":4}'),
      wantFacts: ['repos'],
      hints,
      release,
    }),
    sample(pb.EventBatchSchema, {
      sessionId: 'ses-1',
      events: [event, { seq: 42n, type: 'turn_end', tsUnixMs: 1792900000200n, turnId: 'turn-9', payloadJson: json('{}') }],
    }),
    sample(pb.EventSchema, event),
    sample(pb.EventAckSchema, {
      sessionId: 'ses-1',
      durableSeq: 42n,
      rejected: [rejected],
      failure: { code: 'DATABASE_FAILOVER', message: 'primary is failing over', retryable: true, retryAfterMs: 3000 },
    }),
    sample(pb.RejectedEventSchema, rejected),
    sample(pb.CreditSchema, credit),
    sample(pb.LiveBatchSchema, {
      sessionId: 'ses-1',
      events: [liveEvent, { liveSeq: 8n, type: 'text_delta', tsUnixMs: 1792900000060n, turnId: 'turn-9', payloadJson: json('{"text":"ne"}') }],
    }),
    sample(pb.LiveEventSchema, liveEvent),
    sample(pb.TurnPrefixRequestSchema, { requestId: 'req-2', sessionId: 'ses-1' }),
    sample(pb.TurnPrefixResponseSchema, {
      requestId: 'req-2',
      sessionId: 'ses-1',
      turnId: 'turn-9',
      text: 'Half of the repl',
      thinking: 'The user wants',
      throughLiveSeq: 8n,
    }),
  ];

  // One Frame per member of its body, each wrapping the first sample of that member's type.
  const byType = new Map<string, Message>();
  for (const { schema, message } of messages) if (!byType.has(schema.typeName)) byType.set(schema.typeName, message);
  const body = pb.FrameSchema.oneofs.find((oneof) => oneof.name === 'body');
  if (!body) throw new Error('Frame has no body oneof');
  body.fields.forEach((member, i) => {
    const inner = member.message ? byType.get(member.message.typeName) : undefined;
    if (!inner) throw new Error(`no sample for Frame.${member.name}`);
    const init = { id: BigInt(i + 1), body: { case: member.localName, value: inner } };
    messages.push(sample(pb.FrameSchema, init as MessageInitShape<typeof pb.FrameSchema>));
  });
  return messages;
}

/** A message's name plus the oneof members it sets, such as "Frame.hello". */
function sampleName({ schema, message }: Sample): string {
  const members = schema.oneofs.flatMap((oneof) => oneof.fields.filter((field) => isFieldSet(message, field)));
  return [schema.name, ...members.map((member) => member.name)].join('.');
}

describe('runner link protocol round trip', () => {
  for (const s of samples()) {
    it(`${sampleName(s)} decodes to exactly what was encoded, and encodes to the same bytes again`, () => {
      const wire = toBinary(s.schema, s.message);
      const decoded = fromBinary(s.schema, wire);
      expect(equals(s.schema, s.message, decoded)).toBe(true);
      expect(toBinary(s.schema, decoded)).toEqual(wire);
    });
  }

  it('has a sample for every message in the file, so a message added without one fails here', () => {
    const sampled = new Set(samples().map(({ schema }) => schema.typeName));
    const missing: string[] = [];
    const walk = (descs: readonly DescMessage[]): void => {
      for (const desc of descs) {
        if (!sampled.has(desc.typeName)) missing.push(desc.typeName);
        walk(desc.nestedMessages);
      }
    };
    walk(pb.file_v1_runner_link.messages);
    expect(missing).toEqual([]);
  });

  it('sets every field outside a oneof in every sample, and each oneof member in some sample', () => {
    const unset: string[] = [];
    const members = new Map<string, boolean>();
    for (const s of samples()) {
      for (const field of s.schema.fields) {
        if (field.oneof) {
          const key = `${s.schema.typeName}.${field.name}`;
          members.set(key, (members.get(key) ?? false) || isFieldSet(s.message, field));
        } else if (!isFieldSet(s.message, field)) {
          unset.push(`${sampleName(s)}.${field.name}`);
        }
      }
    }
    expect(unset).toEqual([]);
    expect([...members].filter(([, set]) => !set).map(([member]) => member)).toEqual([]);
  });
});
