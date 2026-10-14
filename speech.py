"""Local speech adapters for the Pipecat conversation pipeline."""

import asyncio
from asyncio import sleep
import base64
import io
import json
import os
import subprocess
import threading
import wave
from pathlib import Path
from time import monotonic

import numpy as np
from loguru import logger
from pipecat.audio.resamplers.soxr_resampler import SOXRAudioResampler
from pipecat.frames.frames import InputAudioRawFrame, InterruptionFrame, TranscriptionFrame, TTSAudioRawFrame
from pipecat.services.settings import STTSettings, TTSSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.services.tts_service import TTSService
from pipecat.utils.time import time_now_iso8601
from pipecat.transports.base_input import BaseInputTransport
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import TransportParams

ROOT = Path(__file__).parent
VOICE_REFERENCE = ROOT / ".runtime/voices/kestrel.wav"
VOICE_REFERENCE_TEXT = "Hello. Speech recognition and voice generation are now running locally."
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
        self.playback_written = False
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
                    if self.playback_written:
                        await self.audio._discard_playback()
                        self.playback_written = False
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
                self.playback_written = True
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
                await self._open_playback()
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

    async def load(self):
        self.process = await asyncio.create_subprocess_exec(
            str(ROOT / ".runtime/asr-venv/bin/python"), str(ROOT / "asr_worker.py"),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        )
        response = await asyncio.wait_for(self.process.stdout.readline(), timeout=60)
        if not response or json.loads(response) != {"ready": True}:
            raise RuntimeError("Nemotron failed to load; see the service log")
        try:
            with VOICE_REFERENCE.open('rb') as source, wave.open(source, 'rb') as reference:
                frames = reference.getnframes()
                if (
                    reference.getnchannels() != 1 or reference.getsampwidth() != 2
                    or reference.getframerate() != 48000
                    or frames == 0 or frames > 480000
                ):
                    raise RuntimeError(
                        'Nemotron preparation requires a nonempty mono 48 kHz PCM16 reference '
                        'of at most ten seconds'
                    )
                pcm = reference.readframes(frames)
                if len(pcm) != frames * 2:
                    raise RuntimeError('Nemotron preparation reference is truncated')
        except (OSError, EOFError, wave.Error) as error:
            raise RuntimeError('Nemotron preparation could not read the voice reference') from error
        pcm = await SOXRAudioResampler().resample(pcm, 48000, 16000)
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


class VoxCPMTTS(TTSService):
    def __init__(self, model):
        super().__init__(
            sample_rate=48000, push_start_frame=True, push_stop_frames=True,
            settings=TTSSettings(model="VoxCPM2", voice=None, language=None),
        )
        self.model = model
        self._generation_lock = asyncio.Lock()

    async def run_tts(self, text, context_id):
        # Never overlap model calls, including a chunk still finishing after interruption.
        async with self._generation_lock:
            chunks = self.model.generate_streaming(
                text=text,
                prompt_wav_path=str(VOICE_REFERENCE), prompt_text=VOICE_REFERENCE_TEXT,
                reference_wav_path=str(VOICE_REFERENCE),
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
