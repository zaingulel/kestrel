import base64
import ctypes
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import wave

import asr_worker


class FakeLibrary:
    def __init__(self):
        self.create_status, self.recognize_status = 0, 0
        self.create_handle, self.result_handle = 11, 22
        self.text = b'  recognized words  '
        self.options_size = ctypes.sizeof(asr_worker.Options)
        self.config = None
        self.contexts = []
        self.nemo_speech_asr_create = Mock(side_effect=self.create)
        self.nemo_speech_asr_destroy = Mock()
        self.nemo_speech_asr_recognition_options_default = Mock(side_effect=self.options)
        self.nemo_speech_asr_recognize_f32 = Mock(side_effect=self.recognize)
        self.nemo_speech_asr_result_alternative_count = Mock(return_value=1)
        self.nemo_speech_asr_result_transcript = Mock(side_effect=lambda *_: self.text)
        self.nemo_speech_asr_result_destroy = Mock()

    def create(self, config, handle):
        self.config = ctypes.cast(config, ctypes.POINTER(asr_worker.Config)).contents
        ctypes.cast(handle, ctypes.POINTER(ctypes.c_void_p)).contents.value = self.create_handle
        return self.create_status

    def options(self):
        return asr_worker.Options(size=self.options_size)

    def recognize(self, recognizer, options, samples, count, rate, result):
        # The worker owns this memory, so it is read at call time.
        options = ctypes.cast(options, ctypes.POINTER(asr_worker.Options)).contents
        self.contexts.append([
            (context.size, [context.phrases[index] for index in range(context.phrase_count)], context.boost)
            for context in (options.speech_contexts[index] for index in range(options.speech_context_count))])
        ctypes.cast(result, ctypes.POINTER(ctypes.c_void_p)).contents.value = self.result_handle
        return self.recognize_status


class CPUWorkerTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.model = Path(directory.name) / 'model.gguf'
        self.model.write_bytes(b'hello')
        self.native = Path(directory.name) / 'libnemo_speech_asr_c.so.1'
        self.native.write_bytes(b'native')
        self.engine = Path(directory.name) / 'libnemo_speech_asr.so'
        self.engine.write_bytes(b'engine')
        self.library = FakeLibrary()

    @staticmethod
    def wav(pcm=struct.pack('<hhh', -32768, 0, 32767), channels=1, rate=16000, width=2):
        output = io.BytesIO()
        with wave.open(output, 'wb') as audio:
            audio.setnchannels(channels)
            audio.setsampwidth(width)
            audio.setframerate(rate)
            audio.writeframes(pcm)
        return output.getvalue()

    @staticmethod
    def request(audio):
        return (json.dumps({'audio': base64.b64encode(audio).decode()}) + '\n').encode()

    def serve(self, requests, protocol=None):
        protocol = protocol if protocol is not None else io.BytesIO()
        with (
            patch.object(asr_worker, 'MODEL', self.model),
            patch.object(asr_worker, 'MODEL_SIZE', 5),
            patch.object(asr_worker, 'MODEL_SHA256', '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'),
            patch.object(asr_worker, 'LIBRARY', self.native),
            patch.object(asr_worker, 'LIBRARY_SIZE', 6),
            patch.object(asr_worker, 'LIBRARY_SHA256', 'bef32d2c315a289576f2a6828d27edb16bb316a4d85c271f2d794045f3ea668d'),
            patch.object(asr_worker, 'ENGINE', self.engine),
            patch.object(asr_worker, 'ENGINE_SIZE', 6),
            patch.object(asr_worker, 'ENGINE_SHA256', 'ed9f6f25068608efd412958da4dfc19328ca3511251fa6d5f9c42baf230e32f8'),
            patch.object(asr_worker.C, 'CDLL', return_value=self.library) as load,
        ):
            status = asr_worker.serve(io.BytesIO(requests), protocol)
        values = [json.loads(line) for line in protocol.getvalue().splitlines()]
        return status, values, load

    def test_pcm_scale_and_valid_input_without_trial_caps(self):
        values = asr_worker.samples(self.request(self.wav()))
        self.assertEqual(list(values), [-1.0, 0.0, 0.999969482421875])
        long_audio = self.wav(bytes(2_400_000))
        self.assertGreater(len(self.request(long_audio)), 3 * 1024 * 1024)
        self.assertEqual(len(asr_worker.samples(self.request(long_audio))), 1_200_000)

    def test_malformed_audio_is_refused_before_native_inference(self):
        valid = self.wav()
        invalid_base64 = json.loads(self.request(valid))
        invalid_base64['audio'] = invalid_base64['audio'][:12] + '!@' + invalid_base64['audio'][12:]
        excessive_count = bytearray(valid)
        excessive_count[40:44] = (1_000_000).to_bytes(4, 'little')
        requests = [b'not json\n', b'[]\n', b'{}\n', b'{"audio":7}\n', b'{"audio":"","extra":1}\n',
                    (json.dumps(invalid_base64) + '\n').encode(), self.request(b'not WAV'),
                    self.request(self.wav(channels=2)), self.request(self.wav(rate=48000)),
                    self.request(self.wav(width=1)), self.request(self.wav(pcm=b'')),
                    self.request(valid[:-2]), self.request(excessive_count)]
        status, values, _ = self.serve(b''.join(requests))
        self.assertEqual(status, 0)
        self.assertEqual(values[0], {'ready': True})
        self.assertEqual(values[1:], [{'error': asr_worker.ADVICE}] * len(requests))
        self.library.nemo_speech_asr_recognize_f32.assert_not_called()
        self.library.nemo_speech_asr_destroy.assert_called_once()

    def test_persistent_cpu_handles_protocol_empty_text_and_eof(self):
        self.library.nemo_speech_asr_result_transcript.side_effect = [b'  recognized words  ', b'']
        status, values, load = self.serve(self.request(self.wav()) * 2)
        self.assertEqual((status, values), (0, [{'ready': True}, {'text': 'recognized words'}, {'text': ''}]))
        load.assert_called_once_with(str(self.native))
        self.library.nemo_speech_asr_create.assert_called_once()
        self.library.nemo_speech_asr_recognition_options_default.assert_called_once()
        config = self.library.config
        self.assertEqual(config.size, ctypes.sizeof(asr_worker.Config))
        self.assertEqual(config.backend.contents.size, ctypes.sizeof(asr_worker.Backend))
        self.assertEqual(config.backend.contents.gpu, -1)
        self.assertEqual(config.model.contents.size, ctypes.sizeof(asr_worker.Model))
        self.assertEqual(config.model.contents.path, bytes(self.model))
        self.assertTrue(all(getattr(config, name) is None for name in ('streaming', 'decoder', 'vad', 'endpointing', 'postproc', 'diar', 'batching')))
        self.assertEqual(self.library.nemo_speech_asr_recognize_f32.call_count, 2)
        for call in self.library.nemo_speech_asr_recognize_f32.call_args_list:
            self.assertEqual(call.args[0].value, 11)
            self.assertEqual(ctypes.cast(call.args[1], ctypes.POINTER(asr_worker.Options)).contents.size, ctypes.sizeof(asr_worker.Options))
            self.assertEqual(list(call.args[2]), [-1.0, 0.0, 0.999969482421875])
            self.assertEqual(call.args[3:5], (3, 16000))
        self.assertEqual(self.library.nemo_speech_asr_result_destroy.call_count, 2)
        self.library.nemo_speech_asr_destroy.assert_called_once()

    def test_create_status_null_and_options_mismatch_release_recognizer(self):
        for status, handle, size in ((3, 11, ctypes.sizeof(asr_worker.Options)), (0, None, ctypes.sizeof(asr_worker.Options)), (0, 11, 1)):
            with self.subTest(status=status, handle=handle, size=size):
                self.library = FakeLibrary()
                self.library.create_status, self.library.create_handle, self.library.options_size = status, handle, size
                code, values, _ = self.serve(b'')
                self.assertEqual((code, values), (1, [{'error': asr_worker.ADVICE}]))
                self.assertEqual(self.library.nemo_speech_asr_destroy.call_count, int(handle is not None))

    def test_native_failures_and_transcript_exceptions_release_results(self):
        for status, handle, text in ((3, 22, b''), (0, None, b''), (0, 22, None), (0, 22, b'\xff')):
            with self.subTest(status=status, handle=handle, text=text):
                self.library = FakeLibrary()
                self.library.recognize_status, self.library.result_handle, self.library.text = status, handle, text
                code, values, _ = self.serve(self.request(self.wav()))
                self.assertEqual((code, values), (0, [{'ready': True}, {'error': asr_worker.ADVICE}]))
                self.assertEqual(self.library.nemo_speech_asr_result_destroy.call_count, int(handle is not None))
                self.library.nemo_speech_asr_destroy.assert_called_once()

    def test_missing_wrong_size_and_wrong_hash_refuse_native_load(self):
        for content in (None, b'longer', b'jello'):
            with self.subTest(content=content):
                if content is None:
                    self.model.unlink()
                else:
                    self.model.write_bytes(content)
                diagnostics = io.StringIO()
                with redirect_stderr(diagnostics):
                    code, values, load = self.serve(b'')
                self.assertEqual((code, values), (1, [{'error': asr_worker.ADVICE}]))
                load.assert_not_called()
                self.assertIn(str(self.model), diagnostics.getvalue())
                self.assertIn('FileNotFoundError' if content is None else 'Model identity mismatch', diagnostics.getvalue())

    def test_unpinned_native_library_refuses_before_loading(self):
        for name in ('native', 'engine'):
            for change in ('size', 'hash'):
                with self.subTest(library=name, change=change):
                    path = getattr(self, name)
                    original = path.read_bytes()
                    path.write_bytes(original + b'!' if change == 'size' else original[:-1] + b'x')
                    diagnostics = io.StringIO()
                    with redirect_stderr(diagnostics):
                        code, values, load = self.serve(b'')
                    path.write_bytes(original)
                    self.assertEqual((code, values), (1, [{'error': asr_worker.ADVICE}]))
                    load.assert_not_called()
                    self.assertIn(f'Library identity mismatch: {path}', diagnostics.getvalue())

    def test_every_request_boosts_the_owner_words_and_restores_their_spelling(self):
        self.library.nemo_speech_asr_result_transcript.side_effect = [b'ask alpguard and flowgauge about fabraik', b'garden fabric']
        status, values, _ = self.serve(self.request(self.wav()) * 2)
        self.assertEqual((status, values), (0, [{'ready': True}, {'text': 'ask AlpGuard and Flowgauge about Fabraik'}, {'text': 'garden fabric'}]))
        context = [(ctypes.sizeof(asr_worker.SpeechContext), [b'AlpGuard', b'Flowgauge', b'Fabraik'], 2.0)]
        self.assertEqual(self.library.contexts, [context, context])

    def test_spelling_restoration_changes_only_whole_word_matches(self):
        self.assertEqual(asr_worker.restore_spelling('ALPGUARD flowGauge Fabraik'), 'AlpGuard Flowgauge Fabraik')
        self.assertEqual(asr_worker.restore_spelling("fabraik's"), "Fabraik's")
        for unchanged in ('fabraiks', 'xalpguard', 'flowgauge2', 'fabraiké', 'garden fabric', ''):
            with self.subTest(unchanged=unchanged):
                self.assertEqual(asr_worker.restore_spelling(unchanged), unchanged)

    def test_response_limit_refuses_oversize_instead_of_truncating(self):
        self.library.text = b'x' * 65536
        code, values, _ = self.serve(self.request(self.wav()))
        self.assertEqual((code, values), (0, [{'ready': True}, {'error': asr_worker.ADVICE}]))
        self.library.nemo_speech_asr_result_destroy.assert_called_once()
        self.library.nemo_speech_asr_destroy.assert_called_once()

    def test_output_exception_still_releases_native_handles(self):
        class ClosedOutput(io.BytesIO):
            def write(self, value):
                if self.getvalue():
                    raise BrokenPipeError('reader closed')
                return super().write(value)
        with self.assertRaises(BrokenPipeError):
            self.serve(self.request(self.wav()), ClosedOutput())
        self.library.nemo_speech_asr_result_destroy.assert_called_once()
        self.library.nemo_speech_asr_destroy.assert_called_once()

    def test_main_separates_native_stdout_from_protocol(self):
        code = """import os
import asr_worker

def fake_serve(requests, protocol):
    os.write(1, b'native diagnostic\\n')
    os.write(2, b'stderr diagnostic\\n')
    protocol.write(b'{"ready":true}\\n')
    return 0

asr_worker.serve = fake_serve
raise SystemExit(asr_worker.main())
"""
        result = subprocess.run(
            [sys.executable, '-B', '-c', code], cwd=asr_worker.ROOT,
            capture_output=True, timeout=10, check=True,
        )
        self.assertEqual(result.stdout, b'{"ready":true}\n')
        self.assertEqual(result.stderr, b'native diagnostic\nstderr diagnostic\n')


