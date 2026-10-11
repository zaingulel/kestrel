"""Local speech adapters for the Pipecat conversation pipeline."""

import asyncio
import base64
import json
from pathlib import Path

import numpy as np
from pipecat.frames.frames import TranscriptionFrame, TTSAudioRawFrame
from pipecat.services.settings import STTSettings, TTSSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.services.tts_service import TTSService
from pipecat.utils.time import time_now_iso8601

ROOT = Path(__file__).parent
VOICE_REFERENCE = ROOT / ".runtime/voices/kestrel.wav"
VOICE_REFERENCE_TEXT = "Hello. Speech recognition and voice generation are now running locally."


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
