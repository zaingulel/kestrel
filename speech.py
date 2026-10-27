"""Local speech adapters for the Pipecat conversation pipeline."""

import asyncio
from asyncio import sleep
import base64
import io
import hashlib
import json
import os
import re
from dataclasses import dataclass
import stat
import subprocess
import sys
import threading
import wave
from pathlib import Path
from time import monotonic

import inflect
import numpy as np
import soxr
from loguru import logger
from wetext import Normalizer
from pipecat.audio.resamplers.soxr_resampler import SOXRAudioResampler
from pipecat.frames.frames import (
    CancelFrame, DataFrame, EndFrame, Frame, InputAudioRawFrame, InterruptionFrame, LLMFullResponseEndFrame,
    LLMFullResponseStartFrame, LLMTextFrame, TranscriptionFrame, TTSAudioRawFrame,
    TTSSpeakFrame, TTSStartedFrame, TTSStoppedFrame, TTSTextFrame, VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.settings import STTSettings, TTSSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.services.tts_service import TTSService
from pipecat.utils.time import time_now_iso8601
from pipecat.transports.base_input import BaseInputTransport
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import TransportParams

from hermes_worker import DELIVERY_LABELS
from reply_progress import (
    REPLY_MESSAGES, AcknowledgementDueFrame, AcknowledgementStartedFrame, AcknowledgementStoppedFrame, ConversationSynthesisFailedFrame,
    OutputBuffer, ReplyProgress, SpeechAdvisoryFrame, token_of,
)

_ENGLISH_NORMALIZER = Normalizer(lang="en", operator="tn")
_NUMBER_WORDS = inflect.engine()

ROOT = Path(__file__).parent
PHONON_ASSETS = {
    'config.json': (4634, 'b5d0f88353638370d94035b7d73d7d6577c0554d78f8d7ecfd40490aae39ae85'),
    'tokenizer.json': (277967, '691a00068fa7b989f2f3e5ae5daa2d1a5bb319f2d5360deafcfb19a8bb6e7936'),
    'model.q8.gguf': (64512352, 'a7d9aad2cd6dc66473f24a08bc6d2939030ef4d751ef82349361fbef3272dbae'),
    'default-voice.safetensors': (256136, 'f739e8c4c76ee7f92e7c94a82002748c8cd22e99582ac49f7b9b94cd63786e18'),
}


PHONON_VOICE = 'bryony'
PHONON_BRYONY_ASSET = (
    'phonon-bryony-gfP44RlHwr2kEwk7.safetensors', 256136,
    'bcc207a73b7885e45b49ab633d3377a10158292e3a7cef9cd6764ad107f1cb9b',
)


def load_phonon():
    """Admit the pinned local checkpoint and Bryony before native loading."""
    advice = ('Phonon assets are invalid. Restore the pinned local Phonon assets, including '
              'the Bryony file phonon-bryony-gfP44RlHwr2kEwk7.safetensors, and restart Kestrel.')

    def verify(source, size, digest):
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != size:
            raise RuntimeError(advice)
        checksum = hashlib.sha256()
        remaining = size
        while remaining:
            block = source.read(min(65536, remaining))
            if not block:
                raise RuntimeError(advice)
            checksum.update(block)
            remaining -= len(block)
        if source.read(1) or checksum.hexdigest() != digest:
            raise RuntimeError(advice)

    try:
        models = (ROOT / '.runtime/models').resolve(strict=True)
        directory = models / 'phonon-31m-en-q8'
        if not stat.S_ISDIR(directory.lstat().st_mode) or {p.name for p in directory.iterdir()} != set(PHONON_ASSETS):
            raise RuntimeError(advice)
        for name, (size, digest) in PHONON_ASSETS.items():
            asset = directory / name
            if not stat.S_ISREG(asset.lstat().st_mode):
                raise RuntimeError(advice)
            with os.fdopen(os.open(asset, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as source:
                verify(source, size, digest)
        name, size, digest = PHONON_BRYONY_ASSET
        asset = models / name
        if not stat.S_ISREG(asset.lstat().st_mode):
            raise RuntimeError(advice)
        with os.fdopen(os.open(asset, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as source:
            verify(source, size, digest)
            runtime_advice = ('Phonon is unavailable. Restore ptts 0.4.0 and the pinned local assets, '
                              'including Bryony, then restart Kestrel.')
            try:
                import ptts

                if getattr(ptts, '__version__', None) != '0.4.0':
                    raise RuntimeError(runtime_advice)
                ptts.set_num_threads(4)
                model = ptts.TTS(str(directory), lang='en', quant='q8', device='cpu')
                if model.sample_rate != 24000 or 'default' not in model.voices:
                    raise RuntimeError(runtime_advice)
                model.add_voice(PHONON_VOICE, f'/proc/self/fd/{source.fileno()}')
                if PHONON_VOICE not in model.voices:
                    raise RuntimeError(runtime_advice)
                return model
            except Exception as error:
                raise RuntimeError(runtime_advice) from error
    except OSError as error:
        raise RuntimeError(advice) from error


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
LAPTOP_PLAYBACK_FAILURE = "Audio playback failed. Restart Kestrel."
LAPTOP_CAPTURE_FAILURE = "Microphone capture failed. Restart Kestrel."


def _standalone_number(token: str, start: int, stop: int) -> bool:
    """Whether a native numeric span is the token's whole quantity, not a compound, ellipsis or zero-padded code."""
    whole = token[start:stop].lstrip('-').replace(',', '')
    return not (any(character.isdigit() for character in token[:start] + token[stop:])
                or token[start - 1:start] == '.'
                or whole[:1] == '0' and whole[1:2].isdigit())


def spoken_numbers(text: str) -> str:
    """Word WeText-classified cardinal, decimal and percent spans; every other character stays as written."""
    parts = []
    end = 0
    for match in re.finditer(r'\S+', text):
        parts.append(text[end:match.start()])
        token = match.group()
        if any(character.isdigit() for character in token) and not any(character.isalpha() for character in token):
            try:
                result = _ENGLISH_NORMALIZER.normalize_with_mapping(token)
                replacements = []
                previous_end = 0
                for mapping in sorted(result.mappings, key=lambda mapping: mapping.input_start):
                    percent = mapping.token_type == 'measure' and mapping.input_text.endswith('%')
                    if mapping.kind != 'replace' or not (mapping.token_type in ('cardinal', 'decimal') or percent):
                        continue
                    start, stop = mapping.input_start, mapping.input_end
                    if not (0 <= start < stop <= len(token)) or start < previous_end or token[start:stop] != mapping.input_text:
                        raise ValueError('Inconsistent numeric source mapping')
                    if not _standalone_number(token, start, stop):
                        replacements = None
                        break
                    source = token[start:stop]
                    words = _NUMBER_WORDS.number_to_words(source[:-1]) + ' percent' if percent else _NUMBER_WORDS.number_to_words(source)
                    replacements.extend((token[previous_end:start], words))
                    previous_end = stop
                if replacements is not None:
                    replacements.append(token[previous_end:])
                    token = ''.join(replacements)
            except Exception:
                # Any failure to read or word this text keeps the written form; it runs before model work.
                logger.warning('Number reading unavailable; speaking the written form.')
        parts.append(token)
        end = match.end()
    parts.append(text[end:])
    return ''.join(parts)


@dataclass(frozen=True)
class VoicePreset:
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
    return VoicePreset(reference, transcript, pcm)


OUTPUT_SWITCH_FAILURE = 'Audio output handover failed. Restart Kestrel.'
OUTPUT_WATCH_FAILURE = 'Audio output monitoring failed. Restart Kestrel.'


class PipeWireGraphCleanupFailure(RuntimeError):
    pass


async def _close_pipewire(process):
    if process.stdout is not None and process.stdout._transport is not None:
        process.stdout._transport.close()
    if process.returncode is None:
        process.terminate()
    try:
        await asyncio.wait_for(process.wait(), 5)
    except TimeoutError:
        process.kill()
        await asyncio.wait_for(process.wait(), 5)


async def _pipewire_graph():
    process = None
    try:
        async with asyncio.timeout(5):
            process = await asyncio.create_subprocess_exec(
                'pw-dump', stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
            data = bytearray()
            while block := await process.stdout.read(65536):
                data.extend(block)
                if len(data) > 8 * 1024 * 1024:
                    raise ValueError
            if await process.wait() != 0:
                raise ValueError
            try:
                graph = json.loads(data)
            except RecursionError:
                raise ValueError from None
            if not isinstance(graph, list):
                raise ValueError
            ids = set()
            for item in graph:
                if (not isinstance(item, dict) or type(item.get('id')) is not int or item['id'] in ids
                        or not isinstance(item.get('type'), str)):
                    raise ValueError
                ids.add(item['id'])
                if item['type'] == 'PipeWire:Interface:Link':
                    info = item.get('info')
                    if (not isinstance(info, dict) or type(info.get('output-node-id')) is not int
                            or type(info.get('input-node-id')) is not int or not isinstance(info.get('state'), str)):
                        raise ValueError
            return graph
    finally:
        if process is not None:
            cleanup = asyncio.create_task(_close_pipewire(process))
            try:
                try:
                    await asyncio.shield(cleanup)
                except asyncio.CancelledError:
                    await cleanup
                    raise
            except Exception:
                raise PipeWireGraphCleanupFailure(OUTPUT_SWITCH_FAILURE) from None


class OutputDeviceWatch:
    def __init__(self):
        self.process = None
        self.reader = None
        self.close_task = None
        self.revision = 0
        self.metadata_id = None
        self.selected_serial = None
        self.closed = False

    async def start(self, on_change, on_failed):
        try:
            self.process = await asyncio.create_subprocess_exec(
                *BOUND_TO_KESTREL, str(os.getpid()), 'stdbuf', '-oL', 'pw-dump',
                '-m', '-N', '-R', 'default',
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=8192,
                start_new_session=True,
            )
            async with asyncio.timeout(5):
                record = await self._record()
                self.metadata_id = record["id"]
                self.revision += 1
            self.selected_serial = await self._selection()
            if self.selected_serial is None:
                on_change()
            self.reader = asyncio.create_task(self._watch(on_change, on_failed))
        except asyncio.CancelledError:
            await self.close()
            raise
        except Exception:
            await self.close()
            raise RuntimeError(OUTPUT_WATCH_FAILURE) from None

    async def _line(self):
        line = await self.process.stdout.readline()
        if not line.endswith(b'\n') or len(line) > 8192:
            raise ValueError
        text = line[:-1].decode('utf-8')
        if any(ord(c) < 32 or ord(c) == 127 for c in text):
            raise ValueError
        return text

    async def _record(self):
        batch = json.loads(await self._line())
        if not isinstance(batch, list) or len(batch) != 1:
            raise ValueError
        item = batch[0]
        if (not isinstance(item, dict) or type(item.get('id')) is not int or item['id'] < 0
                or item.get('type') != 'PipeWire:Interface:Metadata'
                or not isinstance(item.get('props'), dict) or item['props'].get('metadata.name') != 'default'
                or not isinstance(item.get('metadata'), list)
                or self.metadata_id is not None and item['id'] != self.metadata_id):
            raise ValueError
        if any(not isinstance(entry, dict) or type(entry.get('subject')) is not int or entry['subject'] < 0
               or not isinstance(entry.get('key'), str) for entry in item['metadata']):
            raise ValueError
        return item

    async def _selection(self):
        graph = await _pipewire_graph()
        metadata = [item for item in graph if item['type'] == 'PipeWire:Interface:Metadata'
                    and item.get('props', {}).get('metadata.name') == 'default']
        if len(metadata) != 1 or metadata[0]['id'] != self.metadata_id:
            raise ValueError
        selected = EchoRemoval._selected_output(graph)
        return selected['info']['props']['object.serial'] if selected is not None else None

    async def _watch(self, on_change, on_failed):
        try:
            while True:
                record = await self._record()
                explicit = any(entry['subject'] == 0 and entry['key'] == 'default.audio.sink'
                               for entry in record['metadata'])
                if explicit:
                    self.revision += 1
                    on_change()
                selected = await self._selection()
                if not explicit and selected != self.selected_serial:
                    self.revision += 1
                    on_change()
                self.selected_serial = selected
        except PipeWireGraphCleanupFailure:
            raise
        except (Exception, asyncio.CancelledError):
            pass
        finally:
            if not self.closed:
                on_failed()

    async def close(self):
        if self.close_task is None:
            self.closed = True
            self.close_task = asyncio.create_task(self._close())
        try:
            try:
                await asyncio.shield(self.close_task)
            except asyncio.CancelledError:
                await self.close_task
                raise
        except (OSError, TimeoutError):
            raise RuntimeError(OUTPUT_WATCH_FAILURE) from None

    async def _close(self):
        failure = None
        try:
            if self.reader is not None:
                self.reader.cancel()
                try:
                    await self.reader
                except asyncio.CancelledError:
                    pass
        except PipeWireGraphCleanupFailure as error:
            failure = error
        finally:
            try:
                if self.process is not None:
                    await _close_pipewire(self.process)
            finally:
                if failure is not None:
                    raise failure


class EchoRemoval:
    def __init__(self):
        self.process = None
        self._expected_exit = threading.Event()

    def start(self, on_stopped):
        # The parent-death signal follows the spawning thread, so this runs on the main thread,
        # and the new session keeps a terminal Ctrl+C from stopping echo removal first.
        self._expected_exit = threading.Event()
        self.process = subprocess.Popen(
            [*BOUND_TO_KESTREL, str(os.getpid()), "pipewire", "-c", ECHO_REMOVAL_CONFIG],
            env={**os.environ, "PIPEWIRE_CONFIG_DIR": str(ROOT)}, start_new_session=True,
        )
        threading.Thread(target=self._report_stop, args=(self.process, self._expected_exit, on_stopped), daemon=True).start()

    def _report_stop(self, process, expected_exit, on_stopped):
        code = process.wait()
        if not expected_exit.is_set():
            logger.error(
                f"Echo removal stopped (exit code {code}); stopping Kestrel, which never listens without it"
            )
            on_stopped()

    async def microphone_serial(self, capture_pid=None, *, output_serial=None) -> int:
        """Resolve the owned echo source and, when supplied, its owned recorder."""
        if self.process is None or self.process.poll() is not None:
            raise RuntimeError("Echo removal has stopped. Restart Kestrel.")
        try:
            graph = await _pipewire_graph()
            clients = {}
            nodes = []
            links = []
            for item in graph:
                kind = item["type"]
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
                    links.append(item["info"])

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
            if capture_pid is not None or output_serial is not None:
                selected = self._selected_output(graph)
                if selected is None:
                    raise ValueError
                if output_serial is not None and selected["info"]["props"]["object.serial"] != output_serial:
                    raise ValueError
                references = [item for item in nodes if item["info"]["props"].get("node.name") ==
                              "kestrel-echo-removal-reference"]
                if len(references) != 1 or owner(references[0]) != self.process.pid:
                    raise ValueError
                incoming = [info for info in links if info["input-node-id"] == references[0]["id"]]
                if not incoming or not all(info["output-node-id"] == selected["id"] and
                                           info["state"] == "active" for info in incoming):
                    raise ValueError
            return serial
        except (OSError, TimeoutError, ValueError, LookupError, TypeError, AttributeError):
            raise RuntimeError("The owned echo-removed microphone could not be verified. Restart Kestrel.") from None

    @staticmethod
    def _selected_output(graph):
        metadata = [item for item in graph if item.get('type') == 'PipeWire:Interface:Metadata'
                    and item.get('props', {}).get('metadata.name') == 'default']
        if len(metadata) != 1 or not isinstance(metadata[0]['metadata'], list):
            raise ValueError
        if any(not isinstance(entry, dict) or type(entry.get('subject')) is not int or entry['subject'] < 0
               or not isinstance(entry.get('key'), str) for entry in metadata[0]['metadata']):
            raise ValueError
        entries = [entry for entry in metadata[0]['metadata']
                   if entry['subject'] == 0 and entry['key'] == 'default.audio.sink']
        if not entries:
            return None
        if (len(entries) != 1 or entries[0]['type'] != 'Spa:String:JSON' or not isinstance(entries[0]['value'], dict)):
            raise ValueError
        name = entries[0]['value']['name']
        if not isinstance(name, str) or not name.strip() or any(ord(c) < 32 or ord(c) == 127 for c in name):
            raise ValueError
        outputs = [item for item in graph if item.get('type') == 'PipeWire:Interface:Node'
                   and item['info']['props'].get('node.name') == name
                   and item['info']['props'].get('media.class') == 'Audio/Sink']
        for output in outputs:
            serial = output['info']['props']['object.serial']
            if type(serial) is not int or serial <= 0:
                raise ValueError
        if len(outputs) != 1:
            return None
        return outputs[0]

    async def output_serial(self, playback_pid=None):
        try:
            graph = await _pipewire_graph()
            selected = self._selected_output(graph)
            if selected is None:
                raise ValueError
            if playback_pid is not None:
                clients = [item['id'] for item in graph if item['type'] == 'PipeWire:Interface:Client'
                           and type(item['info']['props']['pipewire.sec.pid']) is int
                           and item['info']['props']['pipewire.sec.pid'] == playback_pid]
                streams = [item for item in graph if item['type'] == 'PipeWire:Interface:Node'
                           and type(item['info']['props'].get('client.id')) is int
                           and item['info']['props']['client.id'] in clients]
                if len(streams) != 1:
                    raise ValueError
                outgoing = [item['info'] for item in graph if item['type'] == 'PipeWire:Interface:Link'
                            and item['info']['output-node-id'] == streams[0]['id']]
                if not outgoing or not all(link['input-node-id'] == selected['id'] and link['state'] == 'active'
                                           for link in outgoing):
                    raise ValueError
            return selected['info']['props']['object.serial']
        except (OSError, TimeoutError, ValueError, LookupError, TypeError, AttributeError):
            raise RuntimeError(OUTPUT_SWITCH_FAILURE) from None

    def close(self):
        process = self.process
        if process is None:
            return
        self._expected_exit.set()
        process.terminate()
        try:
            process.wait(timeout=ECHO_REMOVAL_STOP_WAIT)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=ECHO_REMOVAL_STOP_WAIT)


class LaptopInput(BaseInputTransport):
    def __init__(self, params, *, admitted):
        super().__init__(params)
        self.admitted = admitted
        self.ready = False

    async def drain_audio(self):
        if not self.ready or not self._params.audio_in_enabled:
            return
        # Pipecat 1.12 acknowledges after push_frame, including empty audio.
        # Keep its pump/queue alive; a failed pump cannot acknowledge quiescence.
        if self._audio_task is None or self._audio_task.done():
            raise RuntimeError(OUTPUT_SWITCH_FAILURE)
        await self._audio_in_queue.join()

    async def process_frame(self, frame, direction):
        if isinstance(frame, (DataFrame, InputAudioRawFrame)) and not self.admitted():
            return
        await super().process_frame(frame, direction)

    async def push_frame(self, frame, direction=FrameDirection.DOWNSTREAM):
        if isinstance(frame, (DataFrame, InputAudioRawFrame)) and not self.admitted():
            return
        await super().push_frame(frame, direction)

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


ACKNOWLEDGEMENT_DELAY = 2.0


class LaptopOutput(BaseOutputTransport):
    def __init__(self, audio, params):
        super().__init__(params)
        self.audio = audio
        self.write_lock = asyncio.Lock()
        self.playback_deadline: float | None = None
        self.write_gate = asyncio.Event()
        self.write_gate.set()
        self.output_buffer = OutputBuffer.for_params(params)
        self.reply_progress = None
        self.prepared_acknowledgements = ()
        self.acknowledgement_record = None
        self.acknowledgement_deadline = None
        self.acknowledgement_timer = None
        self.acknowledgement_tasks = set()
        self.acknowledgement_index = 0

    def _acknowledgement_now(self) -> float:
        return monotonic()

    def arm_acknowledgement(self, record: ReplyProgress) -> None:
        self.cancel_acknowledgement()
        self.acknowledgement_record = record
        previous_finish = record.on_finish

        def finished(finished_record):
            self.cancel_acknowledgement(finished_record)
            if previous_finish is not None:
                previous_finish(finished_record)

        record.on_finish = finished
        self.acknowledgement_deadline = self._acknowledgement_now() + ACKNOWLEDGEMENT_DELAY
        self.acknowledgement_timer = asyncio.get_running_loop().call_later(
            ACKNOWLEDGEMENT_DELAY, self._acknowledgement_due, record,
        )

    def cancel_acknowledgement(self, record: ReplyProgress | None = None) -> None:
        if record is not None and self.acknowledgement_record is not record:
            return
        if self.acknowledgement_timer is not None:
            self.acknowledgement_timer.cancel()
            self.acknowledgement_timer = None
        self.acknowledgement_record = None
        self.acknowledgement_deadline = None
        for task in self.acknowledgement_tasks:
            task.cancel()

    async def _observe_acknowledgement_tasks(self):
        self.cancel_acknowledgement()
        await asyncio.gather(*self.acknowledgement_tasks, return_exceptions=True)

    def _acknowledgement_due(self, record):
        if self.acknowledgement_record is not record:
            return
        if not self._allowed(record):
            self.cancel_acknowledgement(record)
            return
        task = asyncio.create_task(self.queue_frame(AcknowledgementDueFrame(record)))
        self.acknowledgement_tasks.add(task)

        def observed(done):
            try:
                done.result()
            except asyncio.CancelledError:
                pass
            except Exception:
                record.output_write_failed()
                self.audio.fail(LAPTOP_PLAYBACK_FAILURE)
            finally:
                self.acknowledgement_tasks.discard(done)

        task.add_done_callback(observed)

    def _allowed(self, record):
        return (not self.audio.closed and not self.audio.failure and self.write_gate.is_set()
                and (record is None or not record.closed)
                and (self.audio.admission is None or
                     (record is not None and self.audio.admission.may_speak(record.token))))

    async def _play_acknowledgement_locked(self, record, *, answer_pending: bool) -> bool:
        if self.acknowledgement_record is not record or not self._allowed(record):
            return False
        clip = self.prepared_acknowledgements[self.acknowledgement_index]
        section = record.open_section('neutral')
        start = TTSStartedFrame()
        record.stream_frame(start, section)
        success = False
        marker_started = False
        try:
            await self.push_frame(start)
            if not answer_pending:
                marker_started = True
                await self.broadcast_frame(AcknowledgementStartedFrame, reply_progress=record)
            for offset in range(0, len(clip.pcm), self.audio_chunk_size):
                if self.acknowledgement_record is not record or not self._allowed(record):
                    return False
                frame = TTSAudioRawFrame(clip.pcm[offset:offset + self.audio_chunk_size], 48000, 1)
                frame.reply_progress = record
                if offset == 0:
                    record.starts_text(frame, clip.text)
                record.stream_frame(frame, section)
                frame.prepared_credit = record.source_range(frame)
                try:
                    written = await asyncio.wait_for(
                        self._write_audio_locked(frame, record), self._params.audio_out_write_timeout_secs,
                    )
                except TimeoutError as error:
                    await self.push_error('Prepared acknowledgement audio write timed out', exception=error,
                                          force_treat_as_permanent=True)
                    self.audio.fail(LAPTOP_PLAYBACK_FAILURE)
                    return False
                if not written or not self._allowed(record):
                    return False
                if offset == 0:
                    self.acknowledgement_index = (self.acknowledgement_index + 1) % len(self.prepared_acknowledgements)
                await self.push_frame(frame)
            await self.audio._finish_playback()
            if not self._allowed(record):
                return False
            text = TTSTextFrame(clip.text, aggregated_by='sentence')
            text.append_to_context = False
            record.stream_frame(text, section)
            await self.push_frame(text)
            stop = TTSStoppedFrame()
            record.stream_frame(stop, section)
            await self.push_frame(stop)
            success = True
            return True
        finally:
            if not success:
                record.output_write_failed()
            self.cancel_acknowledgement(record)
            if marker_started:
                await self.broadcast_frame(AcknowledgementStoppedFrame, reply_progress=record)

    async def start(self, frame):
        await super().start(frame)
        await self.set_transport_ready(frame)

    async def process_frame(self, frame, direction):
        if isinstance(frame, InterruptionFrame):
            self.cancel_acknowledgement()
            self.write_gate.clear()
            try:
                # Native sender cancellation discards its queued audio and cancels the pacing wait.
                await super().process_frame(frame, direction)
                self.reply_progress = None
                async with self.write_lock:
                    if self.audio.playback is not None:
                        await self.audio._discard_playback()
                        self.playback_deadline = None
            finally:
                self.write_gate.set()
        else:
            await super().process_frame(frame, direction)

    async def push_frame(self, frame, direction=FrameDirection.DOWNSTREAM):
        if direction == FrameDirection.DOWNSTREAM and self.audio.admission is not None:
            # Audio and frames of no reply play for the reply this output has bound.
            record = getattr(frame, 'reply_progress', None) or self.reply_progress
            token = record.token if record is not None else None
            if isinstance(frame, (TTSAudioRawFrame, TTSTextFrame, TTSStartedFrame, TTSStoppedFrame,
                                  LLMFullResponseStartFrame, LLMFullResponseEndFrame)) and not self.audio.admission.may_speak(token):
                return
        await super().push_frame(frame, direction)

    async def write_transport_frame(self, frame):
        if isinstance(frame, AcknowledgementDueFrame):
            record = frame.reply_progress
            await self.write_gate.wait()
            async with self.write_lock:
                if self.acknowledgement_record is record and self._allowed(record):
                    if not await self._open_playback_locked():
                        record.output_write_failed()
                        return
                    await self._play_acknowledgement_locked(record, answer_pending=False)
            return
        bound = self.reply_progress
        if isinstance(frame, TTSStartedFrame):
            self.reply_progress = getattr(frame, 'reply_progress', None)
        elif isinstance(frame, LLMFullResponseEndFrame) and bound is not None and token_of(frame) is bound.token:
            self.cancel_acknowledgement(bound)
            self.reply_progress = None
        await super().write_transport_frame(frame)

    async def cancel(self, frame):
        await self._observe_acknowledgement_tasks()
        try:
            await super().cancel(frame)
        finally:
            self.reply_progress = None

    async def stop(self, frame):
        await self._observe_acknowledgement_tasks()
        try:
            await super().stop(frame)
        finally:
            self.reply_progress = None

    async def cleanup(self):
        await self._observe_acknowledgement_tasks()
        await super().cleanup()

    async def write_audio_frame(self, frame) -> bool:
        record = self.reply_progress
        success = False
        try:
            await self.write_gate.wait()
            async with self.write_lock:
                if not self._allowed(record):
                    return False
                if not await self._open_playback_locked():
                    return False
                if not self._allowed(record):
                    return False
                if frame.audio and record is not None and self.acknowledgement_record is record:
                    if self._acknowledgement_now() >= self.acknowledgement_deadline:
                        if not await self._play_acknowledgement_locked(record, answer_pending=True):
                            return False
                        if not self._allowed(record):
                            return False
                        if not await self._open_playback_locked():
                            return False
                    else:
                        self.cancel_acknowledgement(record)
                success = await self._write_audio_locked(frame, record)
                return success
        finally:
            if not success:
                self.cancel_acknowledgement(record)
                if record is not None:
                    record.output_write_failed()
                self.output_buffer.write_failed(frame)

    async def _open_playback_locked(self) -> bool:
        if self.audio.playback is not None:
            return True
        try:
            await self.audio._open_playback()
            return True
        except (OSError, RuntimeError):
            self.audio.fail(LAPTOP_PLAYBACK_FAILURE)
            return False

    async def _write_audio_locked(self, frame, record) -> bool:
        try:
            duration = len(frame.audio) / (2 * frame.num_channels * frame.sample_rate)
            deadline = (self.playback_deadline if self.playback_deadline is not None else monotonic()) + duration
            if (not self._allowed(record) or
                    (getattr(frame, 'prepared_credit', None) is not None and self.acknowledgement_record is not record)):
                return False
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
    def __init__(self, echo_removal, *, on_stopped, admission, capture_enabled=True, capture_pcm=None):
        self.echo_removal = echo_removal
        self.admission = admission
        self.capture_pcm = capture_pcm
        self.capture_enabled = capture_enabled
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
        params = TransportParams(audio_in_enabled=capture_enabled, audio_out_enabled=True,
                                 audio_in_sample_rate=16000, audio_out_sample_rate=48000)
        self._input = LaptopInput(params, admitted=self.input_admitted)
        self._output = LaptopOutput(self, params)

        @self._output.event_handler("on_error")
        async def on_output_error(processor, frame):
            if not processor.is_usable:
                self.fail(LAPTOP_PLAYBACK_FAILURE)

    def input_admitted(self):
        # Capture handed to capture_pcm never enters the conversation.
        return self.capture_pcm is None and self.admission is not None and self.admission.admits_microphone()

    def input(self):
        return self._input

    def output(self):
        return self._output

    def fail(self, reason: str) -> None:
        self._output.cancel_acknowledgement()
        if self.failure is None and not self.closed:
            self.failure = reason
            self.verified = False
            self.received_audio.set()
            logger.error(reason)
            self.on_stopped()

    async def _source(self, capture_pid=None, *, output_serial=None):
        while True:
            if self.failure:
                raise RuntimeError(self.failure)
            try:
                return await self.echo_removal.microphone_serial(capture_pid, output_serial=output_serial)
            except PipeWireGraphCleanupFailure:
                raise
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
        await self._open_capture()

    async def suspend_capture(self):
        self.verified = False
        if self.reader is not None:
            self.reader.cancel()
            await asyncio.gather(self.reader, return_exceptions=True)
        await self._reap_audio(self.capture)
        self.capture = self.reader = None
        self.received_audio.clear()

    async def resume_capture(self, *, output_serial):
        if self.closed:
            raise RuntimeError(OUTPUT_SWITCH_FAILURE)
        await self._open_capture(output_serial=output_serial, refreshing=True)

    async def _open_capture(self, *, output_serial=None, refreshing=False):
        if not self.capture_enabled:
            return
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
                if await self._source(self.capture.pid, output_serial=output_serial) != serial:
                    raise RuntimeError(LAPTOP_CAPTURE_FAILURE)
                if self.failure:
                    raise RuntimeError(self.failure)
                await asyncio.wait_for(self.received_audio.wait(), LAPTOP_CAPTURE_STALL_TIMEOUT)
                if self.failure:
                    raise RuntimeError(self.failure)
                self.verified = True
        except asyncio.CancelledError:
            if refreshing:
                cleanup = asyncio.create_task(self.suspend_capture())
                try:
                    await asyncio.shield(cleanup)
                except asyncio.CancelledError:
                    await cleanup
                    raise
            else:
                await self.close()
            raise
        except (OSError, RuntimeError, TimeoutError):
            if refreshing:
                await self.suspend_capture()
                raise RuntimeError(LAPTOP_CAPTURE_FAILURE) from None
            self.fail(LAPTOP_CAPTURE_FAILURE)
            await self.close()
            raise RuntimeError(self.failure) from None

    async def _read(self):
        try:
            while True:
                pcm = await asyncio.wait_for(self.capture.stdout.readexactly(640), LAPTOP_CAPTURE_STALL_TIMEOUT)
                self.received_audio.set()
                if self.verified and not self.closed:
                    if self.capture_pcm is not None:
                        self.capture_pcm(pcm)
                    elif self._input.ready and self.input_admitted():
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
        await asyncio.wait_for(process.wait(), 5)
        if process.stdin is not None:
            try:
                await asyncio.wait_for(process.stdin.wait_closed(), 1)
            except (BrokenPipeError, ConnectionResetError):
                pass

    async def _discard_playback(self):
        process, self.playback = self.playback, None
        if self.playback_watcher is not None:
            self.playback_watcher.cancel()
            await asyncio.gather(self.playback_watcher, return_exceptions=True)
            self.playback_watcher = None
        await self._reap_audio(process)

    async def _finish_playback(self) -> None:
        process = self.playback
        watcher = self.playback_watcher
        cancelled = None

        async def join_watcher():
            if watcher is not None:
                watcher.cancel()
                await asyncio.gather(watcher, return_exceptions=True)
            self.playback_watcher = None

        async def drain():
            await process.stdin.wait_closed()
            if await process.wait() != 0:
                raise RuntimeError(LAPTOP_PLAYBACK_FAILURE)

        async def cleanup():
            await join_watcher()
            await self._reap_audio(process)
            self.playback = None

        try:
            await join_watcher()
            if process.returncode is not None or self.failure:
                raise RuntimeError(LAPTOP_PLAYBACK_FAILURE)
            process.stdin.close()
            await asyncio.wait_for(drain(), 5)
        except asyncio.CancelledError as error:
            cancelled = error
        except (OSError, RuntimeError, TimeoutError):
            self.fail(LAPTOP_PLAYBACK_FAILURE)
        else:
            self.playback = None
            return
        finally:
            self._output.playback_deadline = None

        # Keep the lock and child ownership until cleanup survives every outer cancellation.
        cleanup_task = asyncio.create_task(cleanup())
        while True:
            try:
                await asyncio.shield(cleanup_task)
                break
            except asyncio.CancelledError as error:
                cancelled = error
            except (OSError, RuntimeError, TimeoutError):
                self.fail(LAPTOP_PLAYBACK_FAILURE)
                break
        if cancelled is not None:
            raise cancelled

    async def close(self):
        self._output.cancel_acknowledgement()
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
        await self._output._observe_acknowledgement_tasks()
        if self.reader is not None:
            self.reader.cancel()
            await asyncio.gather(self.reader, return_exceptions=True)
        async with self._output.write_lock:
            await self._discard_playback()
        await self._reap_audio(self.capture)


class NemotronRecognizer:
    def __init__(self):
        self.process = None
        self.reader = None
        self.lock = asyncio.Lock()
        self.failure = None
        self.closed = False

    async def load(self, reference_pcm: bytes):
        try:
            self.process = await asyncio.create_subprocess_exec(
                str(ROOT / ".runtime/voice-venv/bin/python"), str(ROOT / "asr_worker.py"),
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
            await self.transcribe(prepared.getvalue(), admitted=lambda: True)
        except BaseException:
            await self.close()
            raise

    async def _reap(self):
        if self.process is not None and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except TimeoutError:
                self.process.kill()
                await asyncio.wait_for(self.process.wait(), 5)

    async def _exchange(self, audio: bytes, *, admitted) -> str | None:
        try:
            async with asyncio.timeout(60):
                if not admitted():
                    return None
                self.process.stdin.write(json.dumps({"audio": base64.b64encode(audio).decode()}).encode() + b'\n')
                await self.process.stdin.drain()
                response = await self.process.stdout.readline()
                if not response:
                    raise RuntimeError("Nemotron worker stopped. Restart Kestrel.")
                if len(response) > 65536:
                    raise RuntimeError("Nemotron returned an oversized response. Restart Kestrel.")
                result = json.loads(response)
                if not isinstance(result, dict):
                    raise RuntimeError("Invalid Nemotron response. Restart Kestrel.")
                if set(result) == {'error'} and isinstance(result['error'], str) and result['error']:
                    raise RuntimeError(result['error'])
                if set(result) != {'text'} or not isinstance(result['text'], str):
                    raise RuntimeError("Invalid Nemotron response. Restart Kestrel.")
                return result['text']
        except Exception as error:
            self.failure = f"Nemotron recognition failed: {str(error) or type(error).__name__}"
            await self._reap()
            raise RuntimeError(self.failure) from error

    async def transcribe(self, audio: bytes, *, admitted) -> str | None:
        async with self.lock:
            await self.drain()
            if self.closed or self.failure:
                raise RuntimeError(self.failure or "Nemotron is closed. Restart Kestrel.")
            self.reader = asyncio.create_task(self._exchange(audio, admitted=admitted))
            # The service retains the untagged response when a conversation is cancelled.
            return await asyncio.shield(self.reader)

    async def drain(self):
        if self.reader is not None:
            task = self.reader
            try:
                await asyncio.shield(task)
            finally:
                if task.done():
                    self.reader = None

    async def close(self):
        self.closed = True
        if self.reader is not None:
            self.reader.cancel()
            await asyncio.gather(self.reader, return_exceptions=True)
            self.reader = None
        await self._reap()


class NemotronSTT(SegmentedSTTService):
    def __init__(self, recognizer: NemotronRecognizer, *, admission):
        super().__init__(
            sample_rate=16000,
            settings=STTSettings(model="nemotron-speech-streaming-en-0.6b", language=None),
        )
        self.recognizer = recognizer
        self.admission = admission
        self.awaiting_fresh_vad = False

    async def discard_pending(self):
        # Pipecat 1.12 segmented STT has no public buffer/queue reset. Keep this
        # adapter aligned with its worker ownership when upgrading the pin.
        self.awaiting_fresh_vad = True
        await self._cancel_segment_task()
        self._audio_buffer.clear()
        self._user_speaking = False
        while True:
            try:
                self._segment_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        self._segment_task = self.create_task(self._segment_task_handler())

    async def process_audio_frame(self, frame, direction):
        if not self.awaiting_fresh_vad:
            await super().process_audio_frame(frame, direction)

    async def process_frame(self, frame, direction):
        if not self.admission.admits_microphone() and isinstance(frame, (
            DataFrame, InputAudioRawFrame, VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame,
        )):
            return
        if isinstance(frame, VADUserStartedSpeakingFrame):
            self.awaiting_fresh_vad = False
        elif isinstance(frame, VADUserStoppedSpeakingFrame) and self.awaiting_fresh_vad:
            return
        await super().process_frame(frame, direction)

    async def push_frame(self, frame, direction=FrameDirection.DOWNSTREAM):
        if isinstance(frame, (DataFrame, InputAudioRawFrame)) and not self.admission.admits_microphone():
            return
        if isinstance(frame, TranscriptionFrame) and not self.admission.is_current(getattr(frame, 'input_mark', None)):
            return
        await super().push_frame(frame, direction)

    async def run_stt(self, audio):
        if not self.admission.admits_microphone():
            return
        mark = self.admission.input_mark()
        text = await self.recognizer.transcribe(
            audio, admitted=lambda: self.admission.admits_microphone() and self.admission.is_current(mark))
        if self.admission.admits_microphone() and self.admission.is_current(mark) and text:
            frame = TranscriptionFrame(text, "", time_now_iso8601(), finalized=True)
            frame.input_mark = mark
            yield frame


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
        self.label_escaped = False
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
            if char == '[' and self.label is None:
                self._lex(char)
                self.label_escaped = True
                return
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
        self.label_escaped = False
        old_addresses = self._restore_label_join(saved)
        if '[delivery:' in '[' + text:
            self._omit()
        elif linked:
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
                self.label_escaped = False
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
            if char == '(' and not self.label_escaped:
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


@dataclass(frozen=True)
class PreparedAcknowledgement:
    text: str
    pcm: bytes


class ConversationTTS(TTSService):
    def __init__(self, model, *, settings: TTSSettings, generation_lock=None, admission=None):
        super().__init__(
            sample_rate=48000, push_start_frame=True, push_stop_frames=True,
            settings=settings,
        )
        self.model = model
        self.admission = admission
        self._generation_lock = generation_lock if generation_lock is not None else asyncio.Lock()
        self.generation_cleanup_failed = False
        self._spoken_reply = SpokenReplyText()
        # The reply whose start or local speech this service processed last, and its expression setting.
        self._reply = None
        self._delivery = 'neutral'
        self._turns = {}
        self._sections = {}

    def section(self, context_id):
        return self._sections.get(context_id)

    async def on_turn_context_created(self, context_id: str):
        await super().on_turn_context_created(context_id)
        self._turns.clear()
        self._turns[context_id] = (self._reply, self._delivery)

    def _open_section(self, context_id):
        record, delivery = self._turns.get(context_id, (None, 'neutral'))
        if record is not None:
            self._sections[context_id] = record.open_section(delivery)

    async def create_audio_context(self, context_id: str):
        # Pipecat also calls this to recreate a retired context within the turn, which opens a new section.
        self._open_section(context_id)
        await super().create_audio_context(context_id)

    async def on_audio_context_completed(self, context_id: str):
        await super().on_audio_context_completed(context_id)
        self._sections.pop(context_id, None)

    async def append_to_audio_context(self, context_id: str | None, frame):
        await super().append_to_audio_context(context_id, frame)
        section = self.section(context_id)
        if self.audio_context_available(context_id) and section is not None and isinstance(frame, Frame):
            section.reply.stream_frame(frame, section)

    async def push_frame(self, frame, direction=FrameDirection.DOWNSTREAM):
        if direction == FrameDirection.DOWNSTREAM:
            context_id = getattr(frame, 'context_id', None)
            if isinstance(frame, TTSStartedFrame) and self.section(context_id) is None:
                self._open_section(context_id)
            section = self.section(context_id)
            if section is not None:
                section.reply.stream_frame(frame, section)
            if isinstance(frame, REPLY_MESSAGES) and not hasattr(frame, 'reply_progress'):
                frame.reply_progress = self._reply
            if self.admission is not None:
                token = section.reply.token if section is not None else token_of(frame)
                if isinstance(frame, (TTSAudioRawFrame, TTSTextFrame, TTSStartedFrame, TTSStoppedFrame,
                                      LLMTextFrame, LLMFullResponseStartFrame, LLMFullResponseEndFrame)) and not self.admission.may_speak(token):
                    return
        await super().push_frame(frame, direction)

    async def process_frame(self, frame, direction):
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, (LLMFullResponseStartFrame, TTSSpeakFrame)):
                self._reply = getattr(frame, 'reply_progress', None)
                self._delivery = (self._reply.delivery if isinstance(frame, LLMFullResponseStartFrame) and self._reply is not None
                                  else 'neutral')
            elif isinstance(frame, LLMTextFrame) and not hasattr(frame, 'reply_progress'):
                frame.reply_progress = self._reply
        if isinstance(frame, (InterruptionFrame, CancelFrame, EndFrame)):
            self._spoken_reply.reset()
        elif direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, LLMFullResponseStartFrame):
                self._spoken_reply.start()
            elif isinstance(frame, SpeechAdvisoryFrame):
                # Pipecat owns the active turn ID; older queued audio keeps its own delivery.
                context_id = self._turn_context_id
                if context_id in self._turns:
                    record, _ = self._turns[context_id]
                    self._turns[context_id] = (record, 'neutral')
                section = self.section(context_id)
                if section is not None:
                    section.delivery = 'neutral'
                tail = self._spoken_reply.finish(failed=True)
                if tail.strip():
                    separator = ' ' if tail.rstrip().endswith(('.', '!', '?')) else '. '
                    frame.text = tail.rstrip() + separator + frame.text.lstrip()
            elif isinstance(frame, LLMTextFrame):
                frame.text = self._spoken_reply.feed(frame.text)
            elif isinstance(frame, LLMFullResponseEndFrame):
                tail = self._spoken_reply.finish()
                if tail:
                    tail_frame = LLMTextFrame(tail)
                    tail_frame.reply_progress = getattr(frame, 'reply_progress', None)
                    await super().process_frame(tail_frame, direction)
        await super().process_frame(frame, direction)
        if isinstance(frame, (InterruptionFrame, CancelFrame, EndFrame)):
            self._turns.clear()
            self._sections.clear()
            self._reply = None

    async def run_tts(self, text, context_id):
        section = self.section(context_id)
        delivery = section.delivery if section is not None else 'neutral'

        def allowed():
            return self.admission is None or (section is not None and self.admission.may_speak(section.reply.token))

        text_started = False
        try:
            # Never overlap model calls, including a chunk still finishing after interruption.
            async with self._generation_lock:
                if self.generation_cleanup_failed:
                    raise RuntimeError('Voice generation cleanup failed. Restart Kestrel.')
                if not allowed():
                    return
                chunks = None

                def next_chunk():
                    # Built in the owned next() worker, so cleanup observes normalization like model work.
                    nonlocal chunks
                    if chunks is None:
                        chunks = self._generate_chunks(text, delivery=delivery)
                    return next(chunks, None)
                pending = None
                try:
                    while True:
                        pending = asyncio.create_task(asyncio.to_thread(next_chunk))
                        chunk = await asyncio.shield(pending)
                        if chunk is None or not allowed():
                            break
                        pcm = (np.clip(chunk, -1, 1) * 32767).astype("<i2").tobytes()
                        frame = TTSAudioRawFrame(pcm, 48000, 1, context_id=context_id)
                        if pcm and not text_started:
                            if section is not None:
                                section.reply.starts_text(frame, text)
                            text_started = True
                        yield frame
                finally:
                    body_error = sys.exception()

                    async def finish_generation() -> None:
                        next_error = None
                        try:
                            try:
                                if pending is not None:
                                    await pending
                            except Exception as error:
                                next_error = error
                                raise
                            finally:
                                try:
                                    if chunks is not None:
                                        await asyncio.to_thread(chunks.close)
                                except Exception as error:
                                    if next_error is not None:
                                        raise error from next_error
                                    raise
                        except Exception:
                            self.generation_cleanup_failed = True
                            raise

                    # Pipecat can cancel again during terminal cleanup. The native work
                    # and its close operation must finish before this lock can be released.
                    cleanup = asyncio.create_task(finish_generation())
                    cancelled = False
                    while not cleanup.done():
                        try:
                            await asyncio.shield(cleanup)
                        except asyncio.CancelledError:
                            cancelled = True
                    cleanup.result()
                    if cancelled and body_error is None:
                        raise asyncio.CancelledError
        except Exception:
            live = self.section(context_id)
            if section is not None and live is not None and live.reply is section.reply:
                live.skip_text()
            if section is not None:
                await self.push_frame(ConversationSynthesisFailedFrame(reply_progress=section.reply, section=section))
            raise


class VoxCPMTTS(ConversationTTS):
    def __init__(self, model, preset: VoicePreset, *, generation_lock=None, admission=None):
        super().__init__(model, settings=TTSSettings(model="VoxCPM2", voice=None, language=None),
                         generation_lock=generation_lock, admission=admission)
        self.preset = preset

    def _generate_chunks(self, text: str, *, delivery: str):
        styles = {
            'curious': '(Subtly curious and interested, natural conversational delivery)',
            'gently_pleased': '(Gently pleased, with a subtle smile in the voice)',
            'reassuring': '(Warm, gentle and reassuring, speaking calmly)',
        }
        if delivery == 'neutral':
            prompt = dict(prompt_wav_path=str(self.preset.reference), prompt_text=self.preset.transcript)
            prefix = ''
        elif delivery in styles:
            prompt = {}
            prefix = styles[delivery] + ' '
        else:
            raise RuntimeError('Invalid internal speech delivery')
        return self.model.generate_streaming(
            text=prefix + spoken_numbers(text), **prompt,
            reference_wav_path=str(self.preset.reference),
            inference_timesteps=10, max_len=400, retry_badcase=False,
        )


class PhononTTS(ConversationTTS):
    def __init__(self, model, *, generation_lock=None, admission=None):
        super().__init__(model, settings=TTSSettings(model="Phonon 31M q8", voice=PHONON_VOICE, language=None),
                         generation_lock=generation_lock, admission=admission)

    def _generate_chunks(self, text: str, *, delivery: str):
        if delivery not in DELIVERY_LABELS:
            raise RuntimeError('Invalid internal speech delivery')
        native = None
        try:
            native = self.model.stream(spoken_numbers(text), voice=PHONON_VOICE, seed=1234)
            if native.sample_rate != 24000:
                raise RuntimeError('Phonon stream audio must be 24000 Hz')
            resampler = soxr.ResampleStream(24000, 48000, 1, dtype='float32', quality='HQ')
            has_audio = False
            for chunk in native:
                if (not isinstance(chunk, np.ndarray) or chunk.ndim != 1
                        or chunk.dtype != np.float32 or not np.isfinite(chunk).all()):
                    raise RuntimeError('Phonon returned invalid audio')
                converted = resampler.resample_chunk(chunk)
                if converted.size:
                    has_audio = True
                    yield converted
            tail = resampler.resample_chunk(np.empty(0, dtype=np.float32), last=True)
            if tail.size:
                has_audio = True
                yield tail
            if not has_audio:
                raise RuntimeError('Phonon produced no audio')
        except Exception as error:
            raise RuntimeError('Phonon synthesis failed. Restore the pinned runtime and assets, then restart Kestrel.') from error
        finally:
            if native is not None:
                try:
                    native.close()
                except Exception as error:
                    raise RuntimeError('Phonon native cleanup failed. Restart Kestrel.') from error


async def prepare_acknowledgements(voice: ConversationTTS) -> tuple[PreparedAcknowledgement, ...]:
    clips = []
    try:
        for text in ('One moment.', 'Just a moment.', 'Give me a moment.'):
            pcm = bytearray()
            async with asyncio.timeout(45):
                stream = voice.run_tts(text, 'warmup')
                try:
                    async for frame in stream:
                        if (not isinstance(frame.audio, bytes) or frame.sample_rate != 48000
                                or frame.num_channels != 1 or len(frame.audio) % 2):
                            raise RuntimeError('voice audio must be mono 48000 Hz PCM16 bytes')
                        if len(pcm) + len(frame.audio) > 288000:
                            raise RuntimeError('voice clip exceeds 288000 bytes')
                        pcm.extend(frame.audio)
                finally:
                    await stream.aclose()
            if not pcm:
                raise RuntimeError('voice produced no audio')
            clips.append(PreparedAcknowledgement(text, bytes(pcm)))
    except Exception as error:
        cause = str(error) or type(error).__name__
        raise RuntimeError(f'Acknowledgement preparation failed: {cause}. Check the voice log, then restart Kestrel.') from error
    return tuple(clips)
