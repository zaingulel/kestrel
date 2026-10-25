"""Pinned local CPU recognition over Kestrel's JSON-lines worker protocol."""
import array
import base64
import ctypes as C
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import struct
import sys
import tempfile
import wave

ROOT = Path(__file__).parent
# The loaded model adds the tokenizer as asr.tokenizer.spm_model, because without it the library silently disables boosting.
MODEL = ROOT / '.runtime/models/nemotron-q8/nemotron-speech-streaming-en-0.6b.q8_0.word-boosting.gguf'
MODEL_SIZE = 700207744
MODEL_SHA256 = '926495522ccd2626d8665283b4c9225f704ed2b45e82158984d1823f7e528b52'
PUBLISHED_MODEL = ROOT / '.runtime/models/nemotron-q8/nemotron-speech-streaming-en-0.6b.q8_0.gguf'
PUBLISHED_MODEL_SIZE = 699872960
PUBLISHED_MODEL_SHA256 = 'd9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d'
TOKENIZER = ROOT / '.runtime/models/nemotron-q8/tokenizer.model'
TOKENIZER_SIZE = 251056
TOKENIZER_SHA256 = '07d4e5a63840a53ab2d4d106d2874768143fb3fbdd47938b3910d2da05bfb0a9'
# The splice offsets are fixed facts of the pinned published file, and the output pin catches any error in them.
SPLICE_METADATA_END = 14098
SPLICE_TENSOR_INFO_END = 64216
SPLICE_DATA_START = 64224
# Both libraries are pinned because the library reports disabled boosting only in its log.
LIBRARY = ROOT / '.runtime/tools/nemo-speech-0.2.0-linux-x86_64-cpu/lib/libnemo_speech_asr_c.so.1'
LIBRARY_SIZE = 68208
LIBRARY_SHA256 = 'b16719ac6c8614e43a9bed224b21dd17b9bfb59b5215cc7fe29482712090dc52'
ENGINE = LIBRARY.parent / 'libnemo_speech_asr.so'
ENGINE_SIZE = 2265256
ENGINE_SHA256 = '596c0e0dd3da78e959e850ed3e90911524a6051d8f4405324d70a570c427e246'
GGML_BASE = LIBRARY.parent / 'libggml-base.so.0.25.1'
GGML_BASE_SIZE = 863168
GGML_BASE_SHA256 = '79c5512818e2a6936cdeba03b5d0ecaf1b27fb0671afff8f8d22a4d5903f1062'
# Owner capitalisation, because lowercase phrases inserted false words.
BOOSTED_PHRASES = ('AlpGuard', 'Flowgauge', 'Fabraik')
BOOST = 2.0
SPELLINGS = {phrase.lower(): phrase for phrase in BOOSTED_PHRASES}
SPELLING_PATTERN = re.compile(rf"\b(?:{'|'.join(map(re.escape, BOOSTED_PHRASES))})\b", re.IGNORECASE)
RESPONSE_LIMIT = 64 * 1024
ADVICE = 'CPU recognition failed. Check the pinned local recognition assets and restart Kestrel.'


class Backend(C.Structure):
    _fields_ = [('size', C.c_size_t), ('gpu', C.c_int32)]


class Model(C.Structure):
    _fields_ = [('size', C.c_size_t), ('path', C.c_char_p), ('name', C.c_char_p)]


class Config(C.Structure):
    _fields_ = [('size', C.c_size_t), ('backend', C.POINTER(Backend)), ('model', C.POINTER(Model)),
                *[(name, C.c_void_p) for name in ('streaming', 'decoder', 'vad', 'endpointing', 'postproc', 'diar', 'batching')]]


class SpeechContext(C.Structure):
    _fields_ = [('size', C.c_size_t), ('phrases', C.POINTER(C.c_char_p)), ('phrase_count', C.c_size_t), ('boost', C.c_float)]


class Options(C.Structure):
    _fields_ = [('size', C.c_size_t), ('request_id', C.c_char_p), ('language_code', C.c_char_p),
                ('interim_results', C.c_bool), ('enable_word_time_offsets', C.c_bool),
                ('enable_automatic_punctuation', C.c_bool), ('verbatim_transcripts', C.c_bool),
                ('profanity_filter', C.c_bool), ('stop_history_eou_ms', C.c_int32),
                ('speech_contexts', C.POINTER(SpeechContext)), ('speech_context_count', C.c_size_t),
                ('max_alternatives', C.c_int32), ('enable_speaker_diarization', C.c_bool), ('max_speaker_count', C.c_int32)]


