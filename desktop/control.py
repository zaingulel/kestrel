"""Same-account, bounded conversation control commands."""

import asyncio
from collections.abc import Callable
import json
import os
import stat
import sys

if __package__:
    from .conversation import address as conversation_address, close_writer, same_uid
else:
    from conversation import address as conversation_address, close_writer, same_uid

UNAVAILABLE = 'Kestrel conversation unavailable. Check Kestrel and try again.'
MAX_REQUEST = 32768
SUBMIT_REPLIES = (b'accepted\n', b'invalid\n', b'busy\n', b'unavailable\n')


def address() -> str:
    return '\0kestrel.control.' + conversation_address()[len('\0kestrel.conversation.'):]


class ConversationControl:
    def __init__(self, toggle, *, submit: Callable[[str], str] | None = None):
        self.toggle = toggle
        self.submit = submit
        self.server = None
        self.tasks = set()

    async def start(self):
        self.server = await asyncio.start_unix_server(self.connected, path=address(), limit=MAX_REQUEST + 1, backlog=8)

    def connected(self, reader, writer):
        if self.server is None or len(self.tasks) >= 8:
            writer.transport.abort()
            return
        task = asyncio.create_task(self.serve(reader, writer))
        self.tasks.add(task)
        task.add_done_callback(self.observed)

    def observed(self, task):
        self.tasks.discard(task)
        if not task.cancelled():
            task.exception()

    async def serve(self, reader, writer):
        try:
            reply = 'unavailable'
            if same_uid(writer.get_extra_info('socket')):
                try:
                    async with asyncio.timeout(1):
                        request = bytearray()
                        while len(request) <= MAX_REQUEST:
                            data = await reader.read(MAX_REQUEST + 1 - len(request))
                            if not data:
                                if bytes(request) == b'toggle\n':
                                    reply = self.toggle()
                                elif reply == 'invalid':
                                    text = submit_text(bytes(request))
                                    reply = self.submit(text) if self.submit is not None else 'unavailable'
                                break
                            request.extend(data)
                            if request.lstrip(b' \t\r\n\v\f').startswith(b'{'):
                                reply = 'invalid'
                except (ValueError, UnicodeError, TimeoutError):
                    pass
            writer.write(reply.encode('ascii') + b'\n')
            await asyncio.wait_for(writer.drain(), 1)
        except (OSError, ValueError, TimeoutError):
            pass
        finally:
            await close_writer(writer)

    async def close(self):
        server, self.server = self.server, None
        if server is not None:
            server.close()
            await server.wait_closed()
        tasks = tuple(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.tasks.difference_update(tasks)


async def toggle() -> str:
    writer = None
    try:
        async with asyncio.timeout(1):
            reader, writer = await asyncio.open_unix_connection(address(), limit=12)
            if not same_uid(writer.get_extra_info('socket')):
                raise ValueError(UNAVAILABLE)
            writer.write(b'toggle\n')
            await writer.drain()
            writer.write_eof()
            response = bytearray()
            while len(response) <= 12:
                data = await reader.read(13 - len(response))
                if not data:
                    break
                response.extend(data)
            response = bytes(response)
            if response not in (b'starting\n', b'inactive\n'):
                raise ValueError(UNAVAILABLE)
            return response.decode('ascii').strip()
    finally:
        if writer is not None:
            await close_writer(writer)


def validate_text(text: str) -> None:
    if (not isinstance(text, str) or not text.strip()
            or any((ord(char) < 32 and char not in '\t\r\n') or 127 <= ord(char) <= 159 for char in text)
            or len(text.encode('utf-16-le')) > 8192):
        raise ValueError('invalid')


def unique_object(pairs):
    record = {}
    for key, value in pairs:
        if key in record:
            raise ValueError('invalid')
        record[key] = value
    return record


def submit_text(request: bytes) -> str:
    if len(request) > MAX_REQUEST or not request.endswith(b'}\n'):
        raise ValueError('invalid')
    try:
        record = json.loads(request[:-1].decode('utf-8'), object_pairs_hook=unique_object)
    except (ValueError, UnicodeError, RecursionError):
        raise ValueError('invalid') from None
    if (not isinstance(record, dict) or set(record) != {'version', 'text'}
            or type(record['version']) is not int or record['version'] != 1):
        raise ValueError('invalid')
    validate_text(record['text'])
    return record['text']


async def bounded_read(reader, maximum: int) -> bytes:
    data = bytearray()
    while len(data) <= maximum:
        part = await reader.read(maximum + 1 - len(data))
        if not part:
            return bytes(data)
        data.extend(part)
    raise ValueError('invalid')


async def submit(text: str) -> str:
    writer = None
    possible_write = False
    try:
        validate_text(text)
        request = (json.dumps({'version': 1, 'text': text}, ensure_ascii=False,
                              separators=(',', ':')) + '\n').encode('utf-8')
    except (ValueError, UnicodeError):
        return 'invalid'
    try:
        async with asyncio.timeout(1):
            reader, writer = await asyncio.open_unix_connection(address(), limit=32)
            if not same_uid(writer.get_extra_info('socket')):
                return 'unavailable'
            possible_write = True
            writer.write(request)
            await writer.drain()
            writer.write_eof()
            response = await bounded_read(reader, 32)
            if response not in SUBMIT_REPLIES:
                return 'uncertain'
            return response.decode('ascii').strip()
    except (OSError, ValueError, UnicodeError, TimeoutError):
        return 'uncertain' if possible_write else 'unavailable'
    finally:
        if writer is not None:
            await close_writer(writer)


async def stdin_text() -> str:
    incoming = sys.stdin.buffer
    if stat.S_ISREG(os.fstat(incoming.fileno()).st_mode):
        return submit_text(incoming.read(MAX_REQUEST + 1))
    reader = asyncio.StreamReader(limit=MAX_REQUEST + 1)
    transport = None
    try:
        async with asyncio.timeout(1):
            transport, _ = await asyncio.get_running_loop().connect_read_pipe(
                lambda: asyncio.StreamReaderProtocol(reader), incoming)
            return submit_text(await bounded_read(reader, MAX_REQUEST))
    finally:
        if transport is not None:
            transport.close()


async def notify_failure():
    process = None
    try:
        process = await asyncio.create_subprocess_exec(
            '/usr/bin/notify-send', '--app-name=Kestrel', '--hint=boolean:suppress-sound:true',
            'Kestrel', UNAVAILABLE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(process.wait(), 1)
    except (OSError, TimeoutError):
        pass
    finally:
        if process is not None and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 1)
            except TimeoutError:
                process.kill()
                await asyncio.wait_for(process.wait(), 1)


async def main(arguments) -> int:
    if arguments == ['--submit']:
        try:
            text = await stdin_text()
        except (OSError, ValueError, UnicodeError, TimeoutError):
            result = 'invalid'
        else:
            result = await submit(text)
        print(json.dumps({'status': result}, separators=(',', ':')))
        return 0 if result == 'accepted' else 1
    if arguments != ['--toggle']:
        print('Usage: control.py --toggle', file=sys.stderr)
        return 2
    try:
        result = await toggle()
    except (OSError, ValueError, UnicodeError, TimeoutError):
        print(UNAVAILABLE, file=sys.stderr)
        try:
            await notify_failure()
        except (OSError, TimeoutError):
            pass
        return 1
    print(result)
    return 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main(sys.argv[1:])))
