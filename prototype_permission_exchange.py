"""PROTOTYPE, throwaway: the spoken permission exchange (card #23, branch job/23 only, never merged).

Question: how should Kestrel read back a consequential action, how long should she wait, and is a spoken yes
or no recognised reliably, with silence and an unclear answer both treated as no? Nothing real is carried out.

Assumption: neither of the prototype skill's branches (an HTML state machine or UI variants) fits a voice
question, so this follows the surrounding speech adapters and is a runnable script the owner drives by voice.

Run from the repository root:
    .runtime/voice-venv/bin/python prototype_permission_exchange.py [--wording A|B|C] [--wait SECONDS]
        Needs the voice service stopped. Speaks through the default output, listens through Kestrel's own
        echo-removed microphone. Transcripts go to the terminal only; nothing is written and no audio is kept.
    .runtime/voice-venv/bin/python prototype_permission_exchange.py --check
        Synthesises three answers and runs them through recognition and classification. Uses neither the
        microphone nor the speakers, so it can run while Kestrel runs.
"""

import argparse
import asyncio
import io
import math
import os
import re
import subprocess
import sys
import wave
from collections import deque
from pathlib import Path

ROOT = Path(__file__).parent
# The same cache and offline settings run-voice.sh exports, set before speech is imported.
os.environ.setdefault('HF_HOME', str(ROOT / '.runtime/cache/huggingface'))
os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
os.environ.setdefault('MPLCONFIGDIR', str(ROOT / '.runtime/cache/matplotlib'))
os.environ.setdefault('NUMBA_CACHE_DIR', str(ROOT / '.runtime/cache/numba'))
os.environ.setdefault('TORCH_HOME', str(ROOT / '.runtime/cache/torch'))

import numpy as np
import soxr
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams, VADState
from speech import (
    BOUND_TO_KESTREL, PHONON_VOICE, EchoRemoval, LaptopAudioTransport, NemotronRecognizer, load_phonon,
    spoken_numbers,
)

ACTIONS = (
    'start a Claude Code session in the Kestrel project to fix a failing test',
    'move report.pdf from Downloads to Documents',
    'change the keyboard layout to French',
)
WORDINGS = {
    'A': lambda action: f"I'm about to {action}. Shall I go ahead?",
    'B': lambda action: f'{action[0].upper()}{action[1:]}. Yes or no?',
    'C': lambda action: f'Just to check: you want me to {action}?',
}
YES = {'yes', 'yeah', 'yep', 'yup', 'sure', 'okay', 'ok', 'go ahead', 'do it', 'yes please', 'please do',
       'yes go ahead'}
NO = {'no', 'nope', 'no thanks', "don't", 'do not', 'stop', 'cancel', 'not now', 'never mind'}
OUTCOMES = {
    'yes': ('would run', 'Okay. This is a prototype, so nothing was actually done.'),
    'no': ('refused', "Okay, I won't."),
    'silence': ('refused', "I didn't hear an answer, so I won't."),
    'unclear': ('refused', "I didn't catch a clear yes, so I won't."),
}
CHECKS = (('Yes.', 'yes'), ('No thanks.', 'no'), ('Maybe later, I think.', 'unclear'))

FRAME_SECONDS = 0.02  # 640-byte frames of 16 kHz mono 16-bit audio, as LaptopAudioTransport reads them.
END_QUIET_SECONDS = 0.8
MAX_UTTERANCE_SECONDS = 6
# Silero confirms speech only after its 0.2 s start window, so the frames just before it are kept.
PREROLL_FRAMES = 25
PLAYBACK_GRACE_SECONDS = 5
STOP_COMMANDS = ('systemctl --user stop kestrel-voice.service', 'systemctl --user start kestrel-voice.service')


def classify(transcript: str) -> str:
    """Exact whole-utterance yes or no; anything else is unclear."""
    text = transcript.strip().lower().replace('’', "'").replace('‘', "'")
    text = ' '.join(re.sub(r'[.,!?]', '', text).split())
    if text in YES:
        return 'yes'
    if text in NO:
        return 'no'
    return 'unclear'


