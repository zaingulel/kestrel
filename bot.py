"""First local Kestrel conversation trial."""

import asyncio
from copy import deepcopy
from dataclasses import dataclass
from enum import Enum
import json
import os
import re
import signal
import tempfile

import torch
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.types import SmallWebRTCRunnerArguments
from pipecat.frames.frames import (
    LLMContextFrame, LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame,
)
from pipecat.services.llm_service import LLMService
from pipecat.services.settings import LLMSettings
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner
from voxcpm import VoxCPM

from hermes_worker import HERMES_PYTHON, child_environment
from speech import EchoRemoval, NemotronSTT, ROOT, VoxCPMTTS

SESSION_LOCK = asyncio.Lock()
# The event loop and WebRTC connection of the conversation holding the lock.
CONVERSATION = None
ECHO_REMOVAL = EchoRemoval()
# A page starts recording from the microphone it was given a moment after it connects, so the
# check is repeated until this many seconds have passed before the conversation is refused.
ECHO_REMOVAL_WAIT = 10
ECHO_REMOVAL_RETRY = 0.5
VOICE_MODEL = None
ENGINE_TIMEOUT = 45
MUTE_TIMEOUT = 5
LOCAL_COMMAND_TIMEOUT = 2
LOCAL_COMMAND_CLEANUP_TIMEOUT = 1


class PermissionTier(Enum):
    FREE = 'free'
    ASK = 'ask'
    FORBIDDEN = 'forbidden'


@dataclass(frozen=True)
class LocalTool:
    permission: PermissionTier
    run: object


@dataclass(frozen=True)
class MuteResult:
    confirmed: bool
    attempted: bool
    reason: str


async def run_local_command(argv):
    uid = os.getuid()
    env = {
        'PATH': '/usr/bin:/bin', 'LC_ALL': 'C',
        'XDG_RUNTIME_DIR': f'/run/user/{uid}',
        'PULSE_SERVER': f'unix:/run/user/{uid}/pulse/native',
        'DBUS_SESSION_BUS_ADDRESS': f'unix:path=/run/user/{uid}/bus',
    }
    process = None

    async def reap():
        if process is None:
            return
        # Closing the read pipe prevents buffered output from holding process.wait open.
        process.stdout._transport.close()
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(process.wait(), LOCAL_COMMAND_CLEANUP_TIMEOUT)
        except TimeoutError:
            pass
        # The leader may exit while descendants still own the session's pipes.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await process.wait()

    async def finish_cleanup():
        cleanup = asyncio.create_task(reap())
        cancelled = False
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                cancelled = True
        await cleanup
        if cancelled:
            raise asyncio.CancelledError

    try:
        async with asyncio.timeout(LOCAL_COMMAND_TIMEOUT):
            process = await asyncio.create_subprocess_exec(
                *argv, env=env, stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
            )
            output = bytearray()
            while chunk := await process.stdout.read(4097 - len(output)):
                output.extend(chunk)
                if len(output) > 4096:
                    raise RuntimeError('output too large')
            if await process.wait() != 0:
                raise RuntimeError('command failed')
            try:
                return output.decode('utf-8', errors='strict')
            except UnicodeDecodeError:
                raise RuntimeError('invalid output') from None
    except asyncio.CancelledError:
        await finish_cleanup()
        raise
    except (OSError, RuntimeError, TimeoutError) as error:
        await finish_cleanup()
        if isinstance(error, TimeoutError):
            reason = 'command timeout'
        elif isinstance(error, OSError):
            reason = 'command unavailable'
        else:
            reason = str(error)
        raise RuntimeError(reason) from None


async def mute_output(*, command=run_local_command):
    attempted = False

    async def sink_name(argv):
        name = (await command(argv)).removesuffix('\n')
        if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.:-]{0,255}', name):
            raise ValueError('invalid sink')
        return name

    async def mute_status(sink):
        status = (await command(('/usr/bin/pactl', 'get-sink-mute', sink))).removesuffix('\n')
        if status not in ('Mute: yes', 'Mute: no'):
            raise ValueError('invalid status')
        return status

    try:
        async with asyncio.timeout(MUTE_TIMEOUT):
            default = await sink_name(('/usr/bin/pactl', 'get-default-sink'))
            sink = await sink_name(('/usr/bin/omarchy-audio-output-sink', default))
            already_muted = await mute_status(sink) == 'Mute: yes'
            if not already_muted:
                attempted = True
                await command(('/usr/bin/pactl', 'set-sink-mute', sink, '1'))
            after_default = await sink_name(('/usr/bin/pactl', 'get-default-sink'))
            after_sink = await sink_name(('/usr/bin/omarchy-audio-output-sink', after_default))
            status = await mute_status(sink)
            if default != after_default or sink != after_sink:
                return MuteResult(False, attempted, 'target changed')
            if status != 'Mute: yes':
                return MuteResult(False, attempted, 'readback unconfirmed')
            return MuteResult(True, attempted, 'already muted' if already_muted else 'confirmed')
    except TimeoutError:
        return MuteResult(False, attempted, 'mute timeout')
    except ValueError as error:
        return MuteResult(False, attempted, str(error))
    except (OSError, RuntimeError):
        return MuteResult(False, attempted, 'command failed')