def gguf_string(value):
    return struct.pack('<Q', len(value)) + value


def gguf_pair(key, kind, value):
    return gguf_string(key) + struct.pack('<I', kind) + value


def gguf(pairs, infos, data):
    """A version 3 GGUF file with the default 32-byte alignment, and where its sections end."""
    content = b'GGUF' + struct.pack('<IQQ', 3, len(infos), len(pairs)) + b''.join(pairs)
    metadata_end = len(content)
    content += b''.join(infos)
    tensor_info_end = len(content)
    content += bytes(-len(content) % 32)
    return content + data, metadata_end, tensor_info_end, len(content)


class WordBoostingModelTests(unittest.TestCase):
    TOKENIZER = b'tokenizer-bytes'
    PAIRS = [
        gguf_pair(b'general.architecture', 8, gguf_string(b'nemo')),
        gguf_pair(b'tokenizer.vocab', 9, struct.pack('<IQ', 8, 3) + b''.join(map(gguf_string, (b'a', b'bc', b'def')))),
        gguf_pair(b'nemo.layers', 4, struct.pack('<I', 7)),
    ]
    INFOS = [gguf_string(b'weights') + struct.pack('<IQQIQ', 2, 3, 4, 8, 0)]
    DATA = bytes(range(1, 25))

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        source, metadata_end, tensor_info_end, data_start = gguf(self.PAIRS, self.INFOS, self.DATA)
        tokenizer_pair = gguf_pair(b'asr.tokenizer.spm_model', 8, gguf_string(base64.b64encode(self.TOKENIZER)))
        self.expected = gguf(self.PAIRS + [tokenizer_pair], self.INFOS, self.DATA)[0]
        self.model = self.directory / 'model.gguf'
        self.source = self.directory / 'source.gguf'
        self.tokenizer = self.directory / 'tokenizer.model'
        self.source.write_bytes(source)
        self.tokenizer.write_bytes(self.TOKENIZER)
        self.pins = {
            'MODEL': self.model, 'MODEL_SIZE': len(self.expected), 'MODEL_SHA256': hashlib.sha256(self.expected).hexdigest(),
            'PUBLISHED_MODEL': self.source, 'PUBLISHED_MODEL_SIZE': len(source), 'PUBLISHED_MODEL_SHA256': hashlib.sha256(source).hexdigest(),
            'TOKENIZER': self.tokenizer, 'TOKENIZER_SIZE': len(self.TOKENIZER), 'TOKENIZER_SHA256': hashlib.sha256(self.TOKENIZER).hexdigest(),
            'SPLICE_METADATA_END': metadata_end, 'SPLICE_TENSOR_INFO_END': tensor_info_end, 'SPLICE_DATA_START': data_start,
        }
        self.inputs = [self.source.name, self.tokenizer.name]

    def provision(self, **overrides):
        output, diagnostics = io.StringIO(), io.StringIO()
        with patch.multiple(asr_worker, **{**self.pins, **overrides}), redirect_stdout(output), redirect_stderr(diagnostics):
            code = asr_worker.provision()
        return code, output.getvalue(), diagnostics.getvalue()

    def listing(self, *extra):
        return sorted(path.name for path in self.directory.iterdir()), sorted([*self.inputs, *extra])

    def test_provision_embeds_the_tokenizer_and_keeps_tensor_data(self):
        source, tokenizer = self.source.read_bytes(), self.tokenizer.read_bytes()
        self.assertEqual(self.provision(), (0, f'Provisioned {self.model}\n', ''))
        self.assertEqual(self.model.read_bytes(), self.expected)
        self.assertEqual(stat.S_IMODE(self.model.stat().st_mode), 0o600)
        self.assertEqual(*self.listing(self.model.name))
        self.assertEqual((self.source.read_bytes(), self.tokenizer.read_bytes()), (source, tokenizer))

    def test_provision_refuses_unverified_inputs_and_output_without_installing(self):
        wrong = '0' * 64
        for name, overrides, cause in (
            ('wrong source hash', {'PUBLISHED_MODEL_SHA256': wrong}, f'Published model identity mismatch: {self.source}'),
            ('wrong tokenizer hash', {'TOKENIZER_SHA256': wrong}, f'Tokenizer identity mismatch: {self.tokenizer}'),
            ('missing source', {'PUBLISHED_MODEL': self.directory / 'absent.gguf'}, 'FileNotFoundError'),
            ('wrong output pin', {'MODEL_SHA256': wrong}, f'Provisioned model identity mismatch: {self.model}'),
        ):
            with self.subTest(name):
                code, output, diagnostics = self.provision(**overrides)
                self.assertEqual((code, output), (1, ''))
                self.assertTrue(diagnostics.startswith('Provisioning refused: '), diagnostics)
                self.assertIn(cause, diagnostics)
                self.assertEqual(*self.listing())

    def test_provision_keeps_an_existing_model(self):
        with self.subTest('matching file'):
            self.model.write_bytes(self.expected)
            self.assertEqual(self.provision(), (0, f'Already provisioned: {self.model}\n', ''))
            self.assertEqual(self.model.read_bytes(), self.expected)
            self.assertEqual(*self.listing(self.model.name))
        with self.subTest('mismatching file'):
            self.model.write_bytes(b'other')
            code, output, diagnostics = self.provision()
            self.assertEqual((code, output), (1, ''))
            self.assertIn(f'Model identity mismatch: {self.model}', diagnostics)
            self.assertEqual(self.model.read_bytes(), b'other')
            self.assertEqual(*self.listing(self.model.name))
        with self.subTest('file created before publication'):
            self.model.unlink()
            matches = asr_worker.matches

            def create_sentinel_after_output_check(file, size, digest):
                verified = matches(file, size, digest)
                if digest == self.pins['MODEL_SHA256']:
                    self.model.write_bytes(b'sentinel')
                return verified

            with patch.object(asr_worker, 'matches', create_sentinel_after_output_check):
                code, output, diagnostics = self.provision()
            self.assertEqual((code, output), (1, ''))
            self.assertIn('Provisioning refused: FileExistsError', diagnostics)
            self.assertEqual(self.model.read_bytes(), b'sentinel')
            self.assertEqual(*self.listing(self.model.name))

    def test_main_dispatches_provision_and_refuses_unknown_arguments(self):
        with patch.object(asr_worker, 'provision', return_value=7) as provision, patch.object(asr_worker, 'serve') as serve:
            with patch.object(sys, 'argv', ['asr_worker.py', 'provision']):
                self.assertEqual(asr_worker.main(), 7)
            provision.assert_called_once_with()
            for arguments in (['PROVISION'], ['provision', 'again'], ['--help']):
                with self.subTest(arguments=arguments), patch.object(sys, 'argv', ['asr_worker.py', *arguments]):
                    diagnostics = io.StringIO()
                    with redirect_stderr(diagnostics):
                        self.assertEqual(asr_worker.main(), 2)
                    self.assertEqual(diagnostics.getvalue(), 'Usage: asr_worker.py [provision]\n')
            provision.assert_called_once_with()
            serve.assert_not_called()

    def test_worker_pins_the_word_boosting_model_and_its_sources(self):
        models = asr_worker.ROOT / '.runtime/models/nemotron-q8'
        self.assertEqual(
            (asr_worker.MODEL, asr_worker.MODEL_SIZE, asr_worker.MODEL_SHA256),
            (models / 'nemotron-speech-streaming-en-0.6b.q8_0.word-boosting.gguf', 700207744,
             '926495522ccd2626d8665283b4c9225f704ed2b45e82158984d1823f7e528b52'))
        self.assertEqual(
            (asr_worker.PUBLISHED_MODEL, asr_worker.PUBLISHED_MODEL_SIZE, asr_worker.PUBLISHED_MODEL_SHA256),
            (models / 'nemotron-speech-streaming-en-0.6b.q8_0.gguf', 699872960,
             'd9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d'))
        self.assertEqual(
            (asr_worker.TOKENIZER, asr_worker.TOKENIZER_SIZE, asr_worker.TOKENIZER_SHA256),
            (models / 'tokenizer.model', 251056, '07d4e5a63840a53ab2d4d106d2874768143fb3fbdd47938b3910d2da05bfb0a9'))
        libraries = asr_worker.ROOT / '.runtime/tools/nemo-speech-0.2.0-linux-x86_64-cpu/lib'
        self.assertEqual(
            (asr_worker.LIBRARY, asr_worker.LIBRARY_SIZE, asr_worker.LIBRARY_SHA256),
            (libraries / 'libnemo_speech_asr_c.so.1', 68208, 'b16719ac6c8614e43a9bed224b21dd17b9bfb59b5215cc7fe29482712090dc52'))
        self.assertEqual(
            (asr_worker.ENGINE, asr_worker.ENGINE_SIZE, asr_worker.ENGINE_SHA256),
            (libraries / 'libnemo_speech_asr.so', 2265256, '596c0e0dd3da78e959e850ed3e90911524a6051d8f4405324d70a570c427e246'))
        self.assertEqual(
            (asr_worker.SPLICE_METADATA_END, asr_worker.SPLICE_TENSOR_INFO_END, asr_worker.SPLICE_DATA_START),
            (14098, 64216, 64224))
