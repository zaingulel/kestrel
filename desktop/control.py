"""Same-account, bounded conversation toggle command."""

import asyncio
import sys

if __package__:
    from .conversation import address as conversation_address, close_writer, same_uid
else:
    from conversation import address as conversation_address, close_writer, same_uid

UNAVAILABLE = 'Kestrel conversation unavailable. Check Kestrel and try again.'


def address() -> str:
    return '\0kestrel.control.' + conversation_address()[len('\0kestrel.conversation.'):]


class ConversationControl:
    def __init__(self, toggle):
        self.toggle = toggle
        self.server = None
        self.tasks = set()

    async def start(self):
        self.server = await asyncio.start_unix_server(self.connected, path=address(), limit=8, backlog=8)

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
                        while len(request) <= 7:
                            data = await reader.read(8 - len(request))
                            if not data:
                                if bytes(request) == b'toggle\n':
                                    reply = self.toggle()
                                break
                            request.extend(data)
                except TimeoutError:
                    pass
            if reply not in ('starting', 'inactive', 'unavailable'):
                reply = 'unavailable'
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
