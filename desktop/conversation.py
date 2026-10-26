"""Private, ephemeral conversation snapshots for one same-account native reader.

The wire carries version/session/turns snapshots, alive heartbeats or an unavailable
record containing exactly one of the two fixed advisories below. No text is persisted.
"""

import asyncio
import hashlib
import json
import os
import socket
import struct
import sys
import uuid

MAX_SNAPSHOT = 1024 * 1024
UNAVAILABLE = 'Conversation unavailable. Reopen the panel.'
TOO_LARGE = 'Conversation is too large to display. Restart Kestrel to begin a new conversation.'


def address() -> str:
    runtime = os.environ.get('XDG_RUNTIME_DIR', '')
    if (not runtime.startswith('/') or len(runtime.encode('utf-8')) > 4096
            or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in runtime)):
        raise ValueError(UNAVAILABLE)
    return '\0kestrel.conversation.' + str(os.getuid()) + '.' + hashlib.sha256(runtime.encode('utf-8')).hexdigest()


def same_uid(peer) -> bool:
    try:
        _, uid, _ = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        return uid == os.getuid()
    except (OSError, struct.error):
        return False


def encode(record) -> bytes:
    return (json.dumps(record, ensure_ascii=True, separators=(',', ':')) + '\n').encode('utf-8')


def validate_record(line: bytes, session: str | None = None) -> dict:
    if len(line) > MAX_SNAPSHOT or not line.endswith(b'\n'):
        raise ValueError(UNAVAILABLE)
    try:
        record = json.loads(line)
    except RecursionError:
        raise ValueError(UNAVAILABLE) from None
    if not isinstance(record, dict):
        raise ValueError(UNAVAILABLE)
    if set(record) == {'unavailable'} and record['unavailable'] in (UNAVAILABLE, TOO_LARGE):
        return record
    if set(record) == {'alive'} and session is not None and record['alive'] == session:
        return record
    if (set(record) != {'version', 'session', 'turns'} or type(record['version']) is not int
            or record['version'] != 2 or not isinstance(record['session'], str)
            or not 1 <= len(record['session']) <= 256
            or (session is not None and record['session'] != session)
            or not isinstance(record['turns'], list)):
        raise ValueError(UNAVAILABLE)
    for turn in record['turns']:
        if (not isinstance(turn, dict)
                or set(turn) != ({'speaker', 'text', 'state', 'source'} if turn.get('speaker') == 'you'
                                 else {'speaker', 'text', 'state'})
                or turn['speaker'] not in ('you', 'kestrel') or not isinstance(turn['text'], str)
                or (turn['speaker'] == 'you' and turn['source'] not in ('spoken', 'typed'))
                or turn['state'] not in ('complete', 'thinking', 'speaking', 'interrupted', 'failed')):
            raise ValueError(UNAVAILABLE)
    return record


async def close_writer(writer):
    writer.close()
    try:
        await asyncio.wait_for(writer.wait_closed(), 1)
    except (OSError, TimeoutError):
        writer.transport.abort()


