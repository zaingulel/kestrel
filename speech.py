"""Local speech adapters for the Pipecat conversation pipeline."""

import asyncio
import base64
import io
import json
import os
import subprocess
import threading
import wave
from pathlib import Path

import numpy as np
from loguru import logger
from pipecat.audio.resamplers.soxr_resampler import SOXRAudioResampler
from pipecat.frames.frames import TranscriptionFrame, TTSAudioRawFrame
from pipecat.services.settings import STTSettings, TTSSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.services.tts_service import TTSService
from pipecat.utils.time import time_now_iso8601

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

    def fault(self):
        """Return why echo removal is not in use, or None when a program records from its microphone."""
        if self.process.poll() is not None:
            return "Echo removal has stopped. Restart Kestrel."
        try:
            graph = json.loads(subprocess.run(["pw-dump"], capture_output=True, check=True, timeout=5).stdout)
            microphones = {
                item["id"] for item in graph
                if item["type"] == "PipeWire:Interface:Node"
                and item["info"]["props"].get("node.name") == ECHO_REMOVAL_MICROPHONE
            }
            recording = any(
                item["type"] == "PipeWire:Interface:Link"
                and item["info"]["output-node-id"] in microphones and item["info"]["state"] == "active"
                for item in graph
            )
        except (OSError, subprocess.SubprocessError, ValueError, LookupError, TypeError, AttributeError) as exc:
            return f"Echo removal could not be checked: {exc!r}"
        if not microphones:
            return "The Kestrel microphone is missing from the audio system. Restart Kestrel."
        if not recording:
            return (
                'No program is recording from "Kestrel microphone (echo removed)". '
                "Choose it as the microphone in the page and connect again."
            )
        return None

    def close(self):
        self._closing = True
        self.process.terminate()
        try:
            self.process.wait(timeout=ECHO_REMOVAL_STOP_WAIT)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()


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
            raise RuntimeError("Nemotron failed to load; see the server log")
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
            raise RuntimeError("Nemotron worker stopped; restart the microphone session")
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
