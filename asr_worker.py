"""Nemotron worker, isolated from VoxCPM's Transformers version."""

import base64
import contextlib
import io
import json
import sys
from pathlib import Path

import soundfile as sf
import torch
from transformers import AutoModelForRNNT, AutoProcessor


def main():
    torch.set_num_threads(4)
    path = Path(__file__).parent / ".runtime/models/nemotron"
    # stdout is the request/response channel; model diagnostics belong on stderr.
    with contextlib.redirect_stdout(sys.stderr):
        processor = AutoProcessor.from_pretrained(path, local_files_only=True)
        model = AutoModelForRNNT.from_pretrained(
            path, local_files_only=True, dtype=torch.float32
        ).to("cuda").eval()
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            audio, rate = sf.read(io.BytesIO(base64.b64decode(request["audio"])), dtype="float32")
            if rate != 16000 or audio.ndim != 1:
                raise ValueError("Recognition requires mono audio at 16000 Hz")
            with contextlib.redirect_stdout(sys.stderr), torch.inference_mode():
                inputs = processor(audio, sampling_rate=rate, return_tensors="pt").to(
                    model.device, dtype=model.dtype
                )
                result = model.generate(
                    **inputs, max_new_tokens=512, return_dict_in_generate=True
                )
                text = processor.batch_decode(result.sequences, skip_special_tokens=True)[0]
            response = {"text": text.strip()}
        except Exception as exc:
            response = {"error": str(exc)}
        print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()
