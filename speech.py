"""Local speech adapters for the Pipecat conversation pipeline."""

import asyncio
from asyncio import sleep
import base64
import io
import json
import os
import re
from dataclasses import dataclass
import subprocess
import threading
import wave
from pathlib import Path
from time import monotonic

import numpy as np
from loguru import logger
from pipecat.audio.resamplers.soxr_resampler import SOXRAudioResampler
from pipecat.frames.frames import (
    CancelFrame, EndFrame, InputAudioRawFrame, InterruptionFrame, LLMFullResponseEndFrame,
    LLMFullResponseStartFrame, LLMTextFrame, TranscriptionFrame, TTSAudioRawFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.settings import STTSettings, TTSSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.services.tts_service import TTSService
from pipecat.utils.time import time_now_iso8601
from pipecat.transports.base_input import BaseInputTransport
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import TransportParams

ROOT = Path(__file__).parent
# Standard JSON, which PipeWire accepts, so the runtime boundary test can parse it.
ECHO_REMOVAL_CONFIG = "echo-removal.conf"
ECHO_REMOVAL_MICROPHONE = "kestrel-microphone"
# `setpriv` arms the parent-death signal without checking that its parent is still alive, and
# Linux sends nothing for a parent that died first, so the shell starts the command only while
# the process whose identifier follows is still its parent.
BOUND_TO_KESTREL = [
    "setpriv", "--pdeathsig", "TERM",
    "sh", "-c", 'test "$PPID" = "$1" && shift && exec "$@"', "sh",
]
# Seconds a terminated echo removal process is given before it is killed.
ECHO_REMOVAL_STOP_WAIT = 5
LAPTOP_AUDIO_START_TIMEOUT = 10
LAPTOP_CAPTURE_STALL_TIMEOUT = 5
LAPTOP_PLAYBACK_FAILURE = "Laptop audio playback failed. Restart Kestrel."
LAPTOP_CAPTURE_FAILURE = "Laptop microphone capture failed. Restart Kestrel."


@dataclass(frozen=True)
class VoicePreset:
    name: str
    reference: Path
    transcript: str
    pcm: bytes


def load_voice_preset(name: str, *, voices_dir: Path = ROOT / '.runtime/voices') -> VoicePreset:
    advice = 'Check the voice files and restart Kestrel.'
    if re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', name) is None:
        raise RuntimeError(
            'Voice preset name must be 1 to 64 lowercase letters, digits, underscores or hyphens, '
            'starting with a letter or digit. ' + advice
        )

    def refused(asset, reason):
        return RuntimeError(f"Voice preset '{name}' {asset}: {reason}. {advice}")

    try:
        directory = voices_dir.resolve()
    except (OSError, RuntimeError):
        raise refused('directory', 'cannot resolve the voice files') from None

    def read_asset(suffix, limit):
        asset = name + suffix
        try:
            path = (directory / asset).resolve()
        except (OSError, RuntimeError):
            raise refused(asset, 'cannot resolve the file') from None
        if path.parent != directory:
            raise refused(asset, 'must stay immediately inside the voices directory')
        if not path.is_file():
            raise refused(asset, 'missing or not a regular file')
        try:
            with path.open('rb') as source:
                data = source.read(limit + 1)
        except OSError:
            raise refused(asset, 'cannot read the file') from None
        if len(data) > limit:
            raise refused(asset, f'exceeds {limit} bytes')
        return path, data

    reference, wav = read_asset('.wav', 1048576)
    _, text = read_asset('.txt', 4096)
    try:
        transcript = text.decode('utf-8')
    except UnicodeDecodeError:
        raise refused(name + '.txt', 'must be valid UTF-8') from None
    if any(ord(char) < 32 and char not in '\t\n\r' or ord(char) == 127 for char in transcript):
        raise refused(name + '.txt', 'contains ASCII control characters')
    transcript = transcript.strip()
    if not transcript:
        raise refused(name + '.txt', 'transcript is blank')
    try:
        with wave.open(io.BytesIO(wav), 'rb') as audio:
            frames = audio.getnframes()
            if (audio.getnchannels() != 1 or audio.getsampwidth() != 2
                    or audio.getframerate() != 48000 or frames == 0 or frames > 480000):
                raise refused(name + '.wav', 'requires nonempty mono 48 kHz PCM16 audio of at most ten seconds')
            pcm = audio.readframes(frames)
            if len(pcm) != frames * 2:
                raise refused(name + '.wav', 'WAV data is truncated')
    except (EOFError, wave.Error):
        raise refused(name + '.wav', 'malformed WAV audio') from None
    return VoicePreset(name, reference, transcript, pcm)


class EchoRemoval:
    def __init__(self):
        self.process = None
        self._closing = False

    def start(self, on_stopped):
        # The parent-death signal follows the spawning thread, so this runs on the main thread,
        # and the new session keeps a terminal Ctrl+C from stopping echo removal first.
        self.process = subprocess.Popen(
            [*BOUND_TO_KESTREL, str(os.getpid()), "pipewire", "-c", ECHO_REMOVAL_CONFIG],
            env={**os.environ, "PIPEWIRE_CONFIG_DIR": str(ROOT)}, start_new_session=True,
        )
        threading.Thread(target=self._report_stop, args=(on_stopped,), daemon=True).start()

    def _report_stop(self, on_stopped):
        code = self.process.wait()
        if not self._closing:
            logger.error(
                f"Echo removal stopped (exit code {code}); stopping Kestrel, which never listens without it"
            )
            on_stopped()

    def microphone_serial(self, capture_pid=None) -> int:
        """Resolve the owned echo source and, when supplied, its owned recorder."""
        if self.process is None or self.process.poll() is not None:
            raise RuntimeError("Echo removal has stopped. Restart Kestrel.")
        try:
            graph = json.loads(subprocess.run(["pw-dump"], capture_output=True, check=True, timeout=5).stdout)
            if not isinstance(graph, list):
                raise ValueError
            ids = set()
            clients = {}
            nodes = []
            links = []
            for item in graph:
                if not isinstance(item, dict) or type(item.get("id")) is not int or item["id"] in ids:
                    raise ValueError
                ids.add(item["id"])
                kind = item["type"]
                if not isinstance(kind, str):
                    raise ValueError
                if kind in ("PipeWire:Interface:Client", "PipeWire:Interface:Node"):
                    props = item["info"]["props"]
                    if not isinstance(props, dict):
                        raise ValueError
                    if kind == "PipeWire:Interface:Client":
                        pid = props["pipewire.sec.pid"]
                        if type(pid) is not int:
                            raise ValueError
                        clients[item["id"]] = pid
                    else:
                        nodes.append(item)
                elif kind == "PipeWire:Interface:Link":
                    info = item["info"]
                    if (type(info["output-node-id"]) is not int or type(info["input-node-id"]) is not int
                            or not isinstance(info["state"], str)):
                        raise ValueError
                    links.append(info)

            def owner(node):
                client_id = node["info"]["props"].get("client.id")
                if client_id is not None and type(client_id) is not int:
                    raise ValueError
                return clients.get(client_id)

            sources = [item for item in nodes
                       if item["info"]["props"].get("node.name") == ECHO_REMOVAL_MICROPHONE]
            if len(sources) != 1 or owner(sources[0]) != self.process.pid:
                raise ValueError
            source = sources[0]
            serial = source["info"]["props"]["object.serial"]
            if type(serial) is not int or serial <= 0:
                raise ValueError
            if capture_pid is not None:
                captures = [item for item in nodes
                            if owner(item) == capture_pid]
                if len(captures) != 1:
                    raise ValueError
                incoming = [info for info in links if info["input-node-id"] == captures[0]["id"]]
                if not incoming or not all(
                    info["output-node-id"] == source["id"] and info["state"] == "active" for info in incoming
                ):
                    raise ValueError
            return serial
        except (OSError, subprocess.SubprocessError, ValueError, LookupError, TypeError, AttributeError):
            raise RuntimeError("The owned echo-removed microphone could not be verified. Restart Kestrel.") from None

    def close(self):
        if self.process is None:
            return
        self._closing = True
        self.process.terminate()
        try:
            self.process.wait(timeout=ECHO_REMOVAL_STOP_WAIT)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()


class LaptopInput(BaseInputTransport):
    def __init__(self, params):
        super().__init__(params)
        self.ready = False

    async def start(self, frame):
        await super().start(frame)
        await self.set_transport_ready(frame)

    async def set_transport_ready(self, frame):
        await super().set_transport_ready(frame)
        self.ready = True

    async def cancel(self, frame):
        self.ready = False
        await super().cancel(frame)

    async def stop(self, frame):
        self.ready = False
        await super().stop(frame)


class LaptopOutput(BaseOutputTransport):
    def __init__(self, audio, params):
        super().__init__(params)
        self.audio = audio
        self.write_lock = asyncio.Lock()
        self.playback_deadline: float | None = None
        self.write_gate = asyncio.Event()
        self.write_gate.set()

    async def start(self, frame):
        await super().start(frame)
        await self.set_transport_ready(frame)

    async def process_frame(self, frame, direction):
        if isinstance(frame, InterruptionFrame):
            self.write_gate.clear()
            try:
                # Native sender cancellation discards its queued audio and cancels the pacing wait.
                await super().process_frame(frame, direction)
                async with self.write_lock:
                    if self.audio.playback is not None:
                        await self.audio._discard_playback()
                        self.playback_deadline = None
            finally:
                self.write_gate.set()
        else:
            await super().process_frame(frame, direction)

    async def write_audio_frame(self, frame) -> bool:
        await self.write_gate.wait()
        async with self.write_lock:
            if self.audio.closed or self.audio.failure or not self.write_gate.is_set():
                return False
            try:
                if self.audio.playback is None:
                    await self.audio._open_playback()
                duration = len(frame.audio) / (2 * frame.num_channels * frame.sample_rate)
                deadline = (self.playback_deadline if self.playback_deadline is not None else monotonic()) + duration
                self.audio.playback.stdin.write(frame.audio)
                await self.audio.playback.stdin.drain()
                now = monotonic()
                if deadline <= now:
                    deadline = now + duration
                await sleep(deadline - now)
                self.playback_deadline = deadline
                return True
            except (OSError, RuntimeError):
                self.audio.fail(LAPTOP_PLAYBACK_FAILURE)
                return False


class LaptopAudioTransport:
    def __init__(self, echo_removal, *, on_stopped):
        self.echo_removal = echo_removal
        self.on_stopped = on_stopped
        self.failure: str | None = None
        self.capture = None
        self.playback = None
        self.playback_watcher = None
        self.reader = None
        self.closed = False
        self.close_task = None
        self.verified = False
        self.received_audio = asyncio.Event()
        params = TransportParams(audio_in_enabled=True, audio_out_enabled=True,
                                 audio_in_sample_rate=16000, audio_out_sample_rate=48000)
        self._input = LaptopInput(params)
        self._output = LaptopOutput(self, params)

        @self._output.event_handler("on_error")
        async def on_output_error(processor, frame):
            if not processor.is_usable:
                self.fail(LAPTOP_PLAYBACK_FAILURE)

    def input(self):
        return self._input

    def output(self):
        return self._output

    def fail(self, reason: str) -> None:
        if self.failure is None and not self.closed:
            self.failure = reason
            self.verified = False
            self.received_audio.set()
            logger.error(reason)
            self.on_stopped()

    async def _source(self, capture_pid=None):
        while True:
            if self.failure:
                raise RuntimeError(self.failure)
            try:
                return await asyncio.to_thread(self.echo_removal.microphone_serial, capture_pid)
            except RuntimeError:
                await asyncio.sleep(0.5)

    async def _spawn(self, *command, **pipes):
        # Bind to the event-loop thread's lifetime, including blocked standard I/O.
        guard = [*BOUND_TO_KESTREL]
        guard[2] = "KILL"
        return await asyncio.create_subprocess_exec(
            *guard, str(os.getpid()), *command, start_new_session=True, **pipes,
        )

    async def open(self):
        try:
            async with asyncio.timeout(LAPTOP_AUDIO_START_TIMEOUT):
                serial = await self._source()
                props = {"node.name": f"kestrel-capture-{os.getpid()}", "node.dont-fallback": True,
                         "node.dont-move": True, "node.dont-reconnect": True}
                self.capture = await self._spawn(
                    "stdbuf", "-o0", "pw-cat", "--record", "--raw", "--target", str(serial),
                    "--properties", json.dumps(props), "--rate", "16000", "--channels", "1",
                    "--format", "s16", "--latency", "20ms", "-", stdout=asyncio.subprocess.PIPE,
                )
                self.reader = asyncio.create_task(self._read())
                await self._source(self.capture.pid)
                if self.failure:
                    raise RuntimeError(self.failure)
                self.verified = True
                await asyncio.wait_for(self.received_audio.wait(), LAPTOP_CAPTURE_STALL_TIMEOUT)
                if self.failure:
                    raise RuntimeError(self.failure)
        except asyncio.CancelledError:
            await self.close()
            raise
        except (OSError, RuntimeError, TimeoutError):
            self.fail(LAPTOP_CAPTURE_FAILURE)
            await self.close()
            raise RuntimeError(self.failure) from None

    async def _read(self):
        try:
            while True:
                pcm = await asyncio.wait_for(self.capture.stdout.readexactly(640), LAPTOP_CAPTURE_STALL_TIMEOUT)
                self.received_audio.set()
                if self.verified and self._input.ready and not self.closed:
                    await self._input.push_audio_frame(InputAudioRawFrame(pcm, 16000, 1))
        except (OSError, RuntimeError, asyncio.IncompleteReadError, TimeoutError):
            self.fail(LAPTOP_CAPTURE_FAILURE)

    async def _open_playback(self):
        try:
            self.playback = await self._spawn(
                "pw-cat", "--playback", "--raw", "--rate", "48000", "--channels", "1",
                "--format", "s16", "--latency", "20ms", "-", stdin=asyncio.subprocess.PIPE,
            )
        except OSError:
            self.fail(LAPTOP_PLAYBACK_FAILURE)
            raise RuntimeError(self.failure) from None
        self.playback_watcher = asyncio.create_task(self._watch_playback(self.playback))

    async def _watch_playback(self, process):
        await process.wait()
        if process is self.playback:
            self.fail(LAPTOP_PLAYBACK_FAILURE)

    async def _reap_audio(self, process):
        if process is None:
            return
        if process.stdin is not None:
            process.stdin.close()
        if process.stdout is not None and process.stdout._transport is not None:
            process.stdout._transport.close()
        if process.returncode is None:
            process.kill()
        await process.wait()
        if process.stdin is not None:
            try:
                await process.stdin.wait_closed()
            except (BrokenPipeError, ConnectionResetError):
                pass

    async def _discard_playback(self):
        process, self.playback = self.playback, None
        if self.playback_watcher is not None:
            self.playback_watcher.cancel()
            await asyncio.gather(self.playback_watcher, return_exceptions=True)
            self.playback_watcher = None
        await self._reap_audio(process)

    async def close(self):
        if self.close_task is None:
            self.closed = True
            self.verified = False
            self._input.ready = False
            self._output.write_gate.set()
            self.close_task = asyncio.create_task(self._close())
        try:
            await asyncio.shield(self.close_task)
        except asyncio.CancelledError:
            # A failure can request cancellation while startup is already closing its children.
            await self.close_task
            raise

    async def _close(self):
        if self.reader is not None:
            self.reader.cancel()
            await asyncio.gather(self.reader, return_exceptions=True)
        await self._discard_playback()
        await self._reap_audio(self.capture)


class NemotronSTT(SegmentedSTTService):
    def __init__(self):
        super().__init__(
            sample_rate=16000,
            settings=STTSettings(model="nemotron-speech-streaming-en-0.6b", language=None),
        )
        self.process = None

    async def load(self, reference_pcm: bytes):
        self.process = await asyncio.create_subprocess_exec(
            str(ROOT / ".runtime/asr-venv/bin/python"), str(ROOT / "asr_worker.py"),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        )
        response = await asyncio.wait_for(self.process.stdout.readline(), timeout=60)
        if not response or json.loads(response) != {"ready": True}:
            raise RuntimeError("Nemotron failed to load; see the service log")
        pcm = await SOXRAudioResampler().resample(reference_pcm, 48000, 16000)
        prepared = io.BytesIO()
        with wave.open(prepared, 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(pcm)
        async with asyncio.timeout(60):
            async for _ in self.run_stt(prepared.getvalue()):
                pass

    async def close(self):
        if self.process is not None and self.process.returncode is None:
            self.process.terminate()
            await self.process.wait()

    async def run_stt(self, audio):
        request = json.dumps({"audio": base64.b64encode(audio).decode()}) + "\n"
        self.process.stdin.write(request.encode())
        await self.process.stdin.drain()
        response = await self.process.stdout.readline()
        if not response:
            raise RuntimeError("Nemotron worker stopped. Restart Kestrel.")
        result = json.loads(response)
        if "error" in result:
            raise RuntimeError(result["error"])
        if result["text"]:
            yield TranscriptionFrame(result["text"], "", time_now_iso8601(), finalized=True)


class SpokenReplyText:
    """Incrementally retain only generated text that is safe to speak."""

    def __init__(self):
        self.reset()

    def reset(self) -> None:
        self.active = False
        self.code = False
        self.mode = 'text'
        self.space = ''
        self.join = False
        self.last = ''
        self.prose = False
        self.output = []
        self.line_start = True
        self.indent = ''
        self.blank_before = True
        self.line_nonblank = False
        self.indent_columns = 0
        self.line_base = 0
        self.list_columns = []
        self.list_prose = False
        self.marker_width = 0
        self.marker_indent = 0
        self.marker_padding = 0
        self.code_base = 0
        self.line_pending = []
        self.line_pending_bytes = 0
        self.line_pending_kind = ''
        self.rule_mark = ''
        self.rule_count = 0
        self.line_replay = False
        self.row_active = False
        self.row_cell_text = False
        self.row_separator_dash = False
        self.row_separator_colon = False
        self.row_separator_end = False
        self.row_separator_text = False
        self.run_char = ''
        self.run_length = 0
        self.run_at_start = False
        self.delimiter = ''
        self.delimiter_length = 0
        self.fence_stage = 'indent'
        self.fence_indent = 0
        self.fence_count = 0
        self.prefix = ''
        self.heading = False
        self.line_prose = False
        self.closing_hashes = 0
        self.escape = False
        self.emphasis = ''
        self.emphasis_length = 0
        self.emphasis_before_word = False
        self.open_emphasis = set()
        self.addresses = False
        self.candidate = ''
        self.wrapper = ''
        self.wrapper_omitted = False
        self.url = False
        self.url_parentheses = 0
        self.url_tail = []
        self.url_tail_bytes = 0
        self.url_closer = ''
        self.image = False
        self.label = None
        self.label_depth = 0
        self.label_closed = False
        self.label_saved = None
        self.label_bytes = 0
        self.destination = 0
        self.destination_escape = False
        self.destination_quote = ''
        self.destination_title_space = False
        self.refused = False

    def start(self) -> None:
        self.reset()
        self.active = True

    def _emit(self, text):
        for char in text:
            if char.isspace():
                self.space += char
                continue
            if self.join:
                spacing = ' ' if self.space or (self.last.isalnum() and char.isalnum()) else ''
                if char in ".,!?;:)]}>\"'":
                    spacing = ''
            else:
                spacing = self.space
            target = self.output if self.label is None else self.label
            if (self.prose or char.isalnum() or not (self.addresses or self.code)
                    or self.wrapper_omitted and char == self.wrapper):
                target.append(spacing + char)
                if self.row_active and self.label is None:
                    self.row_cell_text = True
            self.space = ''
            self.join = False
            self.last = char
            self.prose |= char.isalnum()
            self.line_prose |= char.isalnum()
            if self.list_columns:
                self.list_prose |= char.isalnum()

    def _omit(self):
        self.join = True
        if self.wrapper:
            self.wrapper_omitted = True

    def _new_line(self):
        self.blank_before = not self.line_nonblank
        self.line_start = True
        self.line_nonblank = False
        self.indent = ''
        self.indent_columns = 0
        self.heading = self.line_prose = False

    def _end_sentence(self, *, strip_space=False) -> None:
        if self.last not in '.!?':
            if strip_space:
                self.space = ''
            self._emit('.')

    def _end_line(self):
        if self.closing_hashes:
            self._omit()
        self.closing_hashes = 0
        if self.heading and self.line_prose:
            self._end_sentence()
        self._emit('\n')
        self._new_line()

    @staticmethod
    def _column_after(column, char):
        return column + (4 - column % 4 if char == '\t' else 1)

    def _list_sentence(self):
        if self.list_prose:
            self._end_sentence(strip_space=True)
            self.space = self.space or ' '
            self.list_prose = False

    def _marker_char(self, char):
        if char in ' \t':
            column = self.marker_indent + self.marker_width + self.marker_padding
            self.marker_padding = self._column_after(column, char) - self.marker_indent - self.marker_width
            return
        self._list_sentence()
        while self.list_columns and self.marker_indent < self.list_columns[-1]:
            self.list_columns.pop()
        padding = self.marker_padding if self.marker_padding <= 4 else 1
        base = self.marker_indent + self.marker_width + padding
        self.list_columns.append(base)
        extra = self.marker_padding - padding
        self.marker_width = self.marker_padding = 0
        self.heading = False
        self.line_base = base
        self.indent = ''
        self._omit()
        if char == '\n':
            self._end_line()
        elif extra >= 4:
            self.code = True
            self.code_base = base
            self.mode = 'indent'
            self.line_start = False
        elif char in '`~':
            self.run_char, self.run_length, self.run_at_start = char, 1, True
        else:
            self._text(char)

    def _hold_line_char(self, char):
        self.line_pending.append(char)
        self.line_pending_bytes += len(char.encode('utf-8'))
        if self.line_pending_bytes > 1024 * 1024:
            self._refuse_buffer()

    def _release_line_prefix(self):
        pending = self.line_pending
        self.line_pending = []
        self.line_pending_bytes = 0
        if self.line_pending_kind == 'row':
            if self.prose:
                self._end_sentence(strip_space=True)
            self.space = self.space or ' '
            self.row_active = True
            self.row_cell_text = False
            self.line_start = False
            self._omit()
        self.line_pending_kind = ''
        self.line_replay = True
        try:
            for char in pending:
                self._scan(char)
        finally:
            self.line_replay = False

    def _rule_char(self, char):
        if char == self.rule_mark or char in ' \t':
            self._hold_line_char(char)
            self.rule_count += char == self.rule_mark
        elif char == '\n' and self.rule_count >= 3:
            self.line_pending = []
            self.line_pending_bytes = 0
            self.line_pending_kind = ''
            self._list_sentence()
            if self.prose:
                self._end_sentence(strip_space=True)
            self._omit()
            self._emit('\n')
            self._new_line()
        else:
            self._release_line_prefix()
            self._scan(char)

    def _row_separator_char(self, char):
        if char in ' \t':
            self._hold_line_char(char)
        elif char == '-' and not self.row_separator_end:
            self.row_separator_dash = self.row_separator_text = True
            self._hold_line_char(char)
        elif char == ':' and not self.row_separator_end:
            if self.row_separator_dash:
                self.row_separator_end = True
            elif self.row_separator_colon:
                self._release_line_prefix()
                self._scan(char)
                return
            else:
                self.row_separator_colon = True
            self.row_separator_text = True
            self._hold_line_char(char)
        elif char in '|\n':
            if self.row_separator_text and not self.row_separator_dash:
                self._release_line_prefix()
                self._scan(char)
                return
            if char == '\n':
                self.line_pending = []
                self.line_pending_bytes = 0
                self.line_pending_kind = ''
                self._omit()
                self._new_line()
            else:
                self._hold_line_char(char)
            self.row_separator_dash = self.row_separator_colon = False
            self.row_separator_end = self.row_separator_text = False
        else:
            self._release_line_prefix()
            self._scan(char)

    def _flush_pending_inline(self) -> None:
        if self.candidate:
            self._emit(self.wrapper + self.candidate)
            self.wrapper = self.candidate = ''
            self.wrapper_omitted = False
        if self.wrapper:
            if not self.wrapper_omitted:
                self._emit(self.wrapper)
            self.wrapper = ''
            self.wrapper_omitted = False
        if self.image:
            self._emit('!')
            self.image = False

    def _row_boundary(self):
        self._resolve_emphasis('', at_end=True)
        self._flush_pending_inline()
        if self.row_cell_text:
            self._end_sentence(strip_space=True)
        self._omit()
        self.space = ' '
        self.row_cell_text = False

    def _prefix_char(self, char):
        prefix = self.prefix
        if prefix == '>':
            self.prefix = self.indent = ''
            self.line_start = True
            self._omit()
            self._scan(char)
            return
        if prefix.startswith('#'):
            waiting = char == '#' and len(prefix) < 6
            valid = char.isspace()
        elif prefix[0].isdigit():
            waiting = (char.isdigit() and prefix.isdigit() and len(prefix) < 9
                       or char in '.)' and prefix.isdigit())
            valid = char.isspace() and prefix[-1] in '.)'
        else:
            waiting = False
            valid = char.isspace()
        if waiting:
            self.prefix += char
        elif valid:
            self.prefix = ''
            if not prefix.startswith('#'):
                self.marker_indent = self.indent_columns
                self.marker_width = len(prefix)
                self.marker_padding = 0
                self._marker_char(char)
            else:
                self.indent = ''
                self.heading = True
                self._omit()
                if char == '\n':
                    self._end_line()
        else:
            self.prefix = ''
            self._emit(self.indent)
            self.indent = ''
            for literal in prefix:
                self._text(literal)
            self._text(char)

    def _resolve_emphasis(self, char, *, at_end=False):
        if not self.emphasis:
            return
        marker = self.emphasis * self.emphasis_length
        opening = (not self.emphasis_before_word and bool(char) and not char.isspace()
                   and self.emphasis_length <= 3
                   and (self.emphasis != '~' or self.emphasis_length == 2))
        intraword = (self.emphasis == '_' and self.emphasis_before_word
                     and (char.isalnum() or char == '_'))
        if intraword:
            self._emit(marker)
        elif marker in self.open_emphasis:
            self.open_emphasis.remove(marker)
        elif opening:
            self.open_emphasis.add(marker)
        elif ((self.prose or self.label is not None or self.emphasis == '~')
              and (not at_end or self.emphasis_before_word or self.emphasis == '~')):
            self._emit(marker)
        self.emphasis = ''

    def _text(self, char):
        if self.emphasis and char == self.emphasis:
            self.emphasis_length += 1
            return
        self._resolve_emphasis(char)
        if self.escape:
            self.escape = False
            if not char.isalnum() and not char.isspace():
                self._emit(char)
                return
            self._emit('\\')
        if self.image:
            self.image = False
            if char != '[':
                self._emit('!')
        if (self.wrapper and self.wrapper_omitted
                and char == {'(': ')', '<': '>', '"': '"', "'": "'"}[self.wrapper]):
            self.wrapper = ''
            self.wrapper_omitted = False
            self._omit()
            return
        if (self.wrapper and char.lower() not in 'hw' and char != '`'
                and not (self.wrapper_omitted and char.isspace())):
            self._emit(self.wrapper)
            self.wrapper = ''
            self.wrapper_omitted = False
        if self.closing_hashes:
            if char == '#':
                self.closing_hashes += 1
                return
            if char == '\n':
                self._end_line()
                return
            if char.isspace():
                return
            self._emit('#' * self.closing_hashes)
            self.closing_hashes = 0
        if char == '\\':
            self.escape = True
        elif self.heading and char == '#' and self.space:
            self.closing_hashes = 1
        elif char in '*_~':
            self.emphasis = char
            self.emphasis_length = 1
            self.emphasis_before_word = bool(self.last.isalnum() and not self.space)
        elif char == '`':
            self.run_char, self.run_length, self.run_at_start = char, 1, False
        elif char == '\n':
            self._end_line()
        else:
            self.line_nonblank |= not char.isspace()
            self._lex(char)

    def _restore_label_join(self, saved) -> bool:
        self.space, self.last, self.prose, self.join, self.line_prose, addresses = saved
        return addresses

    def _refuse_buffer(self) -> None:
        if self.label is not None:
            self._restore_label_join(self.label_saved)
        saved = (self.space, self.last, self.prose, self.join, self.line_prose, self.addresses)
        output, code, addresses = self.output, self.code, self.addresses
        self.reset()
        self.active = self.refused = True
        self.output, self.code, self.addresses = output, code, addresses
        self._restore_label_join(saved)

    def _release_label(self, linked=False, closed=True):
        text = ''.join(self.label) + self.space
        saved = self.label_saved
        self.label = None
        self.label_depth = 0
        self.label_closed = False
        old_addresses = self._restore_label_join(saved)
        if linked:
            self._emit(text)
            self._omit()
        elif not any(c.isalnum() for c in text) and (self.addresses != old_addresses or self.code):
            self._omit()
        else:
            self._emit('[' + text + (']' if closed else ''))

    def _lex(self, char):
        if char == '[':
            if self.label is not None:
                self.label_depth += 1
                self._emit(char)
            else:
                self.label_saved = (self.space, self.last, self.prose, self.join,
                                    self.line_prose, self.addresses)
                self.label = []
                self.label_depth = 1
                self.label_bytes = 1
                self.space = self.last = ''
                self.join = False
            return
        if char == ']' and self.label is not None:
            self.label_depth -= 1
            if self.label_depth:
                self._emit(char)
            else:
                self.label_closed = True
            return
        if char == '!':
            self.image = True
        elif char in "(<\"'":
            self.wrapper = char
            self.wrapper_omitted = False
        elif char.lower() in 'hw' and (self.wrapper or self.space or not self.last
                                       or not (self.last.isalnum() or self.last == '_')):
            self.candidate = char
        else:
            self._emit(char)

    def _finish_url_tail(self):
        for char in self.url_tail:
            if char == self.url_closer:
                self.url_closer = ''
            else:
                self._emit(char)
        self.url_tail = []
        self.url_tail_bytes = 0

    def _url_char(self, char):
        if char == '(':
            self.url_parentheses += 1
        elif char == ')' and self.url_parentheses:
            self.url_parentheses -= 1
        elif char.isspace() or char in '<>`])' or (self.row_active and char == '|'):
            self.url = False
            self._finish_url_tail()
            self._omit()
            pending = {')': '(', '>': '<', '"': '"', "'": "'"}.get(self.url_closer, '') if char.isspace() else ''
            if char != self.url_closer:
                self._scan(char)
            if pending:
                self.wrapper = pending
                self.wrapper_omitted = True
            self.url_closer = ''
            return
        if char in ".,!?;:\"'":
            self.url_tail.append(char)
            self.url_tail_bytes += len(char.encode('utf-8'))
            if self.url_tail_bytes > 1024 * 1024:
                self._refuse_buffer()
        else:
            self.url_tail = []
            self.url_tail_bytes = 0

    def _destination_char(self, char):
        escaped = self.destination_escape
        if self.destination_escape:
            self.destination_escape = False
        elif char == '\\':
            self.destination_escape = True
        elif self.destination_quote:
            if char == self.destination_quote:
                self.destination_quote = ''
        elif char in '\"\'' and self.destination_title_space:
            self.destination_quote = char
        elif char == '(':
            self.destination += 1
        elif char == ')':
            self.destination -= 1
        self.destination_title_space = (char.isspace() and not escaped
                                        and self.destination == 1 and not self.destination_quote)
        if not self.destination:
            self._omit()

    def _fence(self, char):
        if char == '\n':
            if self.fence_stage in ('run', 'tail') and self.fence_count >= self.delimiter_length:
                self.mode = 'text'
                self._new_line()
            self.fence_stage = 'indent'
            self.fence_indent = self.fence_count = 0
        elif self.fence_stage == 'indent':
            if char in ' \t':
                self.fence_indent = self._column_after(self.fence_indent, char)
                if self.fence_indent > self.code_base + 3:
                    self.fence_stage = 'body'
            elif char == self.delimiter and self.code_base <= self.fence_indent <= self.code_base + 3:
                self.fence_stage = 'run'
                self.fence_count = 1
            else:
                self.fence_stage = 'body'
        elif self.fence_stage == 'run':
            if char == self.delimiter:
                self.fence_count += 1
            elif char.isspace():
                self.fence_stage = 'tail'
            else:
                self.fence_stage = 'body'
        elif self.fence_stage == 'tail' and not char.isspace():
            self.fence_stage = 'body'

    def _scan(self, char):
        if self.refused:
            return
        if self.line_pending_kind == 'rule':
            self._rule_char(char)
            return
        if self.line_pending_kind == 'row':
            self._row_separator_char(char)
            return
        if self.destination:
            self._destination_char(char)
            return
        if self.url:
            self._url_char(char)
            return
        if self.candidate:
            candidate = self.candidate + char
            prefixes = ('http://', 'https://', 'www.')
            if candidate.lower() in prefixes:
                self.url_closer = {'(': ')', '<': '>', '"': '"', "'": "'"}.get(self.wrapper, '')
                self.candidate = self.wrapper = ''
                self.wrapper_omitted = False
                self.url_parentheses = 0
                self.addresses = self.url = True
                self._omit()
                return
            if any(prefix.startswith(candidate.lower()) for prefix in prefixes):
                self.candidate = candidate
                return
            self._emit(self.wrapper + self.candidate)
            self.wrapper = self.candidate = ''
            self.wrapper_omitted = False
        if self.label_closed:
            if char == '(':
                self._release_label(linked=True)
                self.destination = 1
                self.destination_title_space = False
                return
            self._release_label()
        if self.run_char:
            if char == self.run_char:
                self.run_length += 1
                return
            marker, length = self.run_char, self.run_length
            at_start = self.run_at_start
            self.run_char = ''
            if self.mode == 'inline':
                if length == self.delimiter_length:
                    self.mode = 'text'
                else:
                    self._scan(char)
                    return
            elif at_start and length >= 3:
                self.code = True
                self._omit()
                self.delimiter, self.delimiter_length = marker, length
                self.code_base = self.line_base
                self.mode = 'fence_header'
            elif marker == '`':
                self.code = True
                self._omit()
                self.delimiter, self.delimiter_length = marker, length
                self.mode = 'inline'
            else:
                for literal in marker * length:
                    self._text(literal)
        if self.mode == 'fence_header':
            if char == '\n':
                self.mode = 'fence'
            return
        if self.mode == 'fence':
            self._fence(char)
            return
        if self.mode == 'inline':
            if char == '`':
                self.run_char, self.run_length = '`', 1
            if char == '\n':
                self._new_line()
            else:
                self.line_start = False
            return
        if self.mode == 'indent':
            if char == '\n':
                self._new_line()
            elif self.line_start:
                if char in ' \t':
                    self.indent += char
                    self.indent_columns = self._column_after(self.indent_columns, char)
                elif self.indent_columns >= self.code_base + 4:
                    self.line_start = False
                    self.line_nonblank = True
                    self.indent = ''
                else:
                    self.mode = 'text'
                    self._scan(char)
            return
        if self.row_active and self.label is None and not self.escape and char in '|\n':
            self._row_boundary()
            if char == '\n':
                self.row_active = False
                self._new_line()
            return
        if self.marker_width:
            self._marker_char(char)
            return
        if self.prefix:
            self._prefix_char(char)
            return
        if self.line_start:
            if char in ' \t':
                self.indent += char
                self.indent_columns = self._column_after(self.indent_columns, char)
                return
            if char == '\n':
                self._list_sentence()
                self._emit(self.indent + char)
                self._new_line()
                return
            if self.blank_before:
                while self.list_columns and self.indent_columns < self.list_columns[-1]:
                    self._list_sentence()
                    self.list_columns.pop()
            self.line_base = next((column for column in reversed(self.list_columns)
                                   if column <= self.indent_columns), 0)
            relative = self.indent_columns - self.line_base
            if self.blank_before and relative >= 4:
                self.code = True
                self._omit()
                self.mode = 'indent'
                self.code_base = self.line_base
                self.line_start = False
                self.indent = ''
                return
            at_start = relative <= 3
            if at_start and char == '|' and not self.line_replay:
                self.line_pending_kind = 'row'
                self.row_separator_dash = self.row_separator_colon = False
                self.row_separator_end = self.row_separator_text = False
                self._hold_line_char(char)
                return
            if at_start and char in '-*_' and not self.line_replay:
                self.line_pending_kind = 'rule'
                self.rule_mark = char
                self.rule_count = 1
                self._hold_line_char(char)
                return
            self.line_start = False
            self.line_nonblank = True
            if char in '`~' and at_start:
                self.run_char, self.run_length, self.run_at_start = char, 1, True
                self.indent = ''
                return
            if at_start and (char in '#-+*>' or char.isdigit()):
                self.prefix = char
                return
            self._emit(self.indent)
            self.indent = ''
        self._text(char)

    def feed(self, text: str) -> str:
        if not self.active:
            return ''
        self.output = []
        for char in text:
            if self.label is not None:
                self.label_bytes += len(char.encode('utf-8'))
                if self.label_bytes > 1024 * 1024:
                    self._refuse_buffer()
            self._scan(char)
        return ''.join(self.output)

    def finish(self, *, failed: bool = False) -> str:
        if not self.active:
            return ''
        self.output = []
        if self.line_pending_kind == 'rule':
            if self.rule_count >= 3:
                self._rule_char('\n')
            else:
                self._release_line_prefix()
        elif self.line_pending_kind == 'row':
            self._row_separator_char('\n')
        if self.url:
            self._finish_url_tail()
        self._flush_pending_inline()
        if self.run_char and self.mode == 'text':
            if self.run_char == '`' or self.run_length >= 3:
                self.code = True
            else:
                self._emit(self.run_char * self.run_length)
        if self.marker_width:
            self._marker_char('\n')
        if self.prefix:
            for char in self.indent + self.prefix:
                self._text(char)
            self.indent = self.prefix = ''
        self._resolve_emphasis('', at_end=True)
        if self.escape:
            self._emit('\\')
        if self.closing_hashes:
            self._omit()
        self.closing_hashes = 0
        if self.row_active:
            self._row_boundary()
        self._list_sentence()
        if self.heading and self.line_prose:
            self._end_sentence()
        if self.label is not None:
            self._release_label(closed=self.label_closed)
        result = ''.join(self.output)
        if self.code:
            result += ' There is code in this reply.'
        if self.refused and not failed:
            result += " I couldn't safely prepare this reply for speech. Please ask me to rephrase."
        elif not self.prose and not self.code and not failed:
            result = ("This reply contains a web address, which I won't read aloud."
                      if self.addresses else
                      "There is no speakable text in this reply. Please ask me to rephrase.")
        elif not self.code and not self.refused:
            result += self.space + self.indent
        self.reset()
        return result


class SpeechAdvisoryFrame(LLMTextFrame):
    """Fixed application speech that generated syntax cannot suppress."""


class VoxCPMTTS(TTSService):
    def __init__(self, model, preset: VoicePreset):
        super().__init__(
            sample_rate=48000, push_start_frame=True, push_stop_frames=True,
            settings=TTSSettings(model="VoxCPM2", voice=None, language=None),
        )
        self.model = model
        self.preset = preset
        self._generation_lock = asyncio.Lock()
        self._spoken_reply = SpokenReplyText()

    async def process_frame(self, frame, direction):
        if isinstance(frame, (InterruptionFrame, CancelFrame, EndFrame)):
            self._spoken_reply.reset()
        elif direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, LLMFullResponseStartFrame):
                self._spoken_reply.start()
            elif isinstance(frame, SpeechAdvisoryFrame):
                tail = self._spoken_reply.finish(failed=True)
                if tail.strip():
                    separator = ' ' if tail.rstrip().endswith(('.', '!', '?')) else '. '
                    frame.text = tail.rstrip() + separator + frame.text.lstrip()
            elif isinstance(frame, LLMTextFrame):
                frame.text = self._spoken_reply.feed(frame.text)
            elif isinstance(frame, LLMFullResponseEndFrame):
                tail = self._spoken_reply.finish()
                if tail:
                    await super().process_frame(LLMTextFrame(tail), direction)
        await super().process_frame(frame, direction)

    async def run_tts(self, text, context_id):
        # Never overlap model calls, including a chunk still finishing after interruption.
        async with self._generation_lock:
            chunks = self.model.generate_streaming(
                text=text,
                prompt_wav_path=str(self.preset.reference), prompt_text=self.preset.transcript,
                reference_wav_path=str(self.preset.reference),
                inference_timesteps=10, max_len=400, retry_badcase=False,
            )
            pending = None
            try:
                while True:
                    pending = asyncio.create_task(asyncio.to_thread(next, chunks, None))
                    chunk = await asyncio.shield(pending)
                    if chunk is None:
                        break
                    pcm = (np.clip(chunk, -1, 1) * 32767).astype("<i2").tobytes()
                    yield TTSAudioRawFrame(pcm, 48000, 1, context_id=context_id)
            finally:
                # Cancellation stops playback immediately in Pipecat. Finish only the
                # current GPU chunk before closing its generator and releasing the model.
                if pending is not None:
                    await pending
                await asyncio.to_thread(chunks.close)