def pcm16(audio) -> bytes:
    return (np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes()


def wav16k(pcm: bytes) -> bytes:
    prepared = io.BytesIO()
    with wave.open(prepared, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(pcm)
    return prepared.getvalue()


def voice_service_refusal() -> str | None:
    try:
        state = subprocess.run(['systemctl', '--user', 'is-active', 'kestrel-voice.service'],
                               capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError) as error:
        return f'Could not check whether the voice service is running ({error}).'
    if state == 'active':
        return ("Kestrel's voice service is running; it owns the kestrel-microphone source and its echo removal.\n"
                'Stop it, run this prototype, then start it again:\n  ' + '\n  '.join(STOP_COMMANDS))
    return None


async def load_recognizer():
    recognizer = NemotronRecognizer()
    # load() spawns asr_worker.py, waits for {"ready": true} and warms up on one second of 48 kHz silence.
    await recognizer.load(bytes(96000))
    return recognizer


async def check() -> int:
    phonon = load_phonon()
    recognizer = await load_recognizer()
    try:
        failures = 0
        for phrase, expected in CHECKS:
            audio = phonon.synth(spoken_numbers(phrase), voice=PHONON_VOICE, seed=1234)
            pcm = pcm16(soxr.resample(audio, 24000, 16000, quality='HQ'))
            transcript = await recognizer.transcribe(wav16k(pcm), admitted=lambda: True)
            result = classify(transcript)
            print(f'{phrase!r}: transcript={transcript!r} class={result} expected={expected}', flush=True)
            failures += result != expected
        empty = classify('')
        print(f"'' (empty transcript): class={empty} expected=unclear", flush=True)
        failures += empty != 'unclear'
    finally:
        await recognizer.close()
    print('check passed' if not failures else f'check FAILED: {failures} mismatch(es)', flush=True)
    return 1 if failures else 0


class PermissionExchange:
    def __init__(self, phonon, recognizer, vad, wording, wait):
        self.phonon = phonon
        self.recognizer = recognizer
        self.vad = vad
        self.wording = wording
        self.wait = wait
        self.trials = 0
        self.inbox: asyncio.Queue | None = None

    def captured(self, pcm: bytes) -> None:
        if self.inbox is not None:
            self.inbox.put_nowait(pcm)

    def report(self, phase, action, began='-', transcript='-', result='-', outcome='-'):
        print(f'phase={phase} | action={action!r} | wording={self.wording} | wait={self.wait:g}s | '
              f'speech began={began} | transcript={transcript!r} | class={result} | outcome={outcome}', flush=True)

    async def speak(self, text: str) -> None:
        audio = await asyncio.to_thread(self.phonon.synth, spoken_numbers(text), voice=PHONON_VOICE, seed=1234)
        pcm = pcm16(soxr.resample(audio, 24000, 48000, quality='HQ'))
        guard = [*BOUND_TO_KESTREL]
        guard[2] = 'KILL'
        player = await asyncio.create_subprocess_exec(
            *guard, str(os.getpid()), 'pw-cat', '--playback', '--raw', '--rate', '48000', '--channels', '1',
            '--format', 's16', '--latency', '20ms', '-', stdin=asyncio.subprocess.PIPE, start_new_session=True,
        )
        try:
            async with asyncio.timeout(len(pcm) / 96000 + PLAYBACK_GRACE_SECONDS):
                player.stdin.write(pcm)
                await player.stdin.drain()
                # pw-cat plays what it has buffered before exiting on end of input.
                player.stdin.close()
                if await player.wait():
                    raise RuntimeError(f'Playback failed (pw-cat exit code {player.returncode}).')
        finally:
            if player.returncode is None:
                player.kill()
                await asyncio.wait_for(player.wait(), PLAYBACK_GRACE_SECONDS)

    async def listen(self):
        """Return (seconds until speech began, 16 kHz PCM, cut off by the limit), or (None, None, False) after silence
        for the whole wait."""
        loop = asyncio.get_running_loop()
        self.vad.set_params(self.vad.params)  # Resets the detection state left by the previous trial.
        self.inbox = asyncio.Queue()
        try:
            opened = loop.time()
            preroll = deque(maxlen=PREROLL_FRAMES)
            while True:
                remaining = opened + self.wait - loop.time()
                if remaining <= 0:
                    return None, None, False
                try:
                    pcm = await asyncio.wait_for(self.inbox.get(), remaining)
                except TimeoutError:
                    return None, None, False
                preroll.append(pcm)
                if await self.vad.analyze_audio(pcm) == VADState.SPEAKING:
                    break
            began = loop.time() - opened
            utterance = list(preroll)
            spoken = quiet = 0.0
            while quiet < END_QUIET_SECONDS and spoken < MAX_UTTERANCE_SECONDS:
                pcm = await self.inbox.get()
                utterance.append(pcm)
                spoken += FRAME_SECONDS
                state = await self.vad.analyze_audio(pcm)
                quiet = quiet + FRAME_SECONDS if state in (VADState.QUIET, VADState.STOPPING) else 0.0
            # True only when the limit, not the quiet ending, stopped the capture.
            return began, b''.join(utterance), quiet < END_QUIET_SECONDS
        finally:
            self.inbox = None

    async def trial(self) -> None:
        action = ACTIONS[self.trials % len(ACTIONS)]
        self.trials += 1
        self.report('speaking read-back', action)
        await self.speak(WORDINGS[self.wording](action))
        self.report('listening', action)
        began, pcm, cut_off = await self.listen()
        if pcm is None:
            began, transcript, result = '-', '', 'silence'
        else:
            began = f'{began:.2f}s'
            self.report('recognising', action, began)
            try:
                transcript = await self.recognizer.transcribe(wav16k(pcm), admitted=lambda: True)
                result = 'unclear' if cut_off else classify(transcript)
            except RuntimeError as error:
                print(f'Recognition error: {error}', flush=True)
                transcript, result = '', 'unclear'
        outcome, reply = OUTCOMES[result]
        shown = 'unclear (cut off)' if cut_off else result
        self.report('speaking outcome', action, began, transcript, shown, outcome)
        await self.speak(reply)
        self.report('done', action, began, transcript, shown, outcome)


async def read_line() -> str:
    loop = asyncio.get_running_loop()
    ready = loop.create_future()

    def readable():
        if not ready.done():
            ready.set_result(None)

    loop.add_reader(sys.stdin, readable)
    try:
        await ready
    finally:
        loop.remove_reader(sys.stdin)
    return sys.stdin.readline()


async def converse(wording: str, wait: float) -> None:
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    closing = False

    def end():
        if not closing:
            task.cancel()

    def stopped():
        loop.call_soon_threadsafe(end)

    phonon = load_phonon()
    recognizer = await load_recognizer()
    echo = EchoRemoval()
    transport = None
    try:
        vad = SileroVADAnalyzer(sample_rate=16000, params=VADParams(confidence=0.5))
        vad.set_sample_rate(16000)
        exchange = PermissionExchange(phonon, recognizer, vad, wording, wait)
        echo.start(stopped)
        transport = LaptopAudioTransport(echo, on_stopped=stopped, admitted=lambda: True,
                                         capture_pcm=exchange.captured)
        await transport.open()
        while True:
            print('Enter: next trial | w A|B|C: wording | t N: wait seconds | q: quit', flush=True)
            command = await read_line()
            words = command.split()
            if not command or words == ['q']:
                return
            if not words:
                await exchange.trial()
            elif len(words) == 2 and words[0] == 'w' and words[1].upper() in WORDINGS:
                exchange.wording = words[1].upper()
            elif len(words) == 2 and words[0] == 't' and re.fullmatch(r'\d+(\.\d+)?', words[1]) \
                    and float(words[1]) > 0:
                exchange.wait = float(words[1])
            else:
                print(f'Unknown command: {command.strip()!r}', flush=True)
                continue
            exchange.report('ready', ACTIONS[exchange.trials % len(ACTIONS)])
    finally:
        closing = True
        if transport is not None:
            await transport.close()
        await recognizer.close()
        echo.close()


def positive_seconds(value: str) -> float:
    seconds = float(value)
    if not (math.isfinite(seconds) and seconds > 0):
        raise argparse.ArgumentTypeError('must be a positive number of seconds')
    return seconds


def main() -> int:
    parser = argparse.ArgumentParser(description='PROTOTYPE: spoken permission exchange.')
    parser.add_argument('--wording', choices=sorted(WORDINGS), default='A')
    parser.add_argument('--wait', type=positive_seconds, default=6.0)
    parser.add_argument('--check', action='store_true',
                        help='prove synthesis, recognition and classification without microphone or speakers')
    args = parser.parse_args()
    try:
        if args.check:
            return asyncio.run(check())
        refusal = voice_service_refusal()
        if refusal is not None:
            print(refusal, file=sys.stderr)
            return 2
        asyncio.run(converse(args.wording, args.wait))
        return 0
    except RuntimeError as error:
        print(f'Stopped: {error}', file=sys.stderr)
        return 1
    except asyncio.CancelledError:
        print('Stopped: echo removal or laptop audio failed; see the messages above.', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('Stopped.', file=sys.stderr)
        return 130


if __name__ == '__main__':
    sys.exit(main())
