import asyncio
import io
import json
import wave
import os
import signal
import sys
import tempfile
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, Mock, patch

import numpy as np
from pipecat.audio.vad.vad_analyzer import VADState
from pipecat.frames.frames import (
    DataFrame, LLMFullResponseEndFrame, InterruptionFrame, LLMContextAssistantTurnFrame, LLMContextFrame,
    ProposedUserStartedSpeakingFrame, ProposedUserStoppedSpeakingFrame, StartFrame, TranscriptionFrame, TTSTextFrame,
)
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.transports.base_transport import TransportParams
from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies

from admission import Admission
import bot
import speech
from test_hermes import ROOT, WorkerProcess, require_native_hermes


# Production worker-startup budget, read at import so tests that patch bot.ENGINE_TIMEOUT cannot shrink it.
ENGINE_STARTUP = bot.ENGINE_TIMEOUT
# Owner-approved wording, an oracle independent of bot's engine advice.
ENGINE_MISSING_ADVICE = ("Kestrel's engine is missing, has changed or couldn't be checked, so I can't answer questions, "
                         "keep notes or choose desktop tools. Exact commands like mute still work. Reinstall the engine "
                         "as the manual describes, then restart Kestrel.")
# The worker's refusals for a missing or changed engine, an oracle independent of hermes_worker.
SOURCE_IDENTITY_REFUSAL = ('Hermes source identity could not be verified. '
                           'Reinstall the pinned Hermes 0.22.2 runtime and restart Kestrel.')
ENGINE_LOAD_REFUSAL = 'Hermes engine files could not be loaded. Reinstall the pinned Hermes 0.22.2 runtime and restart Kestrel.'


def hermes_service(*, local_command=None):
    session_ready = asyncio.get_running_loop().create_future()
    session_ready.set_result(True)
    return bot.HermesLLMService(
        bot.HermesRequestChannel(), local_actions=bot.LocalActions(command=local_command),
        admission=Admission(voice=True, output_switching=lambda: False), session_ready=session_ready,
        dismiss=Mock(side_effect=AssertionError("Only an exact that's all turn ends the conversation")),
    )


def request_frame(service, context, *, speculation=None):
    frame = LLMContextFrame(context, speculation=speculation)
    messages = context.get_messages()
    if messages and messages[-1].get('role') == 'user':
        message = messages[-1]
        ticket, mark = service.admission.accept_spoken()
        frame.request_origin = (ticket, 'spoken', message, message.get('content'), mark)
    return frame


def microphone_admitted(manager):
    return manager.admission is not None and manager.admission.admits_microphone()


ANSWER_SPEECH, ANSWER_QUIET = b'Y' * 640, b'q' * 640


def answer_vad(*, params=None):
    """A VAD double that hears speech only in ANSWER_SPEECH frames and records every frame it analyses."""
    vad = Mock(params=params, sample_rate=16000, cleanup=AsyncMock(), analysed=[])

    async def analyse(audio):
        vad.analysed.append(audio)
        return VADState.SPEAKING if audio == ANSWER_SPEECH else VADState.QUIET

    vad.analyze_audio = analyse
    return vad


def deletion_question(note):
    return f"I'm about to delete the note: {note}. Shall I?"


def answer_frames(wav):
    with wave.open(io.BytesIO(wav)) as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, 16000):
            raise AssertionError('Answer audio must be 16 kHz mono 16-bit')
        return audio.readframes(audio.getnframes())


async def wait_until(predicate, message):
    try:
        async with asyncio.timeout(5):
            while not predicate():
                await asyncio.sleep(0.005)
    except TimeoutError:
        raise AssertionError(message) from None


