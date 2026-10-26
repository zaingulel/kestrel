"""Local Kestrel conversation orchestration."""

import asyncio
from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass, replace
from functools import partial
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
from pipecat.audio.vad.vad_analyzer import VADParams, VADState
from pipecat.observers.user_bot_latency_observer import UserBotLatencyObserver
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection
from pipecat.processors.aggregators.llm_response_universal import (
    LLMUserAggregator, LLMAssistantAggregator,
    LLMUserAggregatorParams,
)
from pipecat.frames.frames import (
    BotStartedSpeakingFrame, BotStoppedSpeakingFrame, CancelFrame, StartFrame, UserStartedSpeakingFrame,
    Frame, InputAudioRawFrame, TranscriptionFrame, InterimTranscriptionFrame,
    VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame, ProposedUserStartedSpeakingFrame, UserSpeakingFrame,
    UserStoppedSpeakingFrame, ProposedUserStoppedSpeakingFrame, LLMMessagesAppendFrame, LLMContextFrame, LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame,
    OutputAudioRawFrame, TTSSpeakFrame, TTSTextFrame, InterruptionFrame, TTSStartedFrame,
)
from pipecat.services.llm_service import LLMService
from pipecat.services.settings import LLMSettings
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_stop.base_user_turn_stop_strategy import BaseUserTurnStopStrategy
from pipecat.turns.types import ProcessFrameResult
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.workers.runner import WorkerRunner
from voxcpm import VoxCPM

from desktop.conversation import ConversationFeed
from desktop.control import ConversationControl
from desktop.status import IndicatorStatus
from reply_progress import AnnouncementMarkFrame, ConversationSynthesisFailedFrame, ReplyProgress, SpeechAdvisoryFrame, token_of
from hermes_worker import (DELIVERY_LABELS, HERMES_PYTHON, KESTREL_SOURCE, MEMORY_ERROR,
                           child_environment)
from speech import (
    ConversationTTS, EchoRemoval, OutputDeviceWatch, PipeWireGraphCleanupFailure, OUTPUT_SWITCH_FAILURE, OUTPUT_WATCH_FAILURE,
    LAPTOP_CAPTURE_FAILURE, LAPTOP_PLAYBACK_FAILURE, LaptopAudioTransport,
    NemotronRecognizer, NemotronSTT, PhononTTS, ROOT, VoxCPMTTS, load_phonon, load_voice_preset,
)
from tool_actions import (
    TOOL_ACTIONS, AppLaunchResult, AudioResult, DesktopResult, notify_audio_failure, run_local_command,
    validate_tool_actions,
)
from tool_catalogue import TOOL_CATALOGUE, PermissionTier, brain_result, match_local_phrase, valid_desktop_arguments
from wakeword import WakeWordDetector, ADVICE as WAKE_ADVICE

ECHO_REMOVAL = EchoRemoval()
ENGINE_TIMEOUT = 45
TURN_TIMEOUT = 1800
ANNOUNCEMENT_TIMEOUT = 5


@dataclass(frozen=True)
class LocalTool:
    permission: PermissionTier
    run: object
    subject: str
    spoken: str
    confirmation: str | None = None
    announcement: str | None = None

    lookup: Callable | None = None
    counts_toward_stop: bool = False
    failure_message: str | None = None
    lookup_failure: tuple[str, str] | None = None
    lookup_miss: tuple[str, str] | None = None


validate_tool_actions()

LOCAL_TOOLS = {
    name: LocalTool(spec.permission, TOOL_ACTIONS[name].run, spec.subject, spec.spoken,
                    confirmation=spec.confirmation, announcement=spec.announcement,
                    lookup=TOOL_ACTIONS[name].lookup, counts_toward_stop=spec.counts_toward_stop,
                    failure_message=spec.failure_message, lookup_failure=spec.lookup_failure,
                    lookup_miss=spec.lookup_miss)
    for name, spec in TOOL_CATALOGUE.items()
}


OUTSIDE_TEXT_ADVISORY = ("To keep you safe, I stop saving notes, opening apps and taking screenshots once I've read text "
                         "that didn't come from you. Say the exact command, or ask again in a new conversation.")

HELP_INTRO = "I can talk with you, answer general knowledge questions and keep short notes between conversations."
HELP_PHRASES = "You can also say repeat that, stop, that's all, or what can I say."
HELP_LIMITS = "I have no internet or live information, and I can't see what's on your screen."


def capability_help() -> str:
    free = []
    ask = []
    for tool in LOCAL_TOOLS.values():
        if tool.permission == PermissionTier.FREE:
            free.append(tool.spoken)
        elif tool.permission == PermissionTier.ASK:
            ask.append(tool.spoken)
    if not free and not ask:
        tools = "No local tools are available. Check Kestrel's setup."
    elif ask:
        message = ('You can say: ' + '; '.join(free) + '.' if free else
                   'No local tools are available without permission.')
        tools = (message + ' Permission required: ' + '; '.join(ask)
                 + ". These tools aren't available by voice yet.")
    else:
        tools = 'You can say: ' + '; '.join(free) + '. None of these tools needs permission first.'
    return f'{HELP_INTRO} {tools} {HELP_PHRASES} {HELP_LIMITS}'


def free_tool(key, *arguments) -> LocalTool | None:
    tool = LOCAL_TOOLS[key]
    if tool.permission is not PermissionTier.FREE:
        return None
    if tool.lookup is not None:
        return replace(tool, lookup=partial(tool.lookup, *arguments))
    if not arguments:
        return tool
    confirmation = (tool.confirmation.format(**dict(zip(TOOL_CATALOGUE[key].bounds, arguments)))
                    if tool.confirmation is not None else None)
    return replace(tool, run=partial(tool.run, *arguments), confirmation=confirmation)


def local_result_message(tool, result) -> str | None:
    return (result.message if isinstance(result, (DesktopResult, AppLaunchResult)) else
            tool.failure_message
            if not result.confirmed else None)


def effect_observed(result) -> bool:
    return result.accepted if isinstance(result, AppLaunchResult) else result.confirmed


def match_instant_tool(text: str) -> LocalTool | None:
    matched = match_local_phrase(text)
    if matched is None:
        return None
    name, arguments = matched
    return free_tool(name, *(arguments[key] for key in TOOL_CATALOGUE[name].bounds))


async def resolve_local_tool(tool: LocalTool, *, command=run_local_command) -> LocalTool | None:
    resolved = await tool.lookup(command=command)
    if resolved is None:
        return None
    operands, values = resolved
    confirmation = tool.confirmation.format(**values) if tool.confirmation is not None else None
    return replace(tool, run=partial(tool.run, *operands), confirmation=confirmation)


def stop_kestrel():
    os.kill(os.getpid(), signal.SIGTERM)


