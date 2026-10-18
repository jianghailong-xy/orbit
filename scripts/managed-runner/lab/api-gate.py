#!/usr/bin/env python3
"""A pass-through in front of the lab's k3s API port, for the test manager only (task T04).

docs/managed-runner-lab.md, "Manager reconciliation (T04)". The manager's kubeconfig names
https://127.0.0.1:LISTEN instead of the QEMU forward at 127.0.0.1:16443; this process copies bytes
between the two and never decrypts them (TLS stays end to end, k3s's certificate names 127.0.0.1).
It changes nothing on the host's network: it listens on loopback only, like the forward itself.

What it can do to the manager's requests, one connection at a time (each request of the manager's
client is a connection of its own):

  pass          copy both ways (the default)
  lose-answer   the next connection whose client sends a TLS application-data record of at least
                --min-bytes, after --skip such ones, reaches k3s with its request and gets no
                answer: the gate drops what k3s sends back and closes the client's side once k3s
                has answered, or --hold SECONDS later (the client times out first, unless it is
                killed meanwhile). The next --then N connections lose their answers too, whatever
                their size (a read-back after the lost create). Then pass. Measured on 2026-10-17
                with the manager's ServiceAccount token: a GET is a record of about 1,100 bytes, a
                PVC create 1,623, a Secret create 1,669, the admission probe 4,111 and the Pod
                create after it 4,084.

  api-gate.py serve LISTEN UPSTREAM STATE_DIR     run (a transient unit; see manager-lab.py gate)
  api-gate.py arm STATE_DIR lose-answer --min-bytes N [--skip K] [--then N] [--hold SECONDS]
  api-gate.py pass STATE_DIR

Every connection is one JSON line in STATE_DIR/api-gate.jsonl: when, its sizes and what was done to it.
"""

import argparse
import asyncio
import datetime
import json
import os
from pathlib import Path
import sys

CONTROL = 'api-gate.json'
LOG = 'api-gate.jsonl'
APPLICATION_DATA = 23
# A follower's request: its TLS session comes up as usual (its Finished is a 53-byte record), and the
# first application-data record this large is the request whose answer it loses.
REQUEST_BYTES = 500


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')


def write_control(state_dir, value):
    path = Path(state_dir) / CONTROL
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value))
    os.replace(tmp, path)


def read_control(state_dir):
    try:
        return json.loads((Path(state_dir) / CONTROL).read_text())
    except (OSError, ValueError):
        return {'mode': 'pass'}