class ConversationFeed:
    def __init__(self):
        self.session = uuid.uuid4().hex
        self.turns = []
        self.active = None
        self.reply = None
        self.server = None
        self.tasks = set()
        self.reader_task = None
        self.resetting = False
        self.changed = asyncio.Event()
        self.payload = b''
        self.oversized = False
        self.publish()

    async def start(self):
        try:
            self.server = await asyncio.start_unix_server(self.connected, path=address(), limit=1)
        except (OSError, ValueError, UnicodeError):
            # A missing panel channel never prevents voice startup.
            self.server = None

    def connected(self, reader, writer):
        if self.server is None or self.resetting:
            writer.transport.abort()
            return
        task = asyncio.create_task(self.serve(reader, writer))
        self.tasks.add(task)
        task.add_done_callback(lambda task: self.observed(task, writer))

    def observed(self, task, writer):
        self.tasks.discard(task)
        if task.cancelled():
            writer.transport.abort()
        else:
            task.exception()

    async def serve(self, reader, writer):
        if self.server is None:
            writer.transport.abort()
            return
        current = asyncio.current_task()
        try:
            if self.reader_task is not None or not same_uid(writer.get_extra_info('socket')):
                return
            self.reader_task = current
            self.changed.set()
            sender = asyncio.create_task(self.send(writer))
            inbound = asyncio.create_task(reader.read(1))
            try:
                await asyncio.wait((sender, inbound), return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in (sender, inbound):
                    task.cancel()
                await asyncio.gather(sender, inbound, return_exceptions=True)
        finally:
            if self.reader_task is current:
                self.reader_task = None
            await close_writer(writer)

    async def send(self, writer):
        while True:
            try:
                await asyncio.wait_for(self.changed.wait(), 1)
            except TimeoutError:
                payload = self.payload if self.oversized else encode({'alive': self.session})
            else:
                self.changed.clear()
                payload = self.payload
            writer.write(payload)
            await asyncio.wait_for(writer.drain(), 1)

    def publish(self):
        self.payload = encode({'version': 2, 'session': self.session, 'turns': self.turns})
        self.oversized = len(self.payload) > MAX_SNAPSHOT
        if self.oversized:
            self.payload = encode({'unavailable': TOO_LARGE})
        self.changed.set()

    async def begin_session(self):
        self.resetting = True
        try:
            tasks = tuple(self.tasks)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            self.session = uuid.uuid4().hex
            self.clear()
        finally:
            self.resetting = False

    def clear(self):
        self.turns.clear()
        self.active = self.reply = None
        self.publish()

    def user(self, text: str, *, source: str):
        if source not in ('spoken', 'typed'):
            raise ValueError(UNAVAILABLE)
        self.turns.append({'speaker': 'you', 'text': text, 'state': 'complete', 'source': source})
        self.publish()

    def begin_reply(self, token: object):
        if token is None or token is self.active:
            return
        if self.active is not None:
            self.finish(self.active, interrupted=True)
        self.active = token
        self.reply = {'speaker': 'kestrel', 'text': '', 'state': 'thinking'}
        self.turns.append(self.reply)
        self.publish()

    def spoken(self, token: object, text: str):
        if token is None or token is not self.active or not text.strip():
            return
        self.reply['text'] = ' '.join(part for part in (self.reply['text'], text.strip()) if part)
        self.reply['state'] = 'speaking'
        self.publish()

    def waiting(self, token: object) -> None:
        if token is None or token is not self.active or self.reply['state'] != 'speaking':
            return
        self.reply['state'] = 'thinking'
        self.publish()

    def finish(self, token: object, *, interrupted: bool = False, failed: bool = False):
        if token is None or token is not self.active:
            return
        self.reply['state'] = ('interrupted' if interrupted else
                               'failed' if failed or not self.reply['text'] else 'complete')
        self.active = None
        self.reply = None
        self.publish()

    async def close(self):
        server = self.server
        self.server = None
        if server is not None:
            server.close()
        tasks = tuple(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if server is not None:
            await server.wait_closed()
        self.clear()


def write_record(record) -> bool:
    try:
        sys.stdout.write(encode(record).decode('utf-8'))
        sys.stdout.flush()
        return True
    except (BrokenPipeError, OSError):
        # Do not flush the broken panel pipe again during interpreter shutdown.
        sys.stdout = None
        return False


async def watch():
    while True:
        writer = None
        try:
            reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(address(), limit=MAX_SNAPSHOT), 1)
            if not same_uid(writer.get_extra_info('socket')):
                raise ValueError(UNAVAILABLE)
            session = None
            while True:
                line = await asyncio.wait_for(reader.readline(), 3)
                record = validate_record(line, session)
                if 'session' in record:
                    session = record['session']
                if not write_record(record):
                    return
        except (OSError, ValueError, UnicodeError, TimeoutError):
            if not write_record({'unavailable': UNAVAILABLE}):
                return
        finally:
            if writer is not None:
                await close_writer(writer)
        await asyncio.sleep(1)


if __name__ == '__main__':
    if sys.argv[1:] != ['--watch']:
        sys.stderr.write('Usage: conversation.py --watch\n')
        sys.exit(2)
    try:
        asyncio.run(watch())
    except KeyboardInterrupt:
        pass