class HermesRequestChannel:
    def __init__(self):
        self.process = None
        self.home = None
        self.reader = None
        self.preparation = None
        self.output = None
        self.failure = None
        self.failure_advisory = None
        self.lock = asyncio.Lock()
        self.closed = False

    def detach(self, output):
        if self.output is output:
            self.output = None

    def known_unavailable(self) -> bool:
        return (bool(self.failure) and (self.reader is None or self.reader.done())
                and (self.process is None or self.process.returncode is not None))

    async def drain(self):
        if self.reader is not None:
            task = self.reader
            try:
                await asyncio.shield(task)
            finally:
                if task.done():
                    self.reader = None

    async def exchange(self, messages, output, *, admitted, desktop=None):
        await self._request({'messages': messages}, output, admitted=admitted, desktop=desktop)

    async def _request(self, request, output, *, admitted, desktop=None):
        async with self.lock:
            await self.drain()
            if not admitted() or self.closed or self.failure:
                output.put_nowait(None)
                return
            self.output = output
            self.reader = asyncio.create_task(self._exchange(request, output, admitted=admitted, desktop=desktop))
            try:
                await asyncio.shield(self.reader)
            finally:
                self.detach(output)

    async def _open(self):
        try:
            managed_brain = os.environ.get('KESTREL_MANAGED_BRAIN', '')
            if managed_brain not in ('', '1'):
                raise RuntimeError('Invalid KESTREL_MANAGED_BRAIN setting. Restart Kestrel and try again.')
            if managed_brain == '1':
                try:
                    await run_local_command([
                        '/usr/bin/systemctl', '--user', 'is-active', '--quiet', 'kestrel-brain.service',
                    ])
                except Exception as error:
                    raise RuntimeError(f'kestrel-brain.service is unavailable: {error}. Restart Kestrel and try again.') from error
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
            await self._reap()

    async def prepare(self):
        await self._open()
        if not self.failure:
            await self._request({'prepare': True}, asyncio.Queue(), admitted=lambda: True)

    async def begin_conversation(self, *, admitted) -> bool:
        if self.preparation is not None:
            await asyncio.shield(self.preparation)
        if self.failure:
            raise RuntimeError(self.failure)
        async with self.lock:
            await self.drain()
            if self.failure:
                raise RuntimeError(self.failure)
            self.reader = asyncio.create_task(self._begin(admitted=admitted))
            return await asyncio.shield(self.reader)

    async def _begin(self, *, admitted) -> bool:
        advisory = "I couldn't reach Kestrel's engine. Restart Kestrel and try again."
        try:
            async with asyncio.timeout(ENGINE_TIMEOUT):
                if not admitted() or self.closed:
                    return False
                self.process.stdin.write(b'{"begin": true}\n')
                await self.process.stdin.drain()
                event = await self.read_event()
                if set(event) == {'session_ready'} and event['session_ready'] is True:
                    return True
                if set(event) == {'error'} and isinstance(event['error'], str) and event['error'].strip():
                    advisory = (MEMORY_ERROR if event['error'] == MEMORY_ERROR else
                                "I couldn't get a complete reply from the brain. Restart Kestrel and try again.")
                    raise RuntimeError(event['error'])
                raise RuntimeError('Invalid Hermes conversation readiness response')
        except Exception as error:
            self.failure_advisory = advisory
            self.failure = f'Hermes conversation unavailable: {str(error) or type(error).__name__}'
            logger.error(self.failure)
            await self._reap()
            raise

    async def read_event(self):
        line = await self.process.stdout.readline()
        if not line or len(line) > 1024 * 1024:
            raise RuntimeError('Hermes exited or returned an oversized response')
        event = json.loads(line)
        if not isinstance(event, dict):
            raise RuntimeError('Invalid Hermes response')
        return event

    async def _reap(self):
        if self.process is not None and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except TimeoutError:
                self.process.kill()
                await asyncio.wait_for(self.process.wait(), 5)

    async def close(self):
        self.closed = True
        self.output = None
        if self.preparation is not None:
            self.preparation.cancel()
            await asyncio.gather(self.preparation, return_exceptions=True)
            self.preparation = None
        errors = []
        reader = self.reader
        known_unavailable = self.known_unavailable()
        if reader is not None:
            reader.cancel()
            try:
                await reader
            except asyncio.CancelledError:
                pass
            except Exception as error:
                if not known_unavailable:
                    errors.append(error)
            finally:
                if reader.done():
                    self.reader = None
        try:
            await self._reap()
        except Exception as error:
            errors.append(error)
        finally:
            if self.process is None or self.process.returncode is not None:
                if self.home is not None:
                    try:
                        self.home.cleanup()
                    except Exception as error:
                        errors.append(error)
                    else:
                        self.home = None
                if self.home is None:
                    self.process = None
        if len(errors) == 1:
            raise errors[0]
        if errors:
            raise ExceptionGroup('Hermes channel cleanup failed', errors)  # noqa: F821 - The voice runtime uses Python 3.12.

    async def _exchange(self, request, output, *, admitted, desktop=None):
        advisory = "I couldn't reach Kestrel's engine. Restart Kestrel and try again."
        try:
            async with asyncio.timeout(TURN_TIMEOUT if 'messages' in request else ENGINE_TIMEOUT):
                if not admitted():
                    return
                self.process.stdin.write(json.dumps(request).encode() + b'\n')
                await self.process.stdin.drain()
                has_text = False
                delivery = None
                refused = False
                while True:
                    event = await self.read_event()
                    if (set(event) == {'delivery'} and delivery is None
                            and isinstance(event['delivery'], str) and event['delivery'] in DELIVERY_LABELS):
                        delivery = event['delivery']
                        if self.output is output:
                            output.put_nowait(event)
                    elif (set(event) == {'text'} and delivery is not None
                          and isinstance(event['text'], str) and event['text']):
                        has_text = has_text or bool(event['text'].strip())
                        if self.output is output:
                            output.put_nowait(event)
                    elif set(event) == {'tool_refused'} and event['tool_refused'] is True and desktop is not None:
                        if not refused and self.output is output:
                            output.put_nowait({'advisory': OUTSIDE_TEXT_ADVISORY})
                            refused = True
                    elif (set(event) == {'tool_call'} and desktop is not None
                          and isinstance(event['tool_call'], dict)
                          and set(event['tool_call']) == {'name', 'arguments'}
                          and isinstance(event['tool_call']['name'], str)
                          and event['tool_call']['name'] in TOOL_CATALOGUE
                          and isinstance(event['tool_call']['arguments'], dict)):
                        call = event['tool_call']
                        content = await desktop(call['name'], call['arguments'])
                        self.process.stdin.write(json.dumps({'tool_result': content, 'source': KESTREL_SOURCE}).encode() + b'\n')
                        await self.process.stdin.drain()
                    elif set(event) == {'done'} and event['done'] is True and has_text:
                        break
                    elif set(event) == {'incomplete'} and event['incomplete'] is True:
                        if self.output is output:
                            output.put_nowait({'advisory': "I couldn't get a complete reply from the brain."})
                        break
                    elif set(event) == {'error'} and isinstance(event['error'], str) and event['error'].strip():
                        advisory = (MEMORY_ERROR if event['error'] == MEMORY_ERROR else
                                    "I couldn't get a complete reply from the brain. Restart Kestrel and try again.")
                        raise RuntimeError(event['error'])
                    else:
                        raise RuntimeError('Invalid or incomplete Hermes response')
        except Exception as error:
            self.failure_advisory = advisory
            self.failure = f'Hermes reply failed: {str(error) or type(error).__name__}'
            logger.error(self.failure)
            await self._reap()
        finally:
            if self.output is output:
                output.put_nowait(None)