async def notify_mute_failure(*, command=run_local_command):
    try:
        await command((
            '/usr/bin/notify-send', '--app-name=Kestrel', '--transient',
            '--hint=boolean:suppress-sound:true', 'Mute could not be confirmed',
            'Check the audio control. Kestrel will not retry.',
        ))
    except (OSError, RuntimeError):
        logger.error('Mute failure notification unavailable')
        return False
    # Command acceptance does not establish visible delivery by the desktop.
    return True


LOCAL_TOOLS = {'mute': LocalTool(PermissionTier.FREE, mute_output)}


def match_instant_tool(text):
    if text.strip().lower() not in ('mute', 'mute.', 'mute!'):
        return None
    tool = LOCAL_TOOLS.get('mute')
    return tool if tool is not None and tool.permission is PermissionTier.FREE else None


def stop_kestrel():
    # Runs on the echo removal watcher thread. Uvicorn waits for a running conversation
    # before it exits on SIGTERM, so the conversation is ended first.
    conversation = CONVERSATION
    if conversation:
        loop, connection = conversation
        asyncio.run_coroutine_threadsafe(connection.disconnect(), loop)
    os.kill(os.getpid(), signal.SIGTERM)


class HermesLLMService(LLMService):
    def __init__(self):
        super().__init__(settings=LLMSettings(
            model=None, system_instruction=None, temperature=None, max_tokens=None,
            top_p=None, top_k=None, frequency_penalty=None, presence_penalty=None, seed=None,
            filter_incomplete_user_turns=False, user_turn_completion_config=None,
        ))
        self.process = None
        self.home = None
        self.reader = None
        self.output = None
        self.failure = None
        self.failure_advisory = None

    async def open_engine(self):
        try:
            self.home = tempfile.TemporaryDirectory(prefix='hermes-session-', dir=(ROOT / '.runtime').resolve())
            async with asyncio.timeout(ENGINE_TIMEOUT):
                self.process = await asyncio.create_subprocess_exec(
                    str(HERMES_PYTHON), str(ROOT / 'hermes_worker.py'),
                    env=child_environment(self.home.name),
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    limit=1024 * 1024 + 1,
                )
                event = await self.read_event()
                if set(event) != {'ready'} or event['ready'] is not True:
                    raise RuntimeError(event.get('error') or 'Hermes did not become ready')
        except Exception as error:
            self.failure_advisory = "I couldn't reach Kestrel's engine. Reconnect and try again."
            self.failure = f'Hermes engine unavailable: {str(error) or type(error).__name__}'
            logger.error(self.failure)
            await self.reap_engine()

    async def read_event(self):
        line = await self.process.stdout.readline()
        if not line or len(line) > 1024 * 1024:
            raise RuntimeError('Hermes exited or returned an oversized response')
        event = json.loads(line)
        if not isinstance(event, dict):
            raise RuntimeError('Invalid Hermes response')
        return event

    async def reap_engine(self):
        if self.process is not None and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()

    async def close_engine(self):
        if self.reader is not None:
            self.reader.cancel()
            try:
                await self.reader
            except asyncio.CancelledError:
                pass
        await self.reap_engine()
        self.process = None
        self.reader = None
        self.output = None
        if self.home is not None:
            self.home.cleanup()
            self.home = None

    async def exchange(self, messages, output):
        advisory = "I couldn't reach Kestrel's engine. Reconnect and try again."
        try:
            async with asyncio.timeout(ENGINE_TIMEOUT):
                self.process.stdin.write(json.dumps({'messages': messages}).encode() + b'\n')
                await self.process.stdin.drain()
                has_text = False
                while True:
                    event = await self.read_event()
                    if set(event) == {'text'} and isinstance(event['text'], str) and event['text']:
                        has_text = has_text or bool(event['text'].strip())
                        if self.output is output:
                            output.put_nowait(event)
                    elif set(event) == {'done'} and event['done'] is True and has_text:
                        break
                    elif set(event) == {'error'} and isinstance(event['error'], str) and event['error'].strip():
                        advisory = "I couldn't get a complete reply from the brain on the Ally. Reconnect and try again."
                        raise RuntimeError(event['error'])
                    else:
                        raise RuntimeError('Invalid or incomplete Hermes response')
        except Exception as error:
            self.failure_advisory = advisory
            self.failure = f'Hermes reply failed: {str(error) or type(error).__name__}'
            logger.error(self.failure)
            await self.reap_engine()
        finally:
            if self.output is output:
                output.put_nowait(None)

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if not isinstance(frame, LLMContextFrame):
            await self.push_frame(frame, direction)
            return
        output = None
        try:
            if self.reader is not None:
                # Speech cancellation detaches output; native work still reaches a terminal event.
                await asyncio.shield(self.reader)
            await self.push_frame(LLMFullResponseStartFrame())
            await self.start_processing_metrics()
            if self.failure:
                raise RuntimeError(self.failure)
            output = asyncio.Queue()
            self.output = output
            self.reader = asyncio.create_task(self.exchange(deepcopy(frame.context.get_messages()), output))
            while event := await output.get():
                await self.push_frame(LLMTextFrame(event['text']))
            await asyncio.shield(self.reader)
            if self.failure:
                raise RuntimeError(self.failure)
        except Exception as error:
            logger.error(f'Hermes session cannot answer: {error}')
            advisory = self.failure_advisory or "I couldn't reach Kestrel's engine. Reconnect and try again."
            await self.push_frame(LLMTextFrame(' ' + advisory))
        finally:
            if self.output is output:
                self.output = None
            await self.stop_processing_metrics()
            await self.push_frame(LLMFullResponseEndFrame())


