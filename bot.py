"""First local Kestrel conversation trial."""

import asyncio
from copy import deepcopy
from dataclasses import dataclass, replace
from functools import partial
from enum import Enum
import json
import os
import re
import signal
import tempfile

import torch
from loguru import logger
from pipecat.audio.turn.smart_turn.base_smart_turn import SmartTurnParams
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.observers.user_bot_latency_observer import UserBotLatencyObserver
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.frames.frames import (
    LLMContextFrame, LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame,
    TTSSpeakFrame, TTSTextFrame,
)
from pipecat.services.llm_service import LLMService
from pipecat.services.settings import LLMSettings
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.workers.runner import WorkerRunner
from voxcpm import VoxCPM

from hermes_worker import HERMES_PYTHON, child_environment
from speech import EchoRemoval, LaptopAudioTransport, NemotronSTT, ROOT, SpeechAdvisoryFrame, VoxCPMTTS

ECHO_REMOVAL = EchoRemoval()
ENGINE_TIMEOUT = 45
MUTE_TIMEOUT = 5
VOLUME_TIMEOUT = 5
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
    subject: str = 'mute'


@dataclass(frozen=True)
class AudioResult:
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


async def read_output_name(argv, *, command=run_local_command) -> str:
    name = (await command(argv)).removesuffix('\n')
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.:-]{0,255}', name):
        raise ValueError('invalid sink')
    return name


async def read_output_mute(sink: str, *, command=run_local_command) -> str:
    status = (await command(('/usr/bin/pactl', 'get-sink-mute', sink))).removesuffix('\n')
    if status not in ('Mute: yes', 'Mute: no'):
        raise ValueError('invalid status')
    return status


async def mute_output(*, command=run_local_command):
    attempted = False
    try:
        async with asyncio.timeout(MUTE_TIMEOUT):
            default = await read_output_name(('/usr/bin/pactl', 'get-default-sink'), command=command)
            sink = await read_output_name(('/usr/bin/omarchy-audio-output-sink', default), command=command)
            already_muted = await read_output_mute(sink, command=command) == 'Mute: yes'
            if not already_muted:
                attempted = True
                await command(('/usr/bin/pactl', 'set-sink-mute', sink, '1'))
            after_default = await read_output_name(('/usr/bin/pactl', 'get-default-sink'), command=command)
            after_sink = await read_output_name(('/usr/bin/omarchy-audio-output-sink', after_default), command=command)
            status = await read_output_mute(sink, command=command)
            if default != after_default or sink != after_sink:
                return AudioResult(False, attempted, 'target changed')
            if status != 'Mute: yes':
                return AudioResult(False, attempted, 'readback unconfirmed')
            return AudioResult(True, attempted, 'already muted' if already_muted else 'confirmed')
    except TimeoutError:
        return AudioResult(False, attempted, 'mute timeout')
    except ValueError as error:
        return AudioResult(False, attempted, str(error))
    except RuntimeError:
        return AudioResult(False, attempted, 'command failed')


async def notify_audio_failure(subject: str, *, command=run_local_command) -> bool:
    try:
        await command((
            '/usr/bin/notify-send', '--app-name=Kestrel', '--transient',
            '--hint=boolean:suppress-sound:true',
            {'mute': 'Mute could not be confirmed', 'volume': 'Volume could not be confirmed'}[subject],
            'Check the audio control. Kestrel will not retry.',
        ))
    except RuntimeError:
        logger.error({'mute': 'Mute failure notification unavailable',
                      'volume': 'Volume failure notification unavailable'}[subject])
        return False
    # Command acceptance does not establish visible delivery by the desktop.
    return True


async def read_output_volume(sink: str, *, command=run_local_command) -> dict[str, int]:
    output = await command(('/usr/bin/pactl', '--format=json', 'get-sink-volume', sink))

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('invalid volume')
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValueError('invalid volume')

    try:
        data = json.loads(output, object_pairs_hook=unique_object, parse_constant=invalid_constant)
        if not isinstance(data, dict):
            raise ValueError
        volume = data.get('volume')
        if not isinstance(volume, dict) or not 1 <= len(volume) <= 32:
            raise ValueError
        values = {}
        for name, channel in volume.items():
            if not name or not isinstance(channel, dict):
                raise ValueError
            value = channel.get('value')
            if type(value) is not int or not 0 <= value <= 2147483647:
                raise ValueError
            values[name] = value
        return values
    except (ValueError, RecursionError):
        raise ValueError('invalid volume') from None


