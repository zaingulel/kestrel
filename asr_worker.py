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
import sys
import wave

ROOT = Path(__file__).parent
MODEL = ROOT / '.runtime/models/nemotron-q8/nemotron-speech-streaming-en-0.6b.q8_0.gguf'
MODEL_SIZE = 699872960
MODEL_SHA256 = 'd9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d'
LIBRARY = ROOT / '.runtime/tools/nemo-speech-0.2.0-linux-x86_64-cpu/lib/libnemo_speech_asr_c.so.1'
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
        with MODEL.open('rb') as model_file:
            if MODEL.stat().st_size != MODEL_SIZE or hashlib.file_digest(model_file, 'sha256').hexdigest() != MODEL_SHA256:
                raise RuntimeError(f'Model identity mismatch: {MODEL}')
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
    # A separate descriptor keeps native stdout diagnostics out of the worker protocol.
    with os.fdopen(os.dup(sys.stdout.fileno()), 'wb', buffering=0) as protocol:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        sys.stdout = sys.stderr
        return serve(sys.stdin.buffer, protocol)


if __name__ == '__main__':
    raise SystemExit(main())