class Gate:
    def __init__(self, upstream, state_dir):
        self.upstream = upstream
        self.state_dir = Path(state_dir)
        self.count = 0
        self.log = open(self.state_dir / LOG, 'a', buffering=1)

    def claim(self, size):
        """Whether the connection that just sent an application-data record of `size` bytes loses its answer."""
        control = read_control(self.state_dir)
        if control.get('mode') != 'lose-answer' or control.get('claimedAt') or size < control.get('minBytes', 0):
            return False
        if control.get('skip', 0) > 0:
            control['skip'] -= 1
            write_control(self.state_dir, control)
            return False
        control.update(claimedAt=now(), followers=control.get('then', 0), claimedDone=False)
        write_control(self.state_dir, control)
        return True

    def follower(self):
        """A connection opened after a lost create, losing its answer whatever its size (`--then`)."""
        control = read_control(self.state_dir)
        if control.get('mode') != 'lose-answer' or not control.get('claimedAt') or control.get('followers', 0) <= 0:
            return False
        control['followers'] -= 1
        self.settle(control)
        return True

    def spent(self, claimed):
        """A connection's answer was lost: the claimed one's, or a follower's."""
        control = read_control(self.state_dir)
        if control.get('mode') != 'lose-answer':
            return
        if claimed:
            control['claimedDone'] = True
        self.settle(control)

    def settle(self, control):
        if control.get('claimedDone') and control.get('followers', 0) <= 0:
            control = {'mode': 'pass', 'lastLostAt': now()}
        write_control(self.state_dir, control)

    async def handle(self, client_reader, client_writer):
        self.count += 1
        record = {'id': self.count, 'at': now(), 'up': 0, 'down': 0, 'records': [], 'lost': False, 'end': None}
        try:
            server_reader, server_writer = await asyncio.open_connection('127.0.0.1', self.upstream)
        except OSError as error:
            record['end'] = f'upstream refused: {error.strerror or error}'
            client_writer.close()
            self.write(record)
            return
        # A connection opened while a lost create's read-back is due loses the answer to its request.
        losing = asyncio.Event()
        follower = self.follower()
        answered = asyncio.Event()

        async def up():
            buffer = b''
            while True:
                data = await client_reader.read(65536)
                if not data:
                    break
                record['up'] += len(data)
                buffer += data
                # TLS records: type, version (2), length (2), body. Only their sizes are read.
                while len(buffer) >= 5:
                    length = int.from_bytes(buffer[3:5], 'big')
                    if len(buffer) < 5 + length:
                        break
                    kind = buffer[0]
                    buffer = buffer[5 + length:]
                    if len(record['records']) < 12:
                        record['records'].append([kind, length])
                    if kind == APPLICATION_DATA and not losing.is_set():
                        if follower and length >= REQUEST_BYTES:
                            losing.set()
                            record['lost'] = 'follower'
                        elif not follower and self.claim(length):
                            losing.set()
                            record['lost'] = f'record of {length} bytes'
                server_writer.write(data)
                await server_writer.drain()
            server_writer.write_eof() if server_writer.can_write_eof() else None

        async def down():
            while True:
                data = await server_reader.read(65536)
                if not data:
                    break
                record['down'] += len(data)
                if losing.is_set():
                    answered.set()
                    continue
                client_writer.write(data)
                await client_writer.drain()

        tasks = [asyncio.ensure_future(up()), asyncio.ensure_future(down())]
        lost_wait = asyncio.ensure_future(answered.wait())
        done, _ = await asyncio.wait([*tasks, lost_wait], return_when=asyncio.FIRST_COMPLETED)
        if lost_wait in done:
            # k3s answered a request whose answer is lost: the client hears nothing more.
            await asyncio.sleep(max(0.2, float(read_control(self.state_dir).get('hold', 0) or 0)))
            record['end'] = 'answer lost'
            self.spent(claimed=record['lost'] != 'follower')
        else:
            await asyncio.wait(tasks, timeout=30)
            record['end'] = 'closed'
        for task in [*tasks, lost_wait]:
            task.cancel()
        for writer in (client_writer, server_writer):
            try:
                writer.transport.abort() if record['end'] == 'answer lost' and writer is client_writer else writer.close()
            except Exception:
                pass
        self.write(record)

    def write(self, record):
        record['closedAt'] = now()
        self.log.write(json.dumps(record) + '\n')


async def serve(listen, upstream, state_dir):
    gate = Gate(upstream, state_dir)
    server = await asyncio.start_server(gate.handle, '127.0.0.1', listen)
    print(f'api-gate: 127.0.0.1:{listen} -> 127.0.0.1:{upstream}, control {Path(state_dir) / CONTROL}', flush=True)
    async with server:
        await server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    run = sub.add_parser('serve')
    run.add_argument('listen', type=int)
    run.add_argument('upstream', type=int)
    run.add_argument('state_dir')
    arm = sub.add_parser('arm')
    arm.add_argument('state_dir')
    arm.add_argument('mode', choices=['lose-answer'])
    arm.add_argument('--min-bytes', type=int, required=True)
    arm.add_argument('--skip', type=int, default=0)
    arm.add_argument('--then', type=int, default=0)
    arm.add_argument('--hold', type=float, default=0)
    clear = sub.add_parser('pass')
    clear.add_argument('state_dir')
    args = parser.parse_args()
    if args.command == 'serve':
        write_control(args.state_dir, {'mode': 'pass'})
        asyncio.run(serve(args.listen, args.upstream, args.state_dir))
    elif args.command == 'arm':
        write_control(args.state_dir, {'mode': 'lose-answer', 'minBytes': args.min_bytes, 'skip': args.skip, 'then': args.then, 'hold': args.hold,
                                       'armedAt': now()})
        print(json.dumps(read_control(args.state_dir)))
    else:
        write_control(args.state_dir, {'mode': 'pass'})
        print(json.dumps(read_control(args.state_dir)))


if __name__ == '__main__':
    sys.exit(main())