async def volume_output(percent: int, *, command=run_local_command) -> AudioResult:
    if type(percent) is not int or not 0 <= percent <= 100:
        raise ValueError('invalid percentage')
    attempted = False
    target = percent * 65536 // 100
    try:
        async with asyncio.timeout(VOLUME_TIMEOUT):
            default = await read_output_name(('/usr/bin/pactl', 'get-default-sink'), command=command)
            sink = await read_output_name(('/usr/bin/omarchy-audio-output-sink', default), command=command)
            initial = await read_output_volume(sink, command=command)
            muted = await read_output_mute(sink, command=command) == 'Mute: yes'
            if any(value != target for value in initial.values()):
                attempted = True
                await command(('/usr/bin/pactl', 'set-sink-volume', sink, f'{percent}%'))
                verified = await read_output_volume(sink, command=command)
                if verified.keys() != initial.keys() or any(value != target for value in verified.values()):
                    return AudioResult(False, attempted, 'readback unconfirmed')
            if muted:
                attempted = True
                await command(('/usr/bin/pactl', 'set-sink-mute', sink, '0'))
            after_default = await read_output_name(('/usr/bin/pactl', 'get-default-sink'), command=command)
            after_sink = await read_output_name(('/usr/bin/omarchy-audio-output-sink', after_default), command=command)
            after = await read_output_volume(sink, command=command)
            status = await read_output_mute(sink, command=command)
            if default != after_default or sink != after_sink:
                return AudioResult(False, attempted, 'target changed')
            if after.keys() != initial.keys() or any(value != target for value in after.values()) or status != 'Mute: no':
                return AudioResult(False, attempted, 'readback unconfirmed')
            return AudioResult(True, attempted, 'confirmed' if attempted else 'already set')
    except TimeoutError:
        return AudioResult(False, attempted, 'volume timeout')
    except ValueError as error:
        return AudioResult(False, attempted, str(error))
    except RuntimeError:
        return AudioResult(False, attempted, 'command failed')


LOCAL_TOOLS = {
    'mute': LocalTool(PermissionTier.FREE, mute_output),
    'volume': LocalTool(PermissionTier.FREE, volume_output, 'volume'),
}


VOLUME_LEVELS = {name: value for value, name in enumerate((
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
    'seventeen', 'eighteen', 'nineteen',
))}
for value, name in enumerate(('twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'), 2):
    VOLUME_LEVELS[name] = value * 10
    for digit, unit in enumerate(('one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'), 1):
        for separator in (' ', '-'):
            VOLUME_LEVELS[name + separator + unit] = value * 10 + digit
VOLUME_LEVELS['one hundred'] = 100


def match_instant_tool(text):
    text = text.strip().lower()
    if text in ('mute', 'mute.', 'mute!'):
        tool = LOCAL_TOOLS['mute']
        return tool if tool.permission is PermissionTier.FREE else None
    match = re.fullmatch(r'volume (0|[1-9][0-9]?|100)(?: percent| ?%)[.!]?', text)
    if match:
        percent = int(match[1])
    else:
        match = re.fullmatch(r'volume ([a-z -]+) percent[.!]?', text)
        if not match or match[1] not in VOLUME_LEVELS:
            return None
        percent = VOLUME_LEVELS[match[1]]
    tool = LOCAL_TOOLS['volume']
    return replace(tool, run=partial(tool.run, percent)) if tool.permission is PermissionTier.FREE else None


def stop_kestrel():
    os.kill(os.getpid(), signal.SIGTERM)


