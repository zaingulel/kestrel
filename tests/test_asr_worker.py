import base64
import ctypes
from contextlib import redirect_stderr
import io
import json
from pathlib import Path
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
        load.assert_called_once_with(str(asr_worker.LIBRARY))
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
