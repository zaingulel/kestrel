# Local speech model selection for Kestrel

Keep VoxCPM2 as the current laptop default. Advance **Phonon 31M q8 as the single CPU candidate for an owner audition**, before any product integration. Defer Kokoro and Pocket TTS from the initial offering. This gives a proposed two-model selection: the familiar GPU voice and a lightweight CPU option. Only VoxCPM2 is integrated today; passing an isolated synthesis trial does not make Phonon a supported Kestrel option.

This decision addresses [issue #150](https://github.com/zaingulel/kestrel/issues/150) for the owner-confirmed profiles: the current laptop, CPU-only laptops and handhelds. The recommendation is conditional on voice acceptance and a whole-assistant trial. No service, default, microphone behaviour or private voice asset was changed.

## Why these candidates

| Candidate | Evidence and fit | Recommendation |
|---|---|---|
| VoxCPM2 | Existing local GPU integration, selectable local reference presets and expressive delivery. Published 2B parameters, 48 kHz output and approximately 8 GB inference video memory. No fresh synthesis or listening comparison in this study. [Model card](https://huggingface.co/openbmb/VoxCPM2/blob/32279effe8c19989596f05d353d1447f51d9e915/README.md), [Kestrel voice manual](../../README.md). | Retain current laptop default and rollback path. |
| Phonon 31M | Public English model; q8 weights plus required local configuration, tokenizer and default voice total 65,051,089 bytes. Real incremental CPU output measured offline below. The 31M label excludes the audio tokenizer. [Model card](https://huggingface.co/gradium/phonon-31m-en/blob/541f5752bc3c79583068bb205bfda5eb39aaa08a/README.md). | First CPU audition. Native Rust runtime avoids requiring a second PyTorch stack in a future installation. |
| Kokoro 82M v1.0 | Public model, fixed voice tensors, speed control and several languages. The measured Python path returned one complete segment per test prompt, with much later first output and higher process memory than Phonon. [Model card](https://huggingface.co/hexgrad/Kokoro-82M/blob/f3ff3571791e39611d31c381e3a41a3af07b4987/README.md), [pipeline source](https://github.com/hexgrad/kokoro/blob/dfb907a02bba8152ca444717ca5d78747ccb4bec/kokoro/pipeline.py). | Defer. Revisit only if an owner audition establishes a worthwhile voice or language advantage. |
| Pocket TTS | Published CPU streaming, local prompt conditioning and voice state export. Current model access is gated; no account sign-in, terms acceptance, weights or trial. [Public model page](https://huggingface.co/kyutai/pocket-tts), [pinned runtime documentation](https://github.com/kyutai-labs/pocket-tts/blob/a922b912dfa366975294afb568d815b305acde5d/README.md). | Research-only reserve if its voice conditioning earns a specific audition and access is separately approved. |

A future Phonon installation should use the tested 31M English q8 checkpoint explicitly. The separate 40M language and multilingual models are gated and carry a non-commercial licence. They are not interchangeable offerings under the 31M recommendation. The [v0.4.0 release](https://github.com/gradium-ai/xn-ptts/releases/tag/v0.4.0) and its [model table](https://github.com/gradium-ai/xn-ptts/blob/f07d7952db0c6127d5e4bc3f41c82b3304b6b5aa/README.md#model-setup) establish that distinction. The anonymous 40M card download returned HTTP 401; its [public metadata](https://huggingface.co/api/models/gradium/phonon-40m-en/revision/3d14984e8526f90813d46b862b51c6f4a423dcad) also declares gating and CC BY-NC 4.0. No 40M terms were accepted.

## Licences and voice limits

These are upstream declarations for the specified artifacts, not a legal opinion or permission to impersonate a speaker. A code licence does not establish the rights to a recording or custom voice.

| Candidate | Code | Model | Voice boundary |
|---|---|---|---|
| VoxCPM2 | Apache 2.0, [repository licence](https://github.com/OpenBMB/VoxCPM/blob/cce58a5b59303c9bd63d12f23afe6a49a4a80c59/LICENSE). | Apache 2.0 in the pinned model card. | Kestrel's references stay private. Their provenance and redistribution rights were not audited here. Model permission does not make those files distributable. |
| Phonon | MIT OR Apache 2.0, [v0.4.0 Python guide](https://github.com/gradium-ai/xn-ptts/blob/f07d7952db0c6127d5e4bc3f41c82b3304b6b5aa/ptts-pyo3/README.md#license). | 31M Apache 2.0; 40M CC BY-NC 4.0. | The pinned 31M card explicitly includes **voices in that repository** in its Apache 2.0 grant, covering the tested `default-voice.safetensors`. The separate [voice catalogue](https://huggingface.co/gradium/phonon-voices/blob/0ee17205f254b5abc43b266c8a0f215565c352f7/README.md) is also labelled Apache 2.0. This does not establish terms for a new hosted custom clone. |
| Kokoro | Apache 2.0, [repository licence](https://github.com/hexgrad/kokoro/blob/dfb907a02bba8152ca444717ca5d78747ccb4bec/LICENSE). | Apache 2.0. | Tested `af_heart.pt` is a voice tensor in the Apache-labelled model repository. [VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/f3ff3571791e39611d31c381e3a41a3af07b4987/VOICES.md) provides quality/training notes, not a separate per-speaker rights grant. Retain model notices and review any chosen voice's provenance before distribution; no private clone capability is established by that tensor interface. |
| Pocket TTS | MIT, [repository licence](https://github.com/kyutai-labs/pocket-tts/blob/a922b912dfa366975294afb568d815b305acde5d/LICENSE). | Current [public metadata](https://huggingface.co/api/models/kyutai/pocket-tts/revision/db04f0e653473e5c7333c69686ac92b7460b0c1d) declares **CC BY 4.0**, with a separate access gate and prohibited-use conditions on the model page. Do not infer the model licence from the MIT code licence. | The [voice repository](https://huggingface.co/kyutai/tts-voices/blob/323332d33f997de8394f24a193e1a76df720e01a/README.md) distinguishes CC0 donations/Voice-Zero, CC BY 4.0 Alba/VCTK and non-commercial Expresso/EARS. Select and attribute the actual voice asset; do not label the entire catalogue commercially unrestricted. |

VoxCPM2 accepts reference audio and can design voices locally. Kestrel's current neutral path uses a reference plus exact transcript; expressive replies use reference-only conditioning. The [operation manual](../../README.md) warns that delivery and speaker characteristics can vary. Retaining a preset does not guarantee identical accent or timbre across modes.

Phonon can use downloaded voice embeddings offline, including catalogue voices labelled US or UK English. Those labels do not establish the owner's preferred Irish voice. Its documented custom cloning workflow is hosted: [clone-voice.py at v0.4.0](https://github.com/gradium-ai/xn-ptts/blob/f07d7952db0c6127d5e4bc3f41c82b3304b6b5aa/scripts/clone-voice.py) sends the supplied audio file to `https://api.gradium.ai/api/voices/`, uses a Gradium API key, saves the clone in the account, then downloads an embedding. Although its description says ten seconds are used, the script uploads the supplied file. **Do not treat this as local cloning.** It was not run. A local Phonon generation result proves neither local custom voice provisioning nor compatibility with Kestrel's WAV/transcript presets. The generic runtime also exposes a conditional local `clone_voice` API: its [source](https://github.com/gradium-ai/xn-ptts/blob/f07d7952db0c6127d5e4bc3f41c82b3304b6b5aa/ptts-pyo3/src/lib.rs) requires checkpoint support, and [create_voice.rs](https://github.com/gradium-ai/xn-ptts/blob/f07d7952db0c6127d5e4bc3f41c82b3304b6b5aa/ptts/examples/create_voice.rs) says audio conditioning needs the speaker encoder in the full checkpoint. That separate local route was not provisioned or tested; local Phonon cloning is unverified rather than ruled out.

Kokoro offers fixed voice selection, blending tensors and speed changes through its published API. Its voice guide warns of weakness on very short utterances and rushing on long ones. No audition here establishes subtle emotion, Irish accent retention, intelligibility or superiority to VoxCPM2. Pocket's documented audio conditioning and exported voice state are local operations after assets are available, but were not exercised. The generic Phonon API exposes a local conditioning route too, but no local custom voice route was tested for either candidate. No embedding portability between these models is assumed.

## Device recommendations and whole-assistant limits

| Device | Proposed choice | Conditions before claiming support |
|---|---|---|
| Current Ryzen AI 9 HX 370, RTX 5080 Laptop, 64 GB machine | Continue VoxCPM2. Offer Phonon only after an audition as a CPU choice to reduce GPU contention. | Validate chosen voice, cancellation, normal replies and physical onset with recognition, brain and playback active. No replacement was proven acoustically better. |
| CPU-only laptop | Phonon 31M q8 is the first candidate. | Check operating system, instruction set and real recognition/brain load on the actual laptop. The measured Ryzen times are not predictions for other CPUs. The current 64,000-token Bonsai brain configuration and CPU recognition may dominate whole-device memory and compute. Smaller brain/context configurations are separate, untested proposals. |
| Handheld | Phonon 31M q8 is the first conditional candidate, using CPU execution. | Identify device, operating system, available memory and sustained power/thermal limits. No handheld measurement, battery-life claim or integrated-graphics acceleration claim exists here. A 16 GB shared-memory device cannot be assumed to fit the current 64,000-token brain context plus recognition and synthesis; validate the complete assistant on that device. |

The [v0.4.0 command-line guide](https://github.com/gradium-ai/xn-ptts/blob/f07d7952db0c6127d5e4bc3f41c82b3304b6b5aa/docs/cli.md) lists Linux x64/ARM64, macOS Apple silicon/Intel and Windows x64 archives. Its x86 desktop archives require x86-64-v3, including AVX2, FMA and F16C; Linux archives require glibc 2.35+. The current host reports those CPU features and glibc 2.44. This is eligibility evidence, not a test of the standalone archive. Older x86 devices need a suitable source build and independent validation; an unidentified handheld cannot be marked supported. Published Apple/Raspberry Pi speed figures in the [Phonon README](https://github.com/gradium-ai/xn-ptts/blob/f07d7952db0c6127d5e4bc3f41c82b3304b6b5aa/README.md#performance) are upstream observations on their own runtimes and workloads, not Kestrel budgets. Pocket's approximately 200 ms first-chunk and six-times-real-time MacBook Air M4 claims are likewise published, untested here.

Before the trials, both installed services were active. A host read reported GPU video memory of 16,303 MiB total, 11,299 MiB used and 4,635 MiB free, covering all GPU processes. Systemd reported CPU-side cgroup `MemoryCurrent` of 1,251,594,240 bytes for voice and 490,213,376 bytes for brain. These are context snapshots, not per-model GPU allocations or process peak memory. A separate RAM snapshot showed 66,470,125,568 bytes total and 19,371,114,496 available, with swap already in use. The active voice checkout was `/home/zain/.local/share/kestrel/shortcut-memory-cpu`, distinct from the research worktree.

The trials left those services warm and used no GPU model. They did **not** concurrently exercise recognition and brain inference, microphone capture, echo removal, interruption, loudspeaker playback or physical onset. Existing service activity and free video memory do not establish that all stages meet latency or memory limits under load. Moving synthesis to CPU would share compute and memory bandwidth with Nemotron recognition and the rest of the host; only a combined trial can decide whether it helps. No private notes, traces, recordings or voice presets were inspected or used.

## Local CPU observations

The isolated environment used CPython 3.12.15, `ptts==0.4.0`, `kokoro==0.9.4`, `torch==2.14.1+cpu`, `numpy==2.5.4`, `misaki==0.9.4` and `en_core_web_sm==3.8.0`. Both candidates used four tensor-operation threads, direct local checkpoint paths and seed 1234. Trial commands ran under `unshare -Urn`, with `HF_HUB_OFFLINE=1`, implicit Hub tokens disabled and an empty CUDA device selection. Network namespace creation and all twelve synthesis calls succeeded. No account credentials, hosted synthesis or browser demo was used.

Cold load means first object creation in a fresh process after import, **with downloaded files and operating-system caches available**. It is not uncached disk boot or installation. Import is reported separately and excludes the prior imports of `time`, `resource` and NumPy. Each model then processed short and long prompts in that order for three rounds. Round zero is shown separately; rounds one and two are the repeated warm measurements. First output means the first yielded array observed by Python, before playback; the invocation did not separately log each chunk length. Total call time includes array copying and stream drain, and excludes subsequent concatenation and waveform inspection. Peak resident set size (RSS) is the process high-water mark from Python's native `resource.getrusage`, not model weights or steady-state memory.

| Observation | Phonon 31M q8, bundled default voice | Kokoro v1.0, `af_heart` |
|---|---:|---:|
| Import, seconds | 0.001373 | 2.865928 |
| Cold object load, seconds | 0.059128 | 0.943080 |
| Round zero short first / total, milliseconds | 58.933 / 310.526 | 790.467 / 790.528 |
| Round zero long first / total, milliseconds | 25.531 / 966.606 | 4273.712 / 4273.827 |
| Warm short first, milliseconds, rounds 1 / 2 | 15.276 / 18.341 | 677.875 / 696.639 |
| Warm short total, milliseconds, rounds 1 / 2 | 247.176 / 229.137 | 677.963 / 696.697 |
| Warm long first, milliseconds, rounds 1 / 2 | 23.856 / 24.744 | 4170.731 / 4457.379 |
| Warm long total, milliseconds, rounds 1 / 2 | 910.724 / 971.508 | 4170.862 / 4457.608 |
| Generated short / long duration, seconds | 3.440 / 13.440 | 3.050 / 14.775 |
| Yielded chunks across short / long trials | 5 to 6 / 14 to 15 | 1 / 1 |
| Maximum process RSS, KiB | 401,908 | 1,571,460 |

Each concatenated utterance was finite, nonempty and nonzero. Phonon peaks were 0.324920 and 0.452895; Kokoro peaks were 0.341452 and 0.541074. Both reported/generated mono 24 kHz samples. Array checks establish waveform production, not correct pronunciation, perceptual quality, timing of sound at the speaker or an owner listening verdict. Different voice duration makes these workload observations, not controlled equivalent-prosody quality rankings. Neither trial wrote or played audio files.

Kokoro's generator can split other inputs into multiple segments. A generator interface alone does not imply within-segment streaming; these particular prompts each yielded one full segment. Phonon's Rust decoder streams while generating, as described in the [Python guide](https://github.com/gradium-ai/xn-ptts/blob/f07d7952db0c6127d5e4bc3f41c82b3304b6b5aa/ptts-pyo3/README.md#speech-and-voices). The observed delay difference supports prioritising its audition, without substituting upstream marketing numbers for local evidence.

### Provisioning and failures

| Artifact | Bytes or observed size | Evidence boundary |
|---|---:|---|
| Phonon q8 checkpoint, config, tokenizer, default voice | 65,051,089 downloaded bytes | Actual response bodies; q8 weights alone 64,512,352 bytes. |
| Kokoro v1.0 checkpoint, config, `af_heart` | 327,738,002 downloaded bytes | Actual response bodies; weights alone 327,212,226 bytes. |
| Phonon Linux x64 standalone archive | 9,327,512 compressed bytes | [Release asset metadata](https://api.github.com/repos/gradium-ai/xn-ptts/releases/tags/v0.4.0); not downloaded or executed. |
| Phonon installed Python wheel | 7,454,208 compressed bytes | [PyPI release metadata](https://pypi.org/pypi/ptts/0.4.0/json), selected manylinux x64 wheel; no model included. |
| Kokoro wheel | 32,592 compressed bytes | [PyPI release metadata](https://pypi.org/pypi/kokoro/0.9.4/json); excludes PyTorch and text processing dependencies. |
| Shared isolated trial virtual environment | 1,304,223,243 apparent directory bytes | Includes both candidates and CPU dependencies; not a per-model install total. |
| Job-local package cache | 1,263,291,683 apparent directory bytes | Separate from weights. Cache/environment hardlinks may overlap; do not add these as unique disk allocation. |
| VoxCPM2 current weights | About 4.58 GB model plus 377 MB AudioVAE | [Pinned file listing](https://huggingface.co/openbmb/VoxCPM2/tree/32279effe8c19989596f05d353d1447f51d9e915); existing installation, no new download or runtime measurement. |
| Pocket TTS | Unmeasured | Access gate prevented an anonymous raw card fetch; no weights/environment installed. |

Environment compressed download totals were not captured exactly. The environment installer reported a 187.2 MiB CPU PyTorch download and a 32.7 MiB managed Python download. Model bytes are exact and separate from those runtime costs. Native Phonon delivery can avoid PyTorch; the proposed installation size must include the chosen platform runtime, model, tokenizer and selected voices, with cache policy stated. Do not advertise a 31 MB complete installation from the parameter count.

Preparation and trials stayed within the per-candidate approximately fifteen-minute budget without a stalled download. The initial `/usr/bin/time -v` command failed with exit 127 because GNU time was absent: `unshare: failed to execute /usr/bin/time: No such file or directory`. Python's existing `time.perf_counter` and `resource` facilities supplied the observations instead. Kokoro emitted upstream recurrent-layer dropout and deprecated weight-normalization/JIT warnings; it completed successfully. This is a compatibility observation for this isolated dependency set, not a claim that Kestrel's pinned environment can accept those packages unchanged. Anonymous Pocket and Phonon 40M raw card downloads returned HTTP 401; public metadata and readable official documentation supplied the limited research claims. No access gate was bypassed.

## Proposed choosing, downloading and switching experience

These are implementation proposals, not existing controls or permission to change services.

1. Show only **Current voice: VoxCPM2** and, after acceptance, **Lightweight CPU: Phonon 31M**. Explain the voice consequence before download: Phonon starts with a different bundled voice. Its documented clone helper uploads audio; the separate full-checkpoint local conditioning route remains untested. Keep rejected/gated candidates out of a default selector. Display actual language and platform eligibility.
2. Make installation explicit and separate from activation. Show model, runtime and selected voice bytes separately; identify the source revision and voice licence. Download into a private staging location, verify sizes/hashes and completion, then mark ready. No first-reply download, terms auto-acceptance or credential probing. Offline startup uses local assets and explains missing assets.
3. Audition a fixed short and longer sentence before applying the change. Keep the current working choice until the candidate has loaded and passed the native output contract. Show the chosen model and voice plainly. Never claim that carrying over a voice name preserves speaker identity.
4. Apply at an explicit idle boundary, drain and reap the old generator/worker, and avoid briefly loading two GPU voices. Keep existing activation, stop and microphone permission semantics. Convert candidate 24 kHz output to Kestrel's existing playback contract in the adapter and verify cancellation with real generation.
5. On a failed download, load or switch, keep the selected working model and show the cause with a specific retry or restore action. Do not silently change voices or label partial assets ready. Retain the prior pinned model until the owner chooses to remove it; removing research downloads must never touch private references, notes, traces or shared model stores.

## Bounded follow-up cards

These follow-ups are filed in Backlog under Product. They retain the normal product discovery, plan and approval gates; none is implemented by this report.

| Card | Outcome and acceptance | Boundary/dependency |
|---|---|---|
| [Audition Phonon 31M alongside Kestrel's current assistant](https://github.com/zaingulel/kestrel/issues/154) | Pin one publicly licensed English voice; owner hears identical ordinary, short, long, numeric and lightly expressive prompts. Record accent/identity preference. With Nemotron and Bonsai actively handling the same approved synthetic interaction, measure first synthesis output, physical audible onset, peak CPU/GPU memory, recognition accuracy, interruption and echo behaviour. Record failure as failure. | First step. Keep VoxCPM2 default. Public samples only unless separate private-audio consent is given. No hosted cloning. Blocked by [#150](https://github.com/zaingulel/kestrel/issues/150). |
| [Use an accepted Phonon CPU voice through Kestrel's speech adapter](https://github.com/zaingulel/kestrel/issues/155) | If the audition passes, implement only Phonon 31M using local pinned assets. Preserve activation, fresh conversation, playback, interruption, repeat and stop contracts. Verify 24 kHz conversion, finite samples, worker ownership and bounded drain on actual native generation, plus existing adapter tests with a discriminating failure. | Depends on owner voice acceptance and an approved architecture plan. Runtime/privacy seam requires its sign-off and security review. Blocked by [#154](https://github.com/zaingulel/kestrel/issues/154). |
| [Choose, prepare and switch accepted speech models with recovery](https://github.com/zaingulel/kestrel/issues/156) | For VoxCPM2 and accepted Phonon only, provide source/size/licence visibility, verified staged download, ready/refused states, offline missing-asset advice and an explicit idle switch retaining the old selection on failure. Demonstrate interrupted provisioning and failed candidate load without changing the working voice. | Depends on the adapter contract. No general plugin registry, automatic hardware selector, gated model onboarding or hosted voice upload. Blocked by [#155](https://github.com/zaingulel/kestrel/issues/155). |
| [Validate the complete assistant on a CPU-only laptop and a handheld](https://github.com/zaingulel/kestrel/issues/157) | Name the actual hardware and operating system, repeat whole-assistant native acceptance at sustained load and record measured storage, memory, response time and power/thermal behaviour. Mark each profile supported only after its own evidence. | Device-specific evidence cannot be inferred from this Ryzen laptop. If either misses the required experience, keep it unavailable. Blocked by [#155](https://github.com/zaingulel/kestrel/issues/155). |

## Reproduction and pinned sources

All timings came from short direct upstream API calls, not a new benchmark tool. Raw output, package-install output, public source snapshots and download hashes are ignored job-local evidence. The following commands describe the measured setup; they are research reproduction instructions, not changes to the installed service. The isolated virtual environment was created with `uv venv .runtime/research-150/venv --python 3.12`; uv supplied CPython 3.12.15, backed by `/home/zain/.local/share/uv/python/cpython-3.12.15-linux-x86_64-gnu/bin/python3.12`. This managed interpreter was downloaded during preparation and retained; candidate packages, model downloads and cache are job-local. It is not the installed service interpreter. Model files were downloaded anonymously from the exact revisions below. English text processing used the [spaCy 3.8.0 model wheel](https://github.com/explosion/spacy-models/releases/tag/en_core_web_sm-3.8.0).

```sh
uv pip install --python .runtime/research-150/venv/bin/python \
  --cache-dir .runtime/research-150/cache \
  ptts==0.4.0 kokoro==0.9.4 soundfile torch \
  --index https://download.pytorch.org/whl/cpu \
  --index https://pypi.org/simple --index-strategy unsafe-best-match
uv pip install --python .runtime/research-150/venv/bin/python \
  --cache-dir .runtime/research-150/cache \
  https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl
```

The unpinned transitive packages in that preparation command describe what ran, not a reproducible future lock. The observed versions above and preserved package output identify the trial. Future delivery needs its own reviewed dependency pins.

Each candidate ran as a separate process with the following shell prefix. Calls used `time.perf_counter()` around import, construction, the first generator yield and exhaustion, with `resource.getrusage(resource.RUSAGE_SELF).ru_maxrss` after each call. Arrays were copied and concatenated only to check length, finite values and peak, without playback.

```sh
unshare -Urn env HF_HUB_OFFLINE=1 HF_HUB_DISABLE_IMPLICIT_TOKEN=1 \
  CUDA_VISIBLE_DEVICES='' .runtime/research-150/venv/bin/python -u -
```

Phonon construction and generation:

```python
import ptts
ptts.set_num_threads(4)
tts = ptts.TTS('.runtime/research-150/phonon', lang='en', quant='q8', device='cpu')
with tts.stream(text, voice='default', seed=1234) as audio:
    for chunk in audio:
        pass  # The measured invocation timed and copied each yielded array.
```

Kokoro construction and generation:

```python
import torch
from kokoro import KModel, KPipeline
torch.set_num_threads(4)
model = KModel(repo_id='hexgrad/Kokoro-82M',
               config='.runtime/research-150/kokoro/config.json',
               model='.runtime/research-150/kokoro/kokoro-v1_0.pth').to('cpu').eval()
pipe = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M', model=model, device='cpu')
voice = torch.load('.runtime/research-150/kokoro/voices/af_heart.pt', weights_only=True)
torch.manual_seed(1234)  # Repeated before each timed call.
for _, _, chunk in pipe(text, voice=voice, speed=1):
    pass  # The measured invocation timed and copied each yielded array.
```

The fixed synthetic prompts, in order in each of three rounds:

> Hello. I am ready to help with your next question.

> At 9:30 tomorrow, please review the three options. The first is smaller, the second keeps the familiar voice, and the third needs more testing. We can make a careful choice after listening to the same sentences on each device.

| Source/artifact | Pinned identity |
|---|---|
| Phonon runtime release/docs/clone script | `v0.4.0`, commit `f07d7952db0c6127d5e4bc3f41c82b3304b6b5aa`; [annotated tag object](https://api.github.com/repos/gradium-ai/xn-ptts/git/tags/94f6c08e4a0e198bc9f3eb988535ab207607e334). |
| Phonon 31M model | `541f5752bc3c79583068bb205bfda5eb39aaa08a`; q8 SHA-256 `a7d9aad2cd6dc66473f24a08bc6d2939030ef4d751ef82349361fbef3272dbae`; default voice SHA-256 `f739e8c4c76ee7f92e7c94a82002748c8cd22e99582ac49f7b9b94cd63786e18`. |
| Phonon voice catalogue | `0ee17205f254b5abc43b266c8a0f215565c352f7`; source/licence read, no extra catalogue voice trial. |
| Kokoro model | `f3ff3571791e39611d31c381e3a41a3af07b4987`; v1.0 weight SHA-256 `496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4`; `af_heart` SHA-256 `0ab5709b8ffab19bfd849cd11d98f75b60af7733253ad0d67b12382a102cb4ff`. |
| Kokoro runtime docs/source | `dfb907a02bba8152ca444717ca5d78747ccb4bec`; executed package `0.9.4`, wheel SHA-256 `a129dc6364a286bd6a92c396e9862459d3d3e45f2c15596ed5a94dcee5789efd`. |
| Pocket runtime docs and model metadata | Runtime `a922b912dfa366975294afb568d815b305acde5d`; model `db04f0e653473e5c7333c69686ac92b7460b0c1d`. Public source/metadata only. |
| Pocket voices | `323332d33f997de8394f24a193e1a76df720e01a`; licence/source read only. |
| VoxCPM2 | Model `32279effe8c19989596f05d353d1447f51d9e915`; code licence source `cce58a5b59303c9bd63d12f23afe6a49a4a80c59`; installed Kestrel package pin `voxcpm==2.0.3` from the operation manual; no model trial. |

The independent evidence is the upstream source and licence text, actual downloaded bytes, local native CPU/array observations and the existing operation manual. This report makes no model-judge quality claim. Documentation lint verifies document structure and local references; it does not verify upstream promises or auditory quality.