class LocalActions:
    def __init__(self, *, command=None):
        self.command = command if command is not None else run_local_command
        self.lock = asyncio.Lock()
        self.tasks = set()
        self.closed = False

    def retain(self, task):
        self.tasks.add(task)
        task.add_done_callback(self._completed)
        return task

    def _completed(self, task):
        self.tasks.discard(task)
        if not task.cancelled():
            task.exception()

    async def run(self, tool, *, admitted, observe=None):
        task = self.retain(asyncio.create_task(self._run(tool, admitted=admitted, observe=observe)))
        # An already-started external effect belongs to the service, not its caller.
        return await asyncio.shield(task)

    async def _run(self, tool, *, admitted, observe=None):
        async with self.lock:
            if self.closed or not admitted():
                return None
            started = False
            refused = False

            async def command(argv, **kwargs):
                nonlocal started, refused
                if not started:
                    if self.closed or not admitted():
                        refused = True
                        raise asyncio.CancelledError
                    started = True
                    if observe is not None:
                        observe(None)
                return await self.command(argv, **kwargs)

            try:
                result = await tool.run(command=command)
            except asyncio.CancelledError:
                if not refused:
                    raise
                return None
            if observe is not None:
                observe(result)
        if not effect_observed(result):
            logger.error(f'{tool.subject.title()} could not be confirmed: {result.reason}')
            if isinstance(result, AudioResult):
                await notify_audio_failure(tool.subject, command=self.command)
        return result

    async def drain(self):
        await asyncio.gather(*tuple(self.tasks), return_exceptions=True)

    async def close(self):
        self.closed = True
        tasks = tuple(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


class TypedTurnStopStrategy(BaseUserTurnStopStrategy):
    @property
    def resolves_proposed_turn_stop_frames(self):
        return True

    async def process_frame(self, frame):
        if isinstance(frame, ProposedUserStoppedSpeakingFrame):
            await self.trigger_user_turn_stopped()
        return ProcessFrameResult.CONTINUE


@dataclass
class ActionOutcome:
    subject: str
    reporter: object
    result: AudioResult | DesktopResult | AppLaunchResult | None = None


def stop_account(outcomes) -> str | None:
    sections = []
    for label, predicate in (
        ('Done', lambda result: result is not None and effect_observed(result)),
        ("Couldn't confirm", lambda result: result is not None and result.attempted and not effect_observed(result)),
        ('Still finishing', lambda result: result is None),
    ):
        subjects = list(dict.fromkeys(item.subject for item in outcomes if predicate(item.result)))
        if subjects:
            sections.append(f"{label}: {', '.join(subjects)}.")
    return "Stopped. " + ' '.join(sections) + " I won't undo anything." if sections else None


@dataclass
class BrainTurn:
    names: set
    user: dict
    epoch: int
    records: list
    closed: bool = False


class HermesLLMService(LLMService):
    def __init__(self, channel: HermesRequestChannel, *, local_actions: LocalActions, admitted, session_ready, dismiss, status=None, conversation=None, voice_active=None, request_admitted=None, input_epoch=None):
        super().__init__(settings=LLMSettings(
            model=None, system_instruction=None, temperature=None, max_tokens=None,
            top_p=None, top_k=None, frequency_penalty=None, presence_penalty=None, seed=None,
            filter_incomplete_user_turns=False, user_turn_completion_config=None,
        ))
        self.output = None
        self.channel = channel
        self.local_actions = local_actions
        self.admitted = admitted
        self.session_ready = session_ready
        self.dismiss = dismiss
        self.voice_active = voice_active or admitted
        self.request_admitted = request_admitted
        self.typed_origin = None
        self.spoken_origin = None
        self.input_epoch = input_epoch if input_epoch is not None else lambda: 0
        self.frame_completions = {}
        self._assistant_reply_token = None
        self._last_spoken_token = None
        self._heard_prefix_token = None
        self.lookup = None
        self.stop_epoch = 0
        self.outcomes = []
        self.brain_turns = []
        self.status = status
        self.conversation = conversation
        self._reply = None
        # (token, marker, future) for the one announcement LocalActions.lock lets wait at a time.
        self._announcement = None
        self._indicator_ready = False
        self._indicator_voice_failed = False
        self._indicator_user = False
        self._indicator_output = False
        self._indicator_pending = False
        self._indicator_reply = object()
        self._indicator_output_reply = None
        self.last_spoken_reply: str | None = None

    def accept_request(self, token):
        self._indicator_reply = token
        self._indicator_output = False
        self._indicator_pending = False

    def owns_request(self, token):
        return token is not None and self.admitted() and token is self._indicator_reply

    def valid_origin(self, frame):
        origin = getattr(frame, 'request_origin', None)
        if origin is None:
            return False
        token, source, message, text, epoch = origin
        return (isinstance(text, str) and self.owns_request(token) and (source != 'spoken' or epoch == self.input_epoch())
                and any(item is message for item in frame.context.get_messages())
                and message.get('role') == 'user' and message.get('content') == text)

    def frame_completed(self, role, frame):
        future = self.frame_completions.get((role, frame.id))
        if future is not None and not future.done():
            future.set_result(None)

    def refresh_indicator(self):
        if self.voice_active() and self.admitted() and self.status is not None and self._indicator_ready:
            state = ('trouble-voice' if self._indicator_voice_failed else
                     'listening' if self._indicator_user else
                     'speaking' if self._indicator_output else
                     'thinking' if self._indicator_pending else
                     ('trouble-notes' if self.channel.failure_advisory == MEMORY_ERROR else 'trouble-engine')
                     if self.channel.failure else 'idle')
            self.status.set_state(state)

    def indicator_input_ready(self):
        self._indicator_ready = True
        self.refresh_indicator()

    def indicator_voice_failed(self) -> None:
        if not self._indicator_voice_failed:
            self._indicator_voice_failed = True
            self.refresh_indicator()

    def indicator_user_stopped(self):
        self._indicator_user = False
        self.refresh_indicator()

    def indicator_output_started(self):
        if not self._indicator_user:
            self._indicator_output_reply = self._indicator_reply
            self._indicator_output = True
            self.refresh_indicator()

    def indicator_output_stopped(self):
        if self._indicator_output_reply is self._indicator_reply:
            self._indicator_output = False
            self.refresh_indicator()

    def indicator_user_started(self):
        self.accept_request(object())
        self.spoken_origin = (self._indicator_reply, self.input_epoch())
        self._indicator_user = True
        self._indicator_output = False
        self._indicator_pending = False
        self.refresh_indicator()

    def indicator_reply_finished(self, token):
        if token is self._indicator_reply:
            self._indicator_pending = False
            self.refresh_indicator()

    def begin_reply(self, token):
        if self._reply is not None:
            self._reply.finish(interrupted=True)
        self._reply = ReplyProgress(token, feed=self.conversation, feed_open=self.admitted, on_finish=self._reply_closed)

    def current_reply(self):
        return self._reply

    def _reply_for(self, token):
        record = self._reply
        return record if record is not None and record.token is token else ReplyProgress.silent(token)

    def _reply_closed(self, record):
        if self._reply is record:
            self._reply = None
        if record.completed:
            self.retire_outcomes(record.token)

    def _labelled(self, frame, token):
        frame.reply_progress = self._reply_for(token)
        return frame

    def remember_assistant_reply(self, text):
        token = self._assistant_reply_token
        if (self.admitted() and isinstance(text, str) and text.strip()
                and (self.owns_request(token) or (token is not None and token is self._heard_prefix_token
                     and self._last_spoken_token is not self._indicator_reply))):
            self.last_spoken_reply = text
            self._last_spoken_token = token

    def conversation_output(self, frame):
        if isinstance(frame, (TTSStartedFrame, LLMFullResponseStartFrame)):
            self._assistant_reply_token = token_of(frame)
        record = getattr(frame, 'reply_progress', None)
        if (record is not None and self.admitted()
                and (isinstance(frame, InterruptionFrame) or self.owns_request(record.token))):
            record.output_frame(frame)
        self.observe_announcement(frame)
        if self.owns_request(self._assistant_reply_token) and isinstance(frame, TTSTextFrame) and not frame.append_to_context and frame.text.strip():
            self.last_spoken_reply = frame.text
            self._last_spoken_token = self._assistant_reply_token

    def conversation_audio(self, entries):
        for section, start, end in entries:
            if self.admitted() and self.owns_request(section.reply.token):
                section.reply.credit(section, start, end)

    def observe_announcement(self, frame):
        if self._announcement is None:
            return
        token, marker, _ = self._announcement
        if frame is marker:
            # A TTSStoppedFrame alone can be Pipecat's idle-timeout stop while synthesis continues.
            record = getattr(frame, 'reply_progress', None)
            self.end_announcement('played' if record is not None and record is self.current_reply() and record.token is token
                                  and record.delivered and not record.output_failed() else 'not fully played')
        elif isinstance(frame, InterruptionFrame) and token_of(frame) is token:
            # The turn's own earlier interruption carries the previous reply's record and must not release.
            self.end_announcement('interrupted')
        elif isinstance(frame, ConversationSynthesisFailedFrame) and token_of(frame) is token:
            self.end_announcement('synthesis failed')

    def end_announcement(self, outcome):
        if self._announcement is not None and not self._announcement[2].done():
            self._announcement[2].set_result(outcome)

    async def push_reply_end(self, token, *, failed=False):
        if not self.owns_request(token):
            return
        end = self._labelled(LLMFullResponseEndFrame(), token)
        # The output queue, not generation completion, owns the visible reply's end.
        end.reply_progress.answer_failed |= failed
        await self.push_frame(end)

    async def push_local_speech(self, message, token):
        if self._reply is None or self._reply.token is not token:
            self.begin_reply(token)
        await self.push_frame(self._labelled(TTSSpeakFrame(message, append_to_context=False), token))

    async def speak_local_reply(self, message, token):
        if not self.owns_request(token):
            return
        await self.push_local_speech(message, token)
        await self.push_reply_end(token)

    async def announce_first(self, token, message, run, *, command):
        outcome = 'request superseded'
        if self.owns_request(token):
            marker = AnnouncementMarkFrame()
            played = asyncio.get_running_loop().create_future()
            self._announcement = (token, marker, played)
            try:
                await self.push_local_speech(message, token)
                # Labelled once the announcement's record is open, so the marker carries that live record.
                await self.push_frame(self._labelled(marker, token))
                outcome = await asyncio.wait_for(played, ANNOUNCEMENT_TIMEOUT)
            except TimeoutError:
                outcome = 'timed out'
            finally:
                self._announcement = None
        if outcome != 'played':
            logger.warning(f'Playback of {message!r} was not confirmed: {outcome}')
        return await run(command=command)

    def retire_outcomes(self, token):
        self.outcomes = [item for item in self.outcomes if item.reporter is not token or item.result is None]

    async def run_shared(self, tool, *, epoch, reporter, finished=None):
        outcome = ActionOutcome(tool.subject, reporter)

        def observe(result):
            if result is None:
                self.outcomes.append(outcome)
            else:
                outcome.result = result
                if finished is not None:
                    finished(result)

        return await self.local_actions.run(
            tool, admitted=lambda: self.admitted() and epoch == self.stop_epoch, observe=observe,
        )

    async def desktop_call(self, turn, token, output, name, arguments) -> str:
        def advise(text):
            if self.channel.output is output and self.owns_request(token):
                output.put_nowait({'advisory': text})

        if not valid_desktop_arguments(name, arguments):
            turn.closed = True
            advise("I couldn't use that request, so I didn't do it.")
            return brain_result(False, False, 'invalid arguments')
        if name in turn.names:
            return brain_result(False, False, 'already attempted')
        turn.names.add(name)

        def record(content):
            turn.records.append({'role': 'tool', 'name': name, 'arguments': deepcopy(arguments), 'content': content,
                                 'source': KESTREL_SOURCE})
            return content

        if turn.closed:
            return record(brain_result(False, False, 'turn closed'))
        spec = TOOL_CATALOGUE[name]
        tool = free_tool(name, *(arguments[key] for key in spec.bounds))
        if tool is None:
            turn.closed = True
            advise("That needs permission, which isn't available by voice yet, so I didn't do it.")
            return record(brain_result(False, False, 'permission required'))
        if tool.lookup is not None:
            selected = tool
            try:
                tool = await resolve_local_tool(selected, command=self.local_actions.command)
            except (ValueError, RuntimeError, OSError, TimeoutError):
                turn.closed = True
                reason, advisory = selected.lookup_failure
                advise(advisory)
                return record(brain_result(False, False, reason))
            if tool is None:
                turn.closed = True
                reason, advisory = selected.lookup_miss
                advise(advisory)
                return record(brain_result(False, False, reason))
        result = await self.run_shared(
            tool, epoch=turn.epoch, reporter=token,
            finished=lambda result: record(brain_result(effect_observed(result), result.attempted, result.reason)),
        )
        if result is None:
            reason = 'stopped' if turn.epoch != self.stop_epoch else 'conversation ended'
            return record(brain_result(False, False, reason))
        if not effect_observed(result):
            turn.closed = True
            advise(local_result_message(tool, result))
        return brain_result(effect_observed(result), result.attempted, result.reason)

    def revoke(self):
        self.channel.detach(self.output)
        self.output = None
        self.last_spoken_reply = None
        if self.lookup is not None:
            self.lookup.cancel()
        if not self.admitted():
            self.end_announcement('conversation ended')

    async def process_frame(self, frame, direction):
        user_request = isinstance(frame, LLMContextFrame) and direction == FrameDirection.DOWNSTREAM and not frame.speculation
        if user_request and not self.valid_origin(frame):
            return
        if isinstance(frame, InterruptionFrame) and direction == FrameDirection.DOWNSTREAM:
            # The first user turn ordinarily interrupts before any reply exists.
            frame.reply_progress = self.current_reply()
            if frame.reply_progress is not None:
                frame.reply_progress.interrupting = True
        await super().process_frame(frame, direction)
        if not isinstance(frame, LLMContextFrame):
            await self.push_frame(frame, direction)
            return
        if not user_request or not self.valid_origin(frame):
            return
        token, source, original, text, _ = frame.request_origin
        self._indicator_user = False
        self._indicator_pending = True
        self.refresh_indicator()
        messages = frame.context.get_messages()

        def remove_original():
            for index, message in enumerate(messages):
                if message is original:
                    del messages[index]
                    break

        if self.conversation is not None:
            self.conversation.user(text, source=source)
        if source == 'typed':
            self.typed_origin = None
            if self.request_admitted is not None:
                self.request_admitted(token)
        if re.fullmatch(r"that(?:['’]?s| is) all[.!]?", text.strip().lower()):
            # Dismissal discards this context and revokes reply ownership, so no reply end or history removal follows.
            self.dismiss()
            return
        if re.fullmatch(r'(stop|cancel)[.!]?', text.strip().lower()):
            self.stop_epoch += 1
            if self._reply is not None:
                self._reply.finish(interrupted=True)
            remove_original()
            self.outcomes = [item for item in self.outcomes
                             if item.result is None or effect_observed(item.result) or item.result.attempted]
            account = stop_account(self.outcomes)
            if account is None:
                await self.push_reply_end(token)
            else:
                for item in self.outcomes:
                    if item.result is not None:
                        item.reporter = token
                await self.speak_local_reply(account, token)
            return
        if re.fullmatch(r'repeat that[.!?]?', text.strip().lower()):
            remove_original()
            await self.speak_local_reply(self.last_spoken_reply or "I haven't said anything to repeat yet.", token)
            return
        if re.fullmatch(r'what can i say[.!?]?', text.strip().lower()):
            remove_original()
            await self.speak_local_reply(capability_help(), token)
            return
        tool = match_instant_tool(text)
        if tool is not None and tool.lookup is not None:
            lookup = asyncio.create_task(resolve_local_tool(tool, command=self.local_actions.command))
            self.lookup = self.local_actions.retain(lookup)
            try:
                tool = await lookup
            except asyncio.CancelledError:
                remove_original()
                raise
            except (ValueError, RuntimeError, OSError, TimeoutError):
                remove_original()
                await self.speak_local_reply(tool.lookup_failure[1], token)
                return
        if tool is not None:
            if not self.valid_origin(frame):
                return
            remove_original()
            if tool.announcement is not None:
                tool = replace(tool, run=partial(self.announce_first, token, tool.announcement, tool.run))
            # LocalActions owns an accepted action independently of later reply ownership.
            if tool.counts_toward_stop:
                result = await self.run_shared(tool, epoch=self.stop_epoch, reporter=token)
            else:
                result = await self.local_actions.run(tool, admitted=self.admitted)
            if result is None or not self.owns_request(token):
                return
            message = local_result_message(tool, result)
            if message is None:
                message = tool.confirmation
                if message is None:
                    self.retire_outcomes(token)
            if message is not None:
                await self.speak_local_reply(message, token)
            else:
                await self.push_reply_end(token)
            return
        output = None
        failed = False
        started = False
        request = None

        async def push_reply_start(delivery):
            if not self.owns_request(token):
                return
            if self._reply is None or self._reply.token is not token:
                self.begin_reply(token)
            start = self._labelled(LLMFullResponseStartFrame(), token)
            start.reply_progress.delivery = delivery
            await self.push_frame(start)

        try:
            ready = await asyncio.shield(self.session_ready)
            if not self.valid_origin(frame) or not ready:
                return
            await self.channel.drain()
            if not self.valid_origin(frame):
                return
            self.begin_reply(token)
            await self.start_processing_metrics()
            if self.channel.failure:
                raise RuntimeError(self.channel.failure)
            output = asyncio.Queue()
            self.output = output
            if not self.valid_origin(frame):
                return
            turn = BrainTurn(names=set(), user=original, epoch=self.stop_epoch, records=[])
            self.brain_turns.append(turn)
            history = []
            for message in frame.context.get_messages():
                history.append(deepcopy(message))
                for previous in self.brain_turns:
                    if previous.user is message:
                        history.extend(deepcopy(previous.records))
            request = asyncio.create_task(self.channel.exchange(
                history, output, admitted=lambda: self.owns_request(token),
                desktop=partial(self.desktop_call, turn, token, output),
            ))
            while event := await output.get():
                if not self.owns_request(token):
                    self.revoke()
                    return
                if 'advisory' in event:
                    if not started:
                        await push_reply_start('neutral')
                        started = True
                    await self.push_frame(self._labelled(SpeechAdvisoryFrame(' ' + event['advisory']), token))
                    failed = True
                elif not failed:
                    if 'delivery' in event:
                        await push_reply_start(event['delivery'])
                        started = True
                    else:
                        await self.push_frame(self._labelled(LLMTextFrame(event['text']), token))
            await request
            if self.owns_request(token) and self.channel.failure:
                raise RuntimeError(self.channel.failure)
        except Exception as error:
            failed = True
            logger.error(f'Hermes session cannot answer: {error}')
            advisory = self.channel.failure_advisory or "I couldn't reach Kestrel's engine. Restart Kestrel and try again."
            if not started:
                await push_reply_start('neutral')
                started = True
            if self.owns_request(token):
                await self.push_frame(self._labelled(SpeechAdvisoryFrame(' ' + advisory), token))
        finally:
            self.channel.detach(output)
            if self.output is output:
                self.output = None
            if request is not None:
                if not request.done():
                    request.cancel()
                await asyncio.gather(request, return_exceptions=True)
            await self.stop_processing_metrics()
            if not started:
                await push_reply_start('neutral')
            await self.push_reply_end(token, failed=failed)


class KnownTrouble(RuntimeError):
    def __init__(self, state, message):
        super().__init__(message)
        self.state = state


class ConversationUserAggregator(LLMUserAggregator):
    def __init__(self, context, *, params, input_paused):
        super().__init__(context, params=params)
        self.input_paused = input_paused

    async def process_frame(self, frame, direction):
        if self.input_paused() and isinstance(frame, (
            InputAudioRawFrame, TranscriptionFrame, InterimTranscriptionFrame,
            VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame,
            ProposedUserStartedSpeakingFrame, UserSpeakingFrame,
        )):
            return
        await super().process_frame(frame, direction)

    async def _on_user_turn_started(self, controller, strategy, params):
        # An admitted turn start can outlive input admission while cancelling its native stop timer.
        if not self.input_paused():
            await super()._on_user_turn_started(controller, strategy, params)

    async def _push_aggregation(self, *, run_llm=True):
        if self.input_paused():
            return ''
        return await super()._push_aggregation(run_llm=run_llm)

    async def reset_audio(self):
        await self.reset()
        controller = self._vad_controller
        if controller is not None:
            old = controller._vad_analyzer
            params, sample_rate = old.params, old.sample_rate
            await old.cleanup()
            fresh = SileroVADAnalyzer(params=params)
            fresh.set_sample_rate(sample_rate)
            # Pipecat 1.12 retains the analyzer and speech state on this controller.
            # FIFO drainage precedes replacement; keep its callbacks and idle task.
            controller._vad_analyzer = fresh
            controller._vad_state = VADState.QUIET
            controller._speech_activity_time = 0
            controller._last_audio_time = asyncio.get_running_loop().time()


class VoiceConversations:
    def __init__(self, *, status, conversation):
        self.status = status
        self.conversation = conversation
        self.recognizer = NemotronRecognizer()
        self.channel = HermesRequestChannel()
        self.local_actions = LocalActions()
        self.generation_lock = asyncio.Lock()
        self.model = None
        self.tts_model = None
        self.voice_factory = None
        self.preset = None
        self.desired_active = False
        self.changed = asyncio.Event()
        self.pipeline = None
        self.cleanup = None
        self.transport = None
        self.llm = None
        self.voice = None
        self.admission = None
        self.capture_owner = None
        self.session_ready = None
        self.failure = None
        self.trouble = None
        self.closed = False
        self.prepared = False
        self.transitioning = False
        self.lifecycle_changed = False
        self.pending_submit = None
        self.submission_task = None
        self.submission_ack = None
        self.input_epoch = 0
        self.ingress = None
        self.stt = None
        self.waiting_transport = None
        self.waiting_owner = None
        self.wake_detector = None
        self.wake_startup = None
        self.wake_interval = None
        self.wake_disabled = False
        self.wake_reply_token = None
        self.switching_output = False
        self.output_watch = None
        self.echo_revision = 0
        self.echo_owner = None
        self.echo_cleanup = None

    def invalidate_wake(self):
        self.wake_interval = None

    def wake_start(self, interval):
        if self.wake_interval is interval and not self.failure:
            self.toggle()

    def reply_finished(self, token):
        if token is self.wake_reply_token:
            self.wake_reply_token = None
            self.changed.set()

    def wake_failed(self):
        if not self.wake_disabled:
            self.wake_disabled = True
            self.invalidate_wake()
            logger.warning(WAKE_ADVICE)
            self.changed.set()

    async def open_waiting(self, interval):
        detector = self.wake_detector
        await detector.start()
        if self.wake_interval is not interval:
            return
        self.waiting_transport = LaptopAudioTransport(
            ECHO_REMOVAL, on_stopped=self.wake_failed,
            admitted=lambda: self.wake_interval is interval, input_admitted=lambda: False,
            capture_pcm=lambda pcm: detector.submit(pcm) if self.wake_interval is interval else None,
        )
        await self.waiting_transport.open()
        if self.waiting_transport.capture is not None:
            self.waiting_owner = self.status.remember_owner(self.waiting_transport.capture.pid)

    async def close_waiting(self):
        self.invalidate_wake()
        if self.wake_startup is not None:
            self.wake_startup.cancel()
            await asyncio.gather(self.wake_startup, return_exceptions=True)
            self.wake_startup = None
        if self.waiting_transport is not None:
            await self.waiting_transport.close()
            if self.waiting_owner is not None:
                self.status.retire_owner(self.waiting_owner)
                self.waiting_owner = None
            self.waiting_transport = None
        if self.wake_detector is not None:
            await self.wake_detector.close()
            self.wake_detector = None

    def speech_admitted(self):
        return bool(self.admission is not None and self.admission.is_set() and self.desired_active
                    and self.pending_submit is None and not self.switching_output)

    def submit(self, text):
        if self.closed or self.failure or not self.prepared:
            return 'unavailable'
        if self.transitioning or self.lifecycle_changed or self.pending_submit is not None or self.switching_output:
            return 'busy'
        if self.transport is not None and self.ingress is None:
            return 'busy'
        token = object()
        self.input_epoch += 1
        self.invalidate_wake()
        self.wake_reply_token = token
        self.pending_submit = (text, token)
        if self.llm is not None:
            self.llm.accept_request(token)
        self.changed.set()
        return 'accepted'

    def typed_message_taken(self):
        return self.submission_ack is not None and self.submission_ack.done() and not self.submission_ack.cancelled()

    def fail_submission(self):
        if self.pending_submit is None:
            return
        text, token = self.pending_submit
        if not self.typed_message_taken():
            self.conversation.user(text, source='typed')
        ReplyProgress.failed_before_speech(token, self.conversation)

    def request_admitted(self, token):
        if self.pending_submit is not None and self.pending_submit[1] is token:
            if self.submission_ack is not None and not self.submission_ack.done():
                self.submission_ack.set_result(None)

    def ingress_ready(self, worker, user, context):
        self.ingress = (worker, user, context)
        self.changed.set()

    def toggle(self) -> str:
        return self.request_active(not self.desired_active)

    def request_active(self, active: bool) -> str:
        if self.failure or self.closed:
            return 'unavailable'
        self.desired_active = active
        self.lifecycle_changed = True
        self.revoke()
        if not active:
            self.conversation.clear()
        self.status.set_state('starting' if active else 'inactive')
        self.changed.set()
        return 'starting' if active else 'inactive'

    def revoke(self):
        self.invalidate_wake()
        self.wake_reply_token = None
        self.input_epoch += 1
        self.pending_submit = None
        if self.submission_task is not None and self.submission_task is not asyncio.current_task():
            self.submission_task.cancel()
        if self.submission_ack is not None and not self.submission_ack.done():
            self.submission_ack.cancel()
        if self.llm is not None:
            self.llm.typed_origin = None
            for future in self.llm.frame_completions.values():
                if not future.done():
                    future.cancel()
        if self.admission is not None:
            self.admission.clear()
        if self.llm is not None:
            self.llm.revoke()

    async def prepare(self):
        self.tts_model = os.environ.get('KESTREL_TTS_MODEL', 'phonon')
        if self.tts_model not in ('phonon', 'voxcpm2'):
            raise RuntimeError('Invalid KESTREL_TTS_MODEL. Select phonon or voxcpm2 and restart Kestrel.')
        self.preset = load_voice_preset(os.environ.get('KESTREL_VOICE', 'irish-female'))
        self.channel.preparation = asyncio.create_task(self.channel.prepare())
        await self.recognizer.load(self.preset.pcm)
        if self.tts_model == 'phonon':
            self.model = await asyncio.to_thread(load_phonon)
            self.voice_factory = partial(PhononTTS, self.model, generation_lock=self.generation_lock)
            logger.info('Kestrel speech provider: Phonon 31M English q8 CPU, public voice Bryony.')
        else:
            torch.set_num_threads(4)
            self.model = await asyncio.to_thread(
                VoxCPM.from_pretrained, str(ROOT / '.runtime/models/voxcpm2'),
                load_denoiser=False, optimize=False, device='cuda', local_files_only=True,
            )
            self.voice_factory = partial(VoxCPMTTS, self.model, self.preset, generation_lock=self.generation_lock)
            logger.info('Kestrel speech provider: VoxCPM2 CUDA, selected local reference voice.')
        voice = self.voice_factory()
        has_audio = False
        async for frame in voice.run_tts('Hello.', 'warmup'):
            has_audio |= bool(frame.audio)
        if not has_audio:
            raise RuntimeError(f'{self.tts_model} preparation produced no audio')
        self.prepared = True

    async def activate(self, *, capture_enabled=True):
        epoch = self.input_epoch
        await self.conversation.begin_session()
        if self.closed or self.lifecycle_changed or self.input_epoch != epoch or (capture_enabled and not self.desired_active):
            return
        self.admission = asyncio.Event()
        self.admission.set()
        admitted = self.admission.is_set
        self.session_ready = asyncio.create_task(self.channel.begin_conversation(admitted=admitted))
        self.transport = LaptopAudioTransport(ECHO_REMOVAL, on_stopped=self.failed_transport, admitted=admitted,
                                             input_admitted=self.speech_admitted, capture_enabled=capture_enabled,
                                             reply_admitted=lambda token: self.llm is not None and self.llm.owns_request(token))
        self.llm = HermesLLMService(self.channel, local_actions=self.local_actions, admitted=admitted, session_ready=self.session_ready,
                                    dismiss=partial(self.request_active, False), status=self.status, conversation=self.conversation, voice_active=lambda: self.desired_active,
                                    request_admitted=self.request_admitted, input_epoch=lambda: self.input_epoch)
        if self.pending_submit is not None:
            self.llm.accept_request(self.pending_submit[1])
        adapter = self.llm

        def readiness_finished(task):
            if not task.cancelled():
                task.exception()
            if self.llm is adapter and admitted():
                adapter.refresh_indicator()

        self.session_ready.add_done_callback(readiness_finished)
        self.voice = self.voice_factory(admitted=admitted, reply_admitted=self.llm.owns_request)
        await self.transport.open()
        if self.transport.capture is not None:
            self.capture_owner = self.status.remember_owner(self.transport.capture.pid)
        if not admitted():
            return
        self.stt = NemotronSTT(self.recognizer, admitted=self.speech_admitted, input_epoch=lambda: self.input_epoch)
        self.pipeline = asyncio.create_task(run_conversation(
            self.stt, self.voice, llm=self.llm,
            transport=self.transport, status=self.status, conversation=self.conversation, handle_signals=False,
            on_ingress_ready=self.ingress_ready, on_reply_finished=self.reply_finished,
            input_paused=lambda: self.switching_output,
        ))
        self.pipeline.add_done_callback(lambda task: self.changed.set())

    def record_failure(self, failure: str, trouble: str) -> None:
        self.failure = failure
        if self.trouble is None:
            self.trouble = trouble

    def failed_transport(self):
        failure = self.transport.failure
        # speech.py owns the transport failure vocabulary.
        self.record_failure(failure, {
            LAPTOP_CAPTURE_FAILURE: 'trouble-microphone', LAPTOP_PLAYBACK_FAILURE: 'trouble-playback',
        }.get(failure, 'trouble'))
        self.desired_active = False
        self.revoke()
        self.changed.set()

    async def finish_conversation(self):
        self.revoke()
        if self.submission_task is not None:
            await asyncio.gather(self.submission_task, return_exceptions=True)
            self.submission_task = None
        self.ingress = None
        closing = asyncio.create_task(self.transport.close()) if self.transport is not None else None
        if self.pipeline is not None:
            self.pipeline.cancel()
        outcomes = await asyncio.gather(
            *([closing] if closing is not None else []),
            *([self.pipeline] if self.pipeline is not None else []), return_exceptions=True,
        )
        if self.capture_owner is not None and (closing is None or closing.exception() is None):
            self.status.retire_owner(self.capture_owner)
            self.capture_owner = None
        readiness = await asyncio.gather(
            *([asyncio.shield(self.session_ready)] if self.session_ready is not None else []),
            return_exceptions=True,
        )
        native = await asyncio.gather(self.channel.drain(), return_exceptions=True)
        known_unavailable = self.channel.known_unavailable()
        if not known_unavailable:
            outcomes.extend(readiness)
            outcomes.extend(native)
        outcomes.extend(await asyncio.gather(
            self.recognizer.drain(), self.local_actions.drain(),
            *([asyncio.shield(self.channel.preparation)] if self.channel.preparation is not None else []),
            return_exceptions=True,
        ))
        async with self.generation_lock:
            pass
        if self.voice is not None and self.voice.generation_cleanup_failed:
            raise KnownTrouble('trouble-voice', 'Voice generation cleanup failed. Restart Kestrel.')
        if not self.closed and self.recognizer.failure:
            raise KnownTrouble('trouble-recognition', self.recognizer.failure)
        for outcome in outcomes:
            if isinstance(outcome, Exception):
                raise outcome
        if self.transport is not None and self.transport.failure:
            raise RuntimeError(self.transport.failure)
        self.transport = self.pipeline = self.llm = self.voice = self.admission = self.session_ready = None

    async def submit_pending(self):
        text, token = self.pending_submit
        worker, user, _ = self.ingress
        llm = self.llm
        completions = []

        async def completed(role, frame, queue):
            future = asyncio.get_running_loop().create_future()
            llm.frame_completions[(role, frame.id)] = future
            completions.append((role, frame.id))
            await queue(frame)
            await future

        try:
            async with asyncio.timeout(5):
                interruption = InterruptionFrame()
                output_done = asyncio.get_running_loop().create_future()
                assistant_done = asyncio.get_running_loop().create_future()
                for role, future in (('output', output_done), ('assistant', assistant_done)):
                    llm.frame_completions[(role, interruption.id)] = future
                    completions.append((role, interruption.id))
                await worker.queue_frame(interruption)
                await asyncio.gather(output_done, assistant_done)
                await self.stt.discard_pending()
                await user.reset()
                await completed('user', ProposedUserStoppedSpeakingFrame(), user.queue_frame)
                message = {'role': 'user', 'content': text}
                llm.typed_origin = (token, 'typed', message, text, self.input_epoch)
                self.submission_ack = asyncio.get_running_loop().create_future()
                await completed('user', LLMMessagesAppendFrame(messages=[message], run_llm=True), user.queue_frame)
                await self.submission_ack
                self.pending_submit = None
        except Exception:
            self.fail_submission()
            self.record_failure('Kestrel input handover failed. Restart Kestrel.', 'trouble-handover')
            self.desired_active = False
            self.revoke()
            self.status.set_state(self.trouble)
        finally:
            for key in completions:
                future = llm.frame_completions.pop(key, None)
                if future is not None and not future.done():
                    future.cancel()
            llm.typed_origin = None
            self.submission_ack = None
            self.changed.set()

    def output_changed(self):
        if not self.closed and not self.failure:
            self.switching_output = True
            self.invalidate_wake()
            self.changed.set()

    def output_watch_failed(self):
        if not self.closed:
            self.switching_output = True
            self.record_failure(OUTPUT_WATCH_FAILURE, 'trouble')
            self.changed.set()

    async def close_echo(self):
        if self.echo_cleanup is None:
            self.echo_cleanup = asyncio.create_task(asyncio.to_thread(ECHO_REMOVAL.close))
        try:
            await asyncio.shield(self.echo_cleanup)
        except asyncio.CancelledError:
            await self.echo_cleanup
            raise

    async def resume_output_capture(self, transport, selected):
        resume = asyncio.create_task(transport.resume_capture(output_serial=selected))
        notice = None
        try:
            while not resume.done():
                if (self.closed or self.failure or self.lifecycle_changed
                        or self.output_watch.revision != self.echo_revision):
                    resume.cancel()
                    break
                # No await separates this clear from checking revisions above;
                # any later notice wakes the retained waiter or is checked next.
                self.changed.clear()
                notice = asyncio.create_task(self.changed.wait())
                try:
                    await asyncio.wait((resume, notice), return_when=asyncio.FIRST_COMPLETED)
                finally:
                    notice.cancel()
                    await asyncio.gather(notice, return_exceptions=True)
                    notice = None
        finally:
            if notice is not None:
                notice.cancel()
                await asyncio.gather(notice, return_exceptions=True)
            if not resume.done():
                resume.cancel()
            try:
                await resume
            except asyncio.CancelledError:
                if asyncio.current_task().cancelling():
                    raise
        return not (self.closed or self.failure or self.lifecycle_changed
                    or self.output_watch.revision != self.echo_revision)

    async def refresh_output(self):
        async def fifo(processor, frame):
            completed = asyncio.Event()

            async def observed(processor, frame, direction):
                completed.set()

            await processor.queue_frame(frame, callback=observed)
            await completed.wait()

        def interrupted():
            return self.closed or self.failure is not None or self.lifecycle_changed

        try:
            async with asyncio.timeout(30):
                if self.submission_task is not None:
                    await asyncio.shield(self.submission_task)
                if interrupted():
                    return
                await self.close_waiting()
                if interrupted():
                    return
                transport = self.transport
                if transport is not None:
                    await transport.suspend_capture()
                    if self.capture_owner is not None:
                        self.status.retire_owner(self.capture_owner)
                        self.capture_owner = None
                    if interrupted():
                        return
                    await transport.input().drain_audio()
                    if interrupted():
                        return
                    if self.stt is not None and self.ingress is not None:
                        await self.stt.discard_pending()
                        await fifo(self.stt, Frame())
                        await fifo(self.ingress[1], Frame())
                        await self.recognizer.drain()
                        if interrupted():
                            return
                        await self.ingress[1].reset()
                        await fifo(self.ingress[1], ProposedUserStoppedSpeakingFrame())
                        await self.ingress[1].reset_audio()
                while not interrupted():
                    await self.close_echo()
                    if self.echo_owner is not None:
                        self.status.retire_owner(self.echo_owner)
                        self.echo_owner = None
                    if interrupted():
                        return
                    self.echo_revision = self.output_watch.revision
                    ECHO_REMOVAL.start(self.echo_stopped)
                    self.echo_cleanup = None
                    self.echo_owner = self.status.remember_owner(ECHO_REMOVAL.process.pid)
                    while not interrupted() and self.output_watch.revision == self.echo_revision:
                        try:
                            selected = await ECHO_REMOVAL.output_serial()
                            break
                        except PipeWireGraphCleanupFailure:
                            raise
                        except RuntimeError:
                            if interrupted():
                                return
                            if self.output_watch.revision != self.echo_revision:
                                break
                            await asyncio.sleep(0.5)
                    if interrupted():
                        return
                    if self.output_watch.revision != self.echo_revision:
                        continue
                    if transport is not None and transport.capture_enabled:
                        stable = await self.resume_output_capture(transport, selected)
                        if interrupted():
                            return
                        if not stable:
                            # Superseded startup has reaped its input before another generation.
                            await transport.suspend_capture()
                            continue
                        if transport.capture is not None:
                            self.capture_owner = self.status.remember_owner(transport.capture.pid)
                        if interrupted():
                            return
                    while not interrupted() and self.output_watch.revision == self.echo_revision:
                        playback = transport.playback if transport is not None else None
                        try:
                            latest = await ECHO_REMOVAL.output_serial(
                                playback.pid if playback is not None and playback.returncode is None else None,
                            )
                        except PipeWireGraphCleanupFailure:
                            raise
                        except RuntimeError:
                            if interrupted():
                                return
                            if self.output_watch.revision != self.echo_revision:
                                break
                            await asyncio.sleep(0.5)
                            if interrupted():
                                return
                            continue
                        if interrupted():
                            return
                        if self.output_watch.revision != self.echo_revision or latest != selected:
                            break
                        # Playback can appear during graph I/O; verify that exact child too.
                        if transport is not None and transport.playback is not playback:
                            continue
                        self.switching_output = False
                        if self.llm is not None:
                            self.llm.refresh_indicator()
                        return
                    if transport is not None:
                        await transport.suspend_capture()
                        if self.capture_owner is not None:
                            self.status.retire_owner(self.capture_owner)
                            self.capture_owner = None
        except Exception:
            self.record_failure(OUTPUT_SWITCH_FAILURE, 'trouble')
            self.desired_active = False
            self.revoke()
            self.changed.set()

    async def run(self):
        self.status.set_state('inactive')
        self.changed.set()
        while not self.closed:
            await self.changed.wait()
            self.changed.clear()
            try:
                if self.switching_output and not self.lifecycle_changed and not self.failure:
                    await self.refresh_output()
                if self.wake_startup is not None and self.wake_startup.done():
                    if not self.wake_startup.cancelled() and self.wake_startup.exception() is not None:
                        self.wake_failed()
                if (self.wake_detector is not None and
                        (self.desired_active or self.pending_submit is not None or self.wake_disabled
                         or self.lifecycle_changed or self.failure or self.wake_reply_token is not None)):
                    await self.close_waiting()
                if self.submission_task is not None and self.submission_task.done():
                    if not self.submission_task.cancelled():
                        self.submission_task.result()
                    self.submission_task = None
                if self.failure and self.cleanup is not None:
                    self.status.set_state(self.trouble)
                    continue
                stopped = self.pipeline is not None and self.pipeline.done() and self.admission.is_set()
                if stopped:
                    # A stopped pipeline is a symptom: the cleanup below classifies it.
                    self.failure = 'Kestrel conversation stopped unexpectedly. Restart Kestrel.'
                if self.transport is not None and (self.lifecycle_changed or self.failure):
                    self.transitioning = True
                    self.cleanup = asyncio.create_task(self.finish_conversation())
                    await asyncio.wait_for(asyncio.shield(self.cleanup), 90)
                if self.failure:
                    raise RuntimeError(self.failure)
                self.lifecycle_changed = False
                if self.switching_output:
                    self.changed.set()
                    continue
                if self.transport is None and (self.desired_active or self.pending_submit is not None):
                    self.transitioning = True
                    self.cleanup = None
                    await self.activate(capture_enabled=self.desired_active)
                self.transitioning = False
                if self.pending_submit is not None and self.ingress is not None and self.submission_task is None:
                    self.submission_task = asyncio.create_task(self.submit_pending())
                if not self.desired_active:
                    self.status.set_state('inactive')
                    if self.prepared and not self.switching_output and not self.wake_disabled and self.pending_submit is None and self.wake_reply_token is None and self.wake_detector is None:
                        interval = object()
                        self.wake_interval = interval
                        self.wake_detector = WakeWordDetector(
                            on_detected=lambda interval=interval: self.wake_start(interval), on_failed=self.wake_failed,
                        )
                        self.wake_startup = asyncio.create_task(self.open_waiting(interval))
                        self.wake_startup.add_done_callback(lambda task: self.changed.set())
            except Exception as error:
                self.fail_submission()
                self.record_failure(str(error) or 'Kestrel conversation cleanup failed. Restart Kestrel.',
                                    error.state if isinstance(error, KnownTrouble) else 'trouble')
                self.desired_active = False
                self.revoke()
                self.status.set_state(self.trouble)

    async def close(self):
        self.closed = True
        self.desired_active = False
        self.revoke()
        self.changed.set()
        try:
            try:
                await self.close_waiting()
            finally:
                try:
                    await self.local_actions.close()
                finally:
                    try:
                        await self.channel.close()
                    finally:
                        await self.recognizer.close()
        finally:
            if self.cleanup is not None:
                await asyncio.shield(self.cleanup)
            elif self.transport is not None:
                await self.finish_conversation()


async def run_conversation(stt, voice: ConversationTTS, *, llm, transport, user_params=None, handle_signals=False, status=None, conversation=None, on_ingress_ready=None, on_reply_finished=None, input_paused=lambda: False):
    if user_params is None:
        user_params = LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(params=VADParams(confidence=0.5)), empty_user_turn=None,
            user_turn_strategies=UserTurnStrategies(stop=[
                TurnAnalyzerUserTurnStopStrategy(
                    turn_analyzer=LocalSmartTurnAnalyzerV3(params=SmartTurnParams(stop_secs=0.6)),
                ),
                TypedTurnStopStrategy(),
            ]),
        )
    context = LLMContext([])
    user = ConversationUserAggregator(context, params=user_params, input_paused=input_paused)
    # Pipecat 1.12 pairs the assistant back to its exact user for native context flushing.
    assistant = LLMAssistantAggregator(context, _paired_user_aggregator=user)
    llm.conversation = conversation
    if status is not None or conversation is not None:
        llm.status = status

        @transport.input().event_handler('on_after_process_frame')
        async def indicator_input_ready(processor, frame):
            if isinstance(frame, StartFrame):
                llm.indicator_input_ready()

    @user.event_handler('on_before_push_frame')
    async def indicator_user_turn(processor, frame):
        if isinstance(frame, UserStartedSpeakingFrame) and stt.admitted():
            llm.indicator_user_started()
        elif isinstance(frame, UserStoppedSpeakingFrame):
            llm.indicator_user_stopped()
        elif isinstance(frame, LLMContextFrame) and not frame.speculation:
            messages = frame.context.get_messages()
            if messages and messages[-1].get('role') == 'user':
                message = messages[-1]
                if llm.typed_origin is not None and llm.typed_origin[2] is message:
                    frame.request_origin = llm.typed_origin
                elif llm.spoken_origin is not None:
                    token, epoch = llm.spoken_origin
                    frame.request_origin = (token, 'spoken', message, message.get('content'), epoch)

    @user.event_handler('on_after_process_frame')
    async def user_frame_completed(processor, frame):
        llm.frame_completed('user', frame)
        if isinstance(frame, StartFrame) and on_ingress_ready is not None:
            on_ingress_ready(worker, processor, context)

    @assistant.event_handler('on_before_process_frame')
    async def assistant_frame_starting(processor, frame):
        if isinstance(frame, InterruptionFrame):
            llm._heard_prefix_token = token_of(frame)

    @assistant.event_handler('on_after_process_frame')
    async def assistant_frame_completed(processor, frame):
        if isinstance(frame, InterruptionFrame):
            llm._heard_prefix_token = None
        llm.frame_completed('assistant', frame)

    output = transport.output()

    @output.event_handler('on_before_process_frame')
    async def output_frame_entering(processor, frame):
        output.output_buffer.enter(frame, llm.current_reply())

    @output.event_handler('on_after_process_frame')
    async def output_frame_completed(processor, frame):
        # The transport drops its chunk queue for these, keeping the unchunked remainder.
        if isinstance(frame, (InterruptionFrame, CancelFrame)):
            output.output_buffer.queue_dropped()
        llm.frame_completed('output', frame)

    @assistant.event_handler('on_before_push_frame')
    async def remember_assistant_reply(processor, frame):
        if isinstance(frame, LLMContextFrame):
            messages = frame.context.get_messages()
            if messages and messages[-1].get('role') == 'assistant':
                llm.remember_assistant_reply(messages[-1].get('content'))

    @output.event_handler('on_after_push_frame')
    async def on_output_frame(processor, frame):
        # The transport pushes audio only after its write succeeded.
        if isinstance(frame, OutputAudioRawFrame):
            llm.conversation_audio(output.output_buffer.written(frame))
        elif isinstance(frame, BotStoppedSpeakingFrame):
            output.output_buffer.stopped_speaking(frame)
        if voice.generation_cleanup_failed:
            llm.indicator_voice_failed()
        if status is not None or conversation is not None:
            if isinstance(frame, BotStartedSpeakingFrame):
                llm.indicator_output_started()
            elif isinstance(frame, BotStoppedSpeakingFrame):
                llm.indicator_output_stopped()
            elif isinstance(frame, LLMFullResponseEndFrame):
                llm.indicator_reply_finished(token_of(frame))
        llm.conversation_output(frame)
        if isinstance(frame, LLMFullResponseEndFrame) and on_reply_finished is not None:
            on_reply_finished(token_of(frame))

    pipeline = Pipeline([
        transport.input(), stt, user, llm,
        voice, output, assistant,
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
    orderly = False
    status = IndicatorStatus()
    status.set_state('starting')
    conversation = ConversationFeed()
    conversations = VoiceConversations(status=status, conversation=conversation)
    control = ConversationControl(conversations.toggle, submit=conversations.submit)
    heartbeat = asyncio.create_task(status.heartbeat())
    watcher = OutputDeviceWatch()
    conversations.output_watch = watcher

    def cancel():
        nonlocal stopping
        if not stopping:
            stopping = True
            conversations.revoke()
            task.cancel()

    def echo_stopped():
        nonlocal echo_failure
        echo_failure = 'Echo removal has stopped. Restart Kestrel.'
        stop_kestrel()

    try:
        # Owning the command endpoint precedes microphone/model preparation.
        await control.start()
        await conversation.start()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, cancel)
        conversations.echo_stopped = echo_stopped
        await watcher.start(conversations.output_changed, conversations.output_watch_failed)
        conversations.echo_revision = watcher.revision
        ECHO_REMOVAL.start(echo_stopped)
        if ECHO_REMOVAL.process is not None:
            conversations.echo_owner = status.remember_owner(ECHO_REMOVAL.process.pid)
        try:
            await conversations.prepare()
            await conversations.run()
        except asyncio.CancelledError:
            orderly = stopping
        else:
            orderly = True
    finally:
        try:
            try:
                await watcher.close()
            finally:
                try:
                    await conversations.close()
                finally:
                    await conversations.close_echo()
            if orderly and echo_failure is None and not conversations.failure:
                status.mark_released()
            else:
                status.set_state('unavailable')
        except BaseException:
            status.set_state('unavailable')
            raise
        finally:
            await control.close()
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)
            await conversation.close()
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.remove_signal_handler(sig)
    if echo_failure:
        raise RuntimeError(echo_failure)


if __name__ == "__main__":
    asyncio.run(run_voice_service())