def samples(line):
    request = json.loads(line)
    if not isinstance(request, dict) or set(request) != {'audio'} or not isinstance(request['audio'], str):
        raise ValueError('Invalid request')
    decoded = base64.b64decode(request['audio'], validate=True)
    with wave.open(io.BytesIO(decoded), 'rb') as wav:
        frames = wav.getnframes()
        if (wav.getnchannels(), wav.getframerate(), wav.getsampwidth(), wav.getcomptype()) != (1, 16000, 2, 'NONE'):
            raise ValueError('Invalid WAV metadata')
        if frames <= 0:
            raise ValueError('Invalid WAV length')
        pcm = wav.readframes(frames + 1)
        if len(pcm) != frames * 2:
            raise ValueError('Truncated WAV')
    integers = array.array('h')
    integers.frombytes(pcm)
    return (C.c_float * frames)(*(value / 32768 for value in integers))


def restore_spelling(text):
    return SPELLING_PATTERN.sub(lambda match: SPELLINGS[match.group().lower()], text)


def matches(file, size, digest):
    return os.fstat(file.fileno()).st_size == size and hashlib.file_digest(file, 'sha256').hexdigest() == digest


def provision():
    try:
        if MODEL.exists():
            with MODEL.open('rb') as existing:
                if not matches(existing, MODEL_SIZE, MODEL_SHA256):
                    raise RuntimeError(f'Model identity mismatch: {MODEL}')
            print(f'Already provisioned: {MODEL}')
            return 0
        with PUBLISHED_MODEL.open('rb') as source, TOKENIZER.open('rb') as tokenizer:
            if not matches(source, PUBLISHED_MODEL_SIZE, PUBLISHED_MODEL_SHA256):
                raise RuntimeError(f'Published model identity mismatch: {PUBLISHED_MODEL}')
            if not matches(tokenizer, TOKENIZER_SIZE, TOKENIZER_SHA256):
                raise RuntimeError(f'Tokenizer identity mismatch: {TOKENIZER}')
            source.seek(0)
            head = source.read(SPLICE_TENSOR_INFO_END)
            tokenizer.seek(0)
            encoded = base64.b64encode(tokenizer.read())
            pair = (struct.pack('<Q', 23) + b'asr.tokenizer.spm_model' + struct.pack('<IQ', 8, len(encoded)) + encoded)
            descriptor, name = tempfile.mkstemp(dir=MODEL.parent, prefix=f'.{MODEL.name}.', suffix='.partial')
            staging = Path(name)
            try:
                with os.fdopen(descriptor, 'w+b') as output:
                    output.write(head[:16])
                    output.write(struct.pack('<Q', struct.unpack_from('<Q', head, 16)[0] + 1))
                    output.write(head[24:SPLICE_METADATA_END])
                    output.write(pair)
                    output.write(head[SPLICE_METADATA_END:])
                    # The published file sets no general.alignment, so the GGUF default of 32 applies.
                    output.write(bytes(-output.tell() % 32))
                    source.seek(SPLICE_DATA_START)
                    shutil.copyfileobj(source, output)
                    output.flush()
                    os.fsync(output.fileno())
                    output.seek(0)
                    if not matches(output, MODEL_SIZE, MODEL_SHA256):
                        raise RuntimeError(f'Provisioned model identity mismatch: {MODEL}')
                # A link never overwrites a model that appeared after the check above.
                os.link(staging, MODEL)
            finally:
                staging.unlink()
        print(f'Provisioned {MODEL}')
        return 0
    except (OSError, RuntimeError) as exc:
        print(f'Provisioning refused: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1


def emit(protocol, value):
    encoded = (json.dumps(value, ensure_ascii=True) + '\n').encode()
    if len(encoded) > RESPONSE_LIMIT:
        print('CPU recognition response exceeded the protocol size limit', file=sys.stderr)
        encoded = (json.dumps({'error': ADVICE}) + '\n').encode()
    protocol.write(encoded)


def serve(requests, protocol):
    recognizer = C.c_void_p()
    library = None
    startup = True

    try:
        for kind, path, size, digest in (
                ('Model', MODEL, MODEL_SIZE, MODEL_SHA256),
                ('Library', LIBRARY, LIBRARY_SIZE, LIBRARY_SHA256),
                ('Library', ENGINE, ENGINE_SIZE, ENGINE_SHA256),
                ('Library', GGML_BASE, GGML_BASE_SIZE, GGML_BASE_SHA256)):
            with path.open('rb') as file:
                if not matches(file, size, digest):
                    raise RuntimeError(f'{kind} identity mismatch: {path}')
        library = C.CDLL(str(LIBRARY))
        signatures = {
            'nemo_speech_asr_create': ([C.POINTER(Config), C.POINTER(C.c_void_p)], C.c_int),
            'nemo_speech_asr_destroy': ([C.c_void_p], None),
            'nemo_speech_asr_recognition_options_default': ([], Options),
            'nemo_speech_asr_recognize_f32': ([C.c_void_p, C.POINTER(Options), C.POINTER(C.c_float), C.c_size_t, C.c_int32, C.POINTER(C.c_void_p)], C.c_int),
            'nemo_speech_asr_result_alternative_count': ([C.c_void_p], C.c_size_t),
            'nemo_speech_asr_result_transcript': ([C.c_void_p, C.c_size_t], C.c_char_p),
            'nemo_speech_asr_result_destroy': ([C.c_void_p], None),
        }
        for name, (arguments, result_type) in signatures.items():
            function = getattr(library, name)
            function.argtypes, function.restype = arguments, result_type
        backend = Backend(C.sizeof(Backend), -1)
        model = Model(C.sizeof(Model), os.fsencode(MODEL), None)
        config = Config(size=C.sizeof(Config), backend=C.pointer(backend), model=C.pointer(model))
        status = library.nemo_speech_asr_create(C.byref(config), C.byref(recognizer))
        if status != 0 or not recognizer:
            raise RuntimeError(f'Native create failed (status={status}, recognizer={bool(recognizer)})')
        options = library.nemo_speech_asr_recognition_options_default()
        if options.size != C.sizeof(Options):
            raise RuntimeError(f'Native options ABI mismatch (size={options.size}, expected={C.sizeof(Options)})')
        # ctypes does not own the memory these point to, so they live as long as the worker.
        phrases = (C.c_char_p * len(BOOSTED_PHRASES))(*map(str.encode, BOOSTED_PHRASES))
        context = SpeechContext(C.sizeof(SpeechContext), phrases, len(BOOSTED_PHRASES), BOOST)
        options.speech_contexts, options.speech_context_count = C.pointer(context), 1
        emit(protocol, {'ready': True})
        startup = False
        for line in requests:
            result = C.c_void_p()
            operation = 'audio validation'
            try:
                floats = samples(line)
                operation = 'native recognition'
                status = library.nemo_speech_asr_recognize_f32(
                    recognizer, C.byref(options), floats, len(floats), 16000, C.byref(result))
                if status != 0 or not result:
                    raise RuntimeError('Native recognition failed')
                operation = 'transcript copy'
                text = ''
                if library.nemo_speech_asr_result_alternative_count(result):
                    raw = library.nemo_speech_asr_result_transcript(result, 0)
                    if raw is None:
                        raise RuntimeError('Native transcript handle missing')
                    text = raw.decode('utf-8')
                emit(protocol, {'text': restore_spelling(text.strip())})
            except (ValueError, RuntimeError, EOFError, wave.Error) as exc:
                detail = type(exc).__name__
                if operation == 'native recognition':
                    detail += f' (status={status}, result={bool(result)})'
                print(f'CPU recognition {operation} failed: {detail}', file=sys.stderr)
                emit(protocol, {'error': ADVICE})
            finally:
                if result:
                    library.nemo_speech_asr_result_destroy(result)
        return 0
    except (OSError, RuntimeError, AttributeError) as exc:
        if startup:
            print(f'CPU recognition startup failed: {type(exc).__name__}: {exc}', file=sys.stderr)
        else:
            print(f'CPU recognition protocol failed: {type(exc).__name__}', file=sys.stderr)
        emit(protocol, {'error': ADVICE})
        return 1
    finally:
        if library is not None and recognizer:
            library.nemo_speech_asr_destroy(recognizer)


def main():
    if sys.argv[1:] == ['provision']:
        return provision()
    if sys.argv[1:]:
        print('Usage: asr_worker.py [provision]', file=sys.stderr)
        return 2
    # A separate descriptor keeps native stdout diagnostics out of the worker protocol.
    with os.fdopen(os.dup(sys.stdout.fileno()), 'wb', buffering=0) as protocol:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        sys.stdout = sys.stderr
        return serve(sys.stdin.buffer, protocol)


if __name__ == '__main__':
    raise SystemExit(main())