class WholeConversationCase(unittest.IsolatedAsyncioTestCase):
    async def hear_exactly(self, spoken, expected):
        """Collects spoken text until it reads exactly `expected`; any other text fails at once."""
        heard = ''
        while heard != expected:
            part = await asyncio.wait_for(spoken.get(), 5)
            heard = f'{heard} {part}' if heard else part
            self.assertTrue(expected.startswith(heard), f'Heard {heard!r} where {expected!r} was due')

    async def speak_request(self, transport, text):
        if transport.capture is not None:
            # Fresh capture audio keeps the five second capture stall bound away from the turn.
            transport.capture.stdout.feed_data(bytes(640))
        transport.output().generation_done.clear()
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, text)

    async def reply_finished(self, transport, spoken):
        await asyncio.wait_for(transport.output().generation_done.wait(), 5)
        barrier = DataFrame()
        await transport.service.manager.voice.queue_frame(barrier)
        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
        self.assertTrue(spoken.empty(), 'Nothing more is spoken for this request')

    async def open_session(self, brain, *, wire=None, local_command=None, prepare_engine=False, status=None,
                           synthesis_chunks=None, through_service=False, channel=None, local_actions=None,
                           admitted=None, activate=True, native_audio=False, trace_root=None, memory_root=None, native_events=None,
                           production_turn_strategies=False, wake_wire=None, tts_model='voxcpm2', vad_factory=None,
                           startup=None):
        if startup is None:
            # With neither brain nor wire the stub spawn below raises OSError, a generic engine failure.
            startup = 'trouble-engine' if brain is None and wire is None else 'inactive'
        if brain is not None:
            require_native_hermes()
        from desktop import control, status as status_module
        from types import SimpleNamespace
        started, prepared = asyncio.Queue(), asyncio.Event()
        waiting = asyncio.Queue()
        acknowledgement_time = [100.0]
        acknowledgement_timers = asyncio.Queue()
        wake_children = []
        native_written = asyncio.Event()
        spoken, committed, processed = asyncio.Queue(), asyncio.Queue(), asyncio.Queue()
        interrupted = asyncio.Event()
        sessions, processes, bindings, audio_children = [], [], [], []
        controller = None
        service_task = None
        completion_observed = False
        handlers = {}
        runtime = os.environ.get('XDG_RUNTIME_DIR', '')
        owned_runtimes = getattr(self, '_service_runtimes', set())
        self._service_runtimes = owned_runtimes
        if not runtime.startswith('/tmp/') or runtime in owned_runtimes:
            home = tempfile.TemporaryDirectory(prefix='kestrel-service-test-')
            self.addCleanup(home.cleanup)
            runtime = home.name
            owned_runtimes.add(runtime)
        environment = patch.dict(os.environ, XDG_RUNTIME_DIR=runtime)
        environment.start()
        bindings.append(environment)
        self.addCleanup(environment.stop)
        if tts_model is None:
            os.environ.pop('KESTREL_TTS_MODEL', None)
        else:
            os.environ['KESTREL_TTS_MODEL'] = tts_model
        proc_home = tempfile.TemporaryDirectory(prefix='kestrel-proc-test-')
        self.addCleanup(proc_home.cleanup)
        proc_root = Path(proc_home.name)
        boot = proc_root / 'sys/kernel/random'
        boot.mkdir(parents=True)
        (boot / 'boot_id').write_text('12345678-1234-1234-1234-123456789abc')

        def identity(pid):
            folder = proc_root / str(pid)
            folder.mkdir(exist_ok=True)
            (folder / 'stat').write_text(f'{pid} (fixture) S ' + '0 ' * 18 + str(pid + 1000) + ' 0\n')
            return folder

        identity(os.getpid())
        identity(70001)
        echo_generations = []
        output_watch = SimpleNamespace(revision=0, on_change=None, on_failed=None)

        async def watch_start(on_change, on_failed):
            output_watch.on_change, output_watch.on_failed = on_change, on_failed

        def output_changed():
            output_watch.revision += 1
            if output_watch.on_change is not None:
                output_watch.on_change()

        output_watch.start = AsyncMock(side_effect=watch_start)
        output_watch.close = AsyncMock()
        output_watch.emit = output_changed

        def echo_start(on_stopped):
            pid = 70001 + len(echo_generations)
            identity(pid)
            process = Mock(pid=pid, poll=Mock(return_value=None))
            bot.ECHO_REMOVAL.process = process
            echo_generations.append(process)

        def echo_close():
            process = bot.ECHO_REMOVAL.process
            if process is not None:
                process.poll.return_value = 0
                folder = proc_root / str(process.pid)
                (folder / 'stat').unlink(missing_ok=True)
                if folder.exists():
                    folder.rmdir()
        supplied_channel = channel if channel is not None else bot.HermesRequestChannel()
        actions = local_actions if local_actions is not None else bot.LocalActions(command=local_command)
        recognizer = speech.NemotronRecognizer()
        recognizer.load = AsyncMock(side_effect=lambda pcm: prepared.set())
        recognizer.close = AsyncMock(wraps=recognizer.close)
        preset = speech.VoicePreset(Path('/fixture/british-male.wav'), 'British fixture.', bytes(9600))
        calls = 0

        def chunks(**kwargs):
            nonlocal calls
            calls += 1
            if calls <= 3:
                self.assertEqual(kwargs['text'], ('One moment.', 'Just a moment.', 'Give me a moment.')[calls - 1])
                yield np.zeros(4800, dtype=np.float32)
            elif synthesis_chunks is not None:
                yield from synthesis_chunks(**kwargs)
            else:
                self.assertEqual(kwargs['prompt_text'], 'British fixture.')
                yield np.zeros(4800, dtype=np.float32)

        if tts_model in (None, 'phonon'):
            def stream(text, *, voice, seed):
                self.assertEqual((voice, seed), ('bryony', 1234))
                native = Mock(sample_rate=24000, close=Mock())
                native.__iter__ = Mock(return_value=iter([np.zeros(2400, dtype=np.float32)]))
                return native

            model = Mock(stream=Mock(side_effect=stream))
        else:
            model = Mock(generate_streaming=chunks)
        native_stt = speech.NemotronSTT

        def new_stt(recognizer, *, admission):
            adapter = native_stt(recognizer, admission=admission)
            sessions[-1].stt = adapter
            return adapter

        native_spawn = asyncio.create_subprocess_exec

        async def spawn(*command, **kwargs):
            if any(str(arg).endswith('/wakeword.py') for arg in command):
                process = await native_spawn(sys.executable, '-u', '-c', wake_wire or
                    "import sys\nsys.stdout.buffer.write(b'R'); sys.stdout.buffer.flush()\n"
                    "while True:\n data=sys.stdin.buffer.read(640)\n if not data: break\n"
                    " sys.stdout.buffer.write(b'S\\x3f\\x80\\x00\\x00' if data == bytes([1])*640 else b'S\\x00\\x00\\x00\\x00'); sys.stdout.buffer.flush()", **kwargs)
                wake_children.append(process)
                return process
            self.assertEqual(command, (str(bot.HERMES_PYTHON), str(ROOT / 'hermes_worker.py')))
            home = Path(kwargs['env']['HERMES_HOME'])
            try:
                if wire is not None:
                    command = (sys.executable, '-c', wire)
                elif brain is None:
                    raise OSError('No controlled provider')
                else:
                    command = WorkerProcess.command(home, brain, trace_root=trace_root, memory_root=memory_root)
                process = await native_spawn(*command, **kwargs)
            except OSError:
                processes.append((None, home))
                raise
            processes.append((process, home))
            if native_events is not None:
                native_write = process.stdin.write

                def write(data):
                    native_events.append(('write', json.loads(data)))
                    native_written.set()
                    return native_write(data)

                process.stdin.write = write
            return process

        native_transport = speech.LaptopAudioTransport

        def child(*, capture):
            pid = 71000 + len(audio_children)
            folder = identity(pid)
            process = Mock(pid=pid, returncode=None, stdin=None, stdout=None)
            process.reaped = asyncio.Event()
            process.writes = []
            if capture:
                process.stdout = asyncio.StreamReader()
                process.stdout.feed_data(bytes(640))
            else:
                process.stdin = Mock()
                process.stdin.write.side_effect = process.writes.append
                process.stdin.drain = AsyncMock()
                process.stdin.wait_closed = AsyncMock()

            exited = asyncio.Event()
            if not capture:
                process.stdin.close.side_effect = exited.set
            process.kill.side_effect = exited.set
            process.terminate.side_effect = exited.set

            async def wait():
                await exited.wait()
                process.returncode = 0
                (folder / 'stat').unlink(missing_ok=True)
                if folder.exists():
                    folder.rmdir()
                process.reaped.set()
                return 0

            process.wait = AsyncMock(side_effect=wait)
            audio_children.append(process)
            return process

        def new_transport(echo, *, on_stopped, admission, capture_enabled=True, capture_pcm=None):
            def active():
                return (admission is None or admission.is_open()) and (admitted_override is None or admitted_override())

            if native_audio or capture_pcm is not None:
                transport = native_transport(echo, on_stopped=on_stopped, admission=admission,
                                             capture_enabled=capture_enabled, capture_pcm=capture_pcm)

                async def spawn_audio(*argv, **kwargs):
                    process = child(capture='--record' in argv)
                    process.wake_capture = capture_pcm is not None
                    return process

                transport._spawn = spawn_audio
                original_open = transport.open

                async def open_audio():
                    await original_open()
                    transport.llm = controller.llm
                    if capture_pcm is not None:
                        waiting.put_nowait(transport)

                transport.open = open_audio
                original_resume = transport.resume_capture

                async def resume_audio(*, output_serial):
                    await original_resume(output_serial=output_serial)
                    transport.llm = controller.llm
                    if capture_pcm is not None:
                        waiting.put_nowait(transport)

                transport.resume_capture = resume_audio
            else:
                class Input(FrameProcessor):
                    async def process_frame(self, frame, direction):
                        if isinstance(frame, DataFrame) and not (
                                capture_pcm is None and admission is not None and admission.admits_microphone()):
                            return
                        await super().process_frame(frame, direction)
                        await self.push_frame(frame, direction)

                class Output(speech.LaptopOutput):
                    def __init__(self):
                        params = TransportParams(audio_out_enabled=True, audio_out_sample_rate=48000)
                        super().__init__(transport, params)

                    async def play_cue(self, kind, *, token=None):
                        return active() and not transport.closed and (
                            admission.may_speak(token) if token is not None else capture_enabled)

                    async def _write_audio_locked(self, frame, record):
                        written = active() and not transport.closed and (admission is None or
                                  (record is not None and admission.may_speak(record.token)))
                        if written:
                            self.audio_written += 1
                        return written

                transport = Mock(capture=None, playback=None, failure=None, closed=False, admission=admission)
                transport.input.return_value = Input()
                transport.output.return_value = Output()

                async def open_playback():
                    transport.playback = object()

                async def discard_playback():
                    transport.playback = None

                transport._open_playback = AsyncMock(side_effect=open_playback)
                transport._discard_playback = AsyncMock(side_effect=discard_playback)

                async def open_audio():
                    transport.llm = controller.llm

                async def close_audio():
                    transport.closed = True
                    transport.output().write_gate.set()
                    await transport.output()._observe_acknowledgement_tasks()
                    await transport._discard_playback()

                transport.open = AsyncMock(side_effect=open_audio)
                transport.close = AsyncMock(side_effect=close_audio)
            output = transport.output()
            output.generation_done = asyncio.Event()
            output.audio_written = 0
            transport.processed = processed
            transport.sessions = sessions
            transport.audio_children = audio_children
            transport.service = service_handle
            transport.cleanup_finished = asyncio.get_running_loop().create_future()
            if capture_pcm is None:
                sessions.append(transport)

            @output.event_handler('on_after_process_frame')
            async def received(processor, frame):
                if isinstance(frame, StartFrame):
                    started.put_nowait(transport)
                elif isinstance(frame, LLMFullResponseEndFrame):
                    output.generation_done.set()

            @output.event_handler('on_after_push_frame')
            async def observe(processor, frame):
                if isinstance(frame, InterruptionFrame):
                    interrupted.set()
                elif type(frame) is DataFrame:
                    processed.put_nowait(frame)
                elif active():
                    if isinstance(frame, TTSTextFrame):
                        spoken.put_nowait(frame.text)
                    elif isinstance(frame, LLMContextAssistantTurnFrame):
                        committed.put_nowait(frame.text.strip())

            return transport

        native_conversations = bot.VoiceConversations
        admitted_override = admitted
        service_handle = SimpleNamespace(sessions=sessions, audio_children=audio_children, started=started,
                                         recognizer=recognizer, model=model, channel=supplied_channel, native_written=native_written, waiting=waiting,
                                         output_watch=output_watch, echo_generations=echo_generations,
                                         acknowledgement_time=acknowledgement_time, acknowledgement_timers=acknowledgement_timers)

        def conversations(**kwargs):
            nonlocal controller
            controller = native_conversations(**kwargs)
            service_handle.manager = controller
            native_finish = controller.finish_conversation

            async def finish_conversation():
                transport = controller.transport
                try:
                    return await native_finish()
                finally:
                    if transport is not None and not transport.cleanup_finished.done():
                        transport.cleanup_finished.set_result(asyncio.current_task())

            controller.finish_conversation = finish_conversation
            return controller

        if native_events is not None:
            native_read = supplied_channel.read_event

            async def read_event():
                event = await native_read()
                native_events.append(('read', event))
                return event

            binding = patch.object(supplied_channel, 'read_event', side_effect=read_event)
            binding.start()
            bindings.append(binding)
            self.addCleanup(binding.stop)

        native_open = supplied_channel._open
        engine_opened = asyncio.Event()

        async def open_engine():
            try:
                await native_open()
            finally:
                engine_opened.set()

        binding = patch.object(supplied_channel, '_open', side_effect=open_engine)
        binding.start()
        bindings.append(binding)
        self.addCleanup(binding.stop)
        native_prepare = supplied_channel.prepare

        async def prepare():
            if supplied_channel.process is not None:
                engine_opened.set()
                return
            if prepare_engine or through_service:
                await native_prepare()
            else:
                await supplied_channel._open()

        async def toggle():
            reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(control.address()), 1)
            try:
                writer.write(b'toggle\n')
                await writer.drain()
                writer.write_eof()
                reply = await asyncio.wait_for(reader.read(13), 1)
                self.assertIn(reply, (b'starting\n', b'inactive\n', b'unavailable\n'))
                return reply.decode().strip()
            finally:
                await control.close_writer(writer)

        async def submit(text, *, lose_receipt=False):
            reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(control.address()), 1)
            try:
                writer.write((json.dumps({'version': 1, 'text': text}) + '\n').encode())
                await writer.drain()
                writer.write_eof()
                if lose_receipt:
                    return
                return (await asyncio.wait_for(reader.read(), 1)).decode().strip()
            finally:
                await control.close_writer(writer)

        service_handle.submit = submit
        service_handle.toggle = toggle

        async def state(expected):
            changed = asyncio.Event()
            original = controller.status.set_state
            if controller.status._state == expected:
                return

            def observe(value):
                original(value)
                if value == expected:
                    changed.set()

            with patch.object(controller.status, 'set_state', side_effect=observe):
                await asyncio.wait_for(changed.wait(), 5)

        service_handle.state = state

        async def close():
            nonlocal completion_observed
            try:
                if service_task is not None and not service_task.done():
                    callback, arguments = handlers[signal.SIGTERM]
                    callback(*arguments)
                if service_task is not None and not completion_observed:
                    try:
                        await asyncio.wait_for(service_task, 5)
                    except TimeoutError:
                        raise
                    except RuntimeError as error:
                        completion_observed = True
                        if controller.failure is None:
                            raise
                        service_handle.shutdown_error = error
                    except BaseException:
                        completion_observed = True
                        raise
                    else:
                        completion_observed = True
            finally:
                for binding in reversed(bindings):
                    binding.stop()
            for process, home in processes:
                if process is not None:
                    self.assertIsNotNone(process.returncode)
                self.assertFalse(home.exists())
            for process in [*audio_children, *wake_children]:
                self.assertIsNotNone(process.returncode)

        self.addAsyncCleanup(close)
        loop = asyncio.get_running_loop()
        native_call_later = loop.call_later

        def call_later(delay, callback, *args, **kwargs):
            handle = native_call_later(delay, callback, *args, **kwargs)
            if (isinstance(getattr(callback, '__self__', None), speech.LaptopOutput)
                    and getattr(callback, '__func__', None) is speech.LaptopOutput._acknowledgement_due):
                self.assertEqual(delay, 2.0)
                handle.cancel()
                acknowledgement_timers.put_nowait((callback, args, callback.__self__.acknowledgement_deadline))
            return handle

        def register(sig, callback, *arguments):
            handlers[sig] = callback, arguments

        for binding in (
            # pipecat's idle limit is shortened so tests do not wait it out.
            patch.dict(speech.TTSService.__init__.__kwdefaults__, stop_frame_timeout_s=0.5),
            patch.object(speech.LaptopOutput, '_acknowledgement_now', lambda output: acknowledgement_time[0]),
            patch.object(loop, 'call_later', side_effect=call_later),
            patch.object(bot.asyncio, 'create_subprocess_exec', spawn),
            patch('pipecat.services.openai.llm.OpenAILLMService.get_chat_completions',
                  side_effect=AssertionError('Direct provider bypass is prohibited')),
            patch.object(bot, 'VoiceConversations', side_effect=conversations),
            patch.object(bot, 'NemotronRecognizer', return_value=recognizer),
            patch.object(bot, 'NemotronSTT', side_effect=new_stt),
            patch.object(bot, 'HermesRequestChannel', return_value=supplied_channel),
            patch.object(bot, 'LocalActions', return_value=actions),
            patch.object(bot, 'LaptopAudioTransport', side_effect=new_transport),
            patch.object(supplied_channel, 'prepare', side_effect=prepare),
            patch.object(bot.VoxCPM, 'from_pretrained', return_value=model),
            patch.object(bot, 'load_phonon', return_value=model),
            patch.object(bot, 'load_voice_preset', return_value=preset),
            *([] if production_turn_strategies else [patch.object(bot, 'UserTurnStrategies', side_effect=lambda **kwargs: ExternalUserTurnStrategies())]),
            patch.object(bot, 'SileroVADAnalyzer', **({'side_effect': vad_factory} if vad_factory else {'return_value': None})),
            *([] if production_turn_strategies else [patch.object(bot, 'LocalSmartTurnAnalyzerV3', return_value=object())]),
            patch.object(bot, 'OutputDeviceWatch', return_value=output_watch, create=True),
            patch.object(bot.ECHO_REMOVAL, 'start', side_effect=echo_start),
            patch.object(bot.ECHO_REMOVAL, 'close', side_effect=echo_close),
            patch.object(bot.ECHO_REMOVAL, 'process', Mock(pid=70001)),
            patch.object(bot.ECHO_REMOVAL, 'microphone_serial', new=AsyncMock(return_value=900)),
            patch.object(bot.ECHO_REMOVAL, 'output_serial', new=AsyncMock(return_value=800)),
            patch.object(status_module, '_PROC_ROOT', proc_root),
            patch.object(bot.torch, 'set_num_threads'),
            patch.object(loop, 'add_signal_handler', side_effect=register),
            patch.object(loop, 'remove_signal_handler'),
            *([patch.object(bot, 'IndicatorStatus', return_value=status)] if status is not None else []),
        ):
            binding.start()
            bindings.append(binding)
            self.addCleanup(binding.stop)
        service_task = asyncio.create_task(bot.run_voice_service())
        service_handle.task = service_task
        service_handle.stop = lambda: handlers[signal.SIGTERM][0](*handlers[signal.SIGTERM][1])
        try:
            await asyncio.wait_for(prepared.wait(), 5)
            # Worker startup is CPU-bound and gets the production budget; later waits keep five seconds so a hang fails.
            await asyncio.wait_for(engine_opened.wait(), ENGINE_STARTUP)
            await state(startup)
            if activate:
                self.assertEqual(await toggle(), 'starting')
                transport = await asyncio.wait_for(started.get(), 5)
            else:
                transport = SimpleNamespace(service=service_handle, sessions=sessions, audio_children=audio_children)
        except BaseException:
            await close()
            raise
        return transport, spoken, committed, interrupted, processes, close

    @staticmethod
    def input_mark(transport):
        admission = transport.service.manager.admission
        return admission.input_mark() if admission is not None else None

    def transcription(self, transport, text, user_id='', timestamp='2026-01-01T00:00:00Z', *, finalized=True):
        frame = TranscriptionFrame(text, user_id, timestamp, finalized=finalized)
        frame.input_mark = self.input_mark(transport)
        return frame

    async def finish_user_turn(self, transport, text):
        frame = TranscriptionFrame(text, '', '2026-01-01T00:00:00Z', finalized=True)
        frame.input_mark = self.input_mark(transport)
        await transport.input().queue_frame(frame)
        await transport.input().queue_frame(ProposedUserStoppedSpeakingFrame())

    @staticmethod
    def as_pushed(frame):
        """Pairs a frame with its label as pushed; later processors relabel frames they stream."""
        return frame, getattr(frame, 'reply_progress', 'unlabelled')

    def reply_intervals(self, messages, records):
        """Groups (frame, label) reply messages by their start and end frames and checks each carries its own reply's record."""
        intervals, interval, ended = [], None, None
        for frame, label in messages:
            if isinstance(frame, bot.LLMFullResponseStartFrame):
                self.assertIsNone(interval, 'A reply started inside another')
                interval = []
                intervals.append(interval)
            if interval is None:
                self.assertIsInstance(frame, InterruptionFrame, 'Only an interruption arrives outside a reply')
                self.assertIn(label, (None, ended))
                continue
            interval.append((frame, label))
            if isinstance(frame, LLMFullResponseEndFrame):
                ended, interval = records[len(intervals) - 1], None
        self.assertIsNone(interval, 'A reply never ended')
        self.assertEqual(len(intervals), len(records))
        for interval, record in zip(intervals, records):
            self.assertIsNotNone(record)
            for frame, label in interval:
                self.assertIs(label, record, frame)
        return intervals

    async def assert_failed_reply(self, transport, spoken, committed, text, *, expected_advisory):
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, text)
        context = await asyncio.wait_for(committed.get(), 5)
        self.assertIn(expected_advisory, context)
        heard = []
        while not spoken.empty():
            heard.append(spoken.get_nowait())
        self.assertIn(expected_advisory, ' '.join(heard))
        return context