class HermesLLMService(LLMService):
    def __init__(self, *, local_command=None):
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
        self.local_command = local_command if local_command is not None else run_local_command
        self.local_tasks = set()
        self.last_spoken_reply: str | None = None

    async def run_local_tool(self, tool):
        result = await tool.run(command=self.local_command)
        if not result.confirmed:
            logger.error(f'{tool.subject.title()} could not be confirmed: {result.reason}')
            await notify_audio_failure(tool.subject, command=self.local_command)
        return result

    async def close_local_tools(self):
        tasks = tuple(self.local_tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

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
            self.failure_advisory = "I couldn't reach Kestrel's engine. Restart Kestrel and try again."
            self.failure = f'Hermes engine unavailable: {str(error) or type(error).__name__}'
            logger.error(self.failure)
            await self.reap_engine()

    def start_preparation(self):
        self.reader = asyncio.create_task(self.prepare_engine())

    async def prepare_engine(self):
        await self.open_engine()
        if not self.failure:
            await self.exchange([{'role': 'user', 'content': 'Hello.'}], asyncio.Queue())

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
        self.last_spoken_reply = None
        if self.home is not None:
            self.home.cleanup()
            self.home = None

    async def exchange(self, messages, output):
        advisory = "I couldn't reach Kestrel's engine. Restart Kestrel and try again."
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
                        advisory = "I couldn't get a complete reply from the brain on the Ally. Restart Kestrel and try again."
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
        messages = frame.context.get_messages()
        if (direction == FrameDirection.DOWNSTREAM and not frame.speculation and messages
                and messages[-1].get('role') == 'user'
                and isinstance(messages[-1].get('content'), str)):
            if messages[-1]['content'].strip().lower() in (
                    'repeat that', 'repeat that.', 'repeat that!', 'repeat that?'):
                messages.pop()
                await self.push_frame(TTSSpeakFrame(
                    self.last_spoken_reply or "I haven't said anything to repeat yet.",
                    append_to_context=False,
                ))
                return
            tool = match_instant_tool(messages[-1]['content'])
            if tool is not None:
                messages.pop()
                task = asyncio.create_task(self.run_local_tool(tool))
                self.local_tasks.add(task)
                task.add_done_callback(self.local_tasks.discard)
                result = await asyncio.shield(task)
                if not result.confirmed:
                    await self.push_frame(TTSSpeakFrame(
                        f"I couldn't confirm {tool.subject}. Check the audio control. I won't retry.",
                        append_to_context=False,
                    ))
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
            advisory = self.failure_advisory or "I couldn't reach Kestrel's engine. Restart Kestrel and try again."
            await self.push_frame(SpeechAdvisoryFrame(' ' + advisory))
        finally:
            if self.output is output:
                self.output = None
            await self.stop_processing_metrics()
            await self.push_frame(LLMFullResponseEndFrame())


def make_llm():
    return HermesLLMService()


async def bot():
    transport = LaptopAudioTransport(ECHO_REMOVAL, on_stopped=stop_kestrel)
    stt = NemotronSTT()
    llm = None
    try:
        await transport.open()
        llm = make_llm()
        llm.start_preparation()
        logger.info("Loading local speech models for the conversation")
        await stt.load()
        torch.set_num_threads(4)
        model = await asyncio.to_thread(
            VoxCPM.from_pretrained, str(ROOT / ".runtime/models/voxcpm2"),
            load_denoiser=False, optimize=False, device="cuda", local_files_only=True,
        )
        has_audio = False
        async for frame in VoxCPMTTS(model).run_tts('Hello.', 'warmup'):
            has_audio = has_audio or bool(frame.audio)
        if not has_audio:
            raise RuntimeError('VoxCPM preparation produced no audio')
        await run_conversation(stt, model, llm=llm, transport=transport, handle_signals=True)
    finally:
        try:
            if llm is not None:
                try:
                    await llm.close_local_tools()
                finally:
                    await llm.close_engine()
        finally:
            try:
                await stt.close()
            finally:
                await transport.close()
                if transport.failure:
                    raise RuntimeError(transport.failure)


async def run_conversation(stt, voice, *, llm, transport, user_params=None, handle_signals=False):
    if user_params is None:
        user_params = LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(params=VADParams(confidence=0.5)), empty_user_turn=None,
            user_turn_strategies=UserTurnStrategies(stop=[
                TurnAnalyzerUserTurnStopStrategy(
                    turn_analyzer=LocalSmartTurnAnalyzerV3(params=SmartTurnParams(stop_secs=0.6)),
                ),
            ]),
        )
    context = LLMContext([])
    aggregators = LLMContextAggregatorPair(context, user_params=user_params)
    assistant = aggregators.assistant()

    @assistant.event_handler('on_before_push_frame')
    async def remember_assistant_reply(processor, frame):
        if isinstance(frame, LLMContextFrame):
            messages = frame.context.get_messages()
            if messages and messages[-1].get('role') == 'assistant':
                text = messages[-1].get('content')
                if isinstance(text, str) and text.strip():
                    llm.last_spoken_reply = text

    output = transport.output()

    @output.event_handler('on_after_push_frame')
    async def remember_local_reply(processor, frame):
        if isinstance(frame, TTSTextFrame) and not frame.append_to_context and frame.text.strip():
            llm.last_spoken_reply = frame.text

    pipeline = Pipeline([
        transport.input(), stt, aggregators.user(), llm,
        VoxCPMTTS(voice), output, assistant,
    ])
    latency_observer = UserBotLatencyObserver()

    @latency_observer.event_handler("on_latency_measured")
    async def on_latency_measured(observer, latency_seconds):
        logger.info(f"{latency_seconds:.3f}")

    worker = PipelineWorker(
        pipeline,
        idle_timeout_secs=None,
        observers=[latency_observer],
        params=PipelineParams(
            audio_in_sample_rate=16000, audio_out_sample_rate=48000,
            enable_metrics=True,
        ),
    )

    runner = WorkerRunner(handle_sigint=handle_signals, handle_sigterm=handle_signals)
    await runner.add_workers(worker)
    logger.info("Kestrel is ready. Speak, pause for a reply, and interrupt naturally.")
    await runner.run()


async def run_voice_service():
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    stopping = False
    echo_failure = None

    def cancel():
        nonlocal stopping
        if not stopping:
            stopping = True
            task.cancel()

    def echo_stopped():
        nonlocal echo_failure
        echo_failure = "Echo removal has stopped. Restart Kestrel."
        stop_kestrel()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, cancel)
    try:
        ECHO_REMOVAL.start(echo_stopped)
        try:
            await bot()
        except asyncio.CancelledError:
            pass
    finally:
        ECHO_REMOVAL.close()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(sig)
    if echo_failure:
        raise RuntimeError(echo_failure)


if __name__ == "__main__":
    asyncio.run(run_voice_service())