def make_llm():
    return HermesLLMService()


async def echo_removal_fault(disconnected):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + ECHO_REMOVAL_WAIT
    while True:
        fault = await asyncio.to_thread(ECHO_REMOVAL.fault)
        if not fault or disconnected.is_set() or loop.time() >= deadline:
            return fault
        await asyncio.sleep(ECHO_REMOVAL_RETRY)


async def bot(runner_args: SmallWebRTCRunnerArguments):
    global CONVERSATION, VOICE_MODEL
    if SESSION_LOCK.locked():
        logger.warning("A microphone session is already running; disconnecting the second client")
        await runner_args.webrtc_connection.disconnect()
        return
    async with SESSION_LOCK:
        stt = NemotronSTT()
        disconnected = asyncio.Event()

        @runner_args.webrtc_connection.event_handler("closed")
        async def on_closed(connection):
            disconnected.set()

        # Set before the check: a stop reported at any moment either ends this conversation
        # or fails the check.
        CONVERSATION = (asyncio.get_running_loop(), runner_args.webrtc_connection)
        try:
            fault = await echo_removal_fault(disconnected)
            if fault:
                logger.error(f"Refusing the microphone session: {fault}")
                return
            if disconnected.is_set():
                return
            logger.info("Loading local speech models for the microphone session")
            await stt.load()
            torch.set_num_threads(4)
            if VOICE_MODEL is None:
                VOICE_MODEL = await asyncio.to_thread(
                    VoxCPM.from_pretrained, str(ROOT / ".runtime/models/voxcpm2"),
                    load_denoiser=False, optimize=False, device="cuda", local_files_only=True,
                )
            if not disconnected.is_set():
                await run_conversation(runner_args, stt, VOICE_MODEL)
        finally:
            CONVERSATION = None
            await stt.close()
            await runner_args.webrtc_connection.disconnect()


async def run_conversation(runner_args, stt, voice, *, transport=None, user_params=None):
    if transport is None:
        transport = SmallWebRTCTransport(
            webrtc_connection=runner_args.webrtc_connection,
            params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
        )
    if user_params is None:
        user_params = LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(), empty_user_turn=None,
        )
    context = LLMContext([])
    aggregators = LLMContextAggregatorPair(context, user_params=user_params)
    llm = make_llm()
    pipeline = Pipeline([
        transport.input(), stt, aggregators.user(), llm,
        VoxCPMTTS(voice), transport.output(), aggregators.assistant(),
    ])
    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=16000, audio_out_sample_rate=48000,
            enable_metrics=True,
        ),
    )

    @transport.event_handler("on_client_disconnected")
    async def on_disconnect(transport, client):
        await worker.cancel()

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    try:
        await llm.open_engine()
        logger.info("Kestrel is ready. Speak, pause for a reply, and interrupt naturally.")
        await runner.run()
    finally:
        await llm.close_engine()


def run_voice_service(main):
    ECHO_REMOVAL.start(stop_kestrel)
    try:
        main()
    finally:
        ECHO_REMOVAL.close()


if __name__ == "__main__":
    from pipecat.runner.run import main

    run_voice_service(main)
