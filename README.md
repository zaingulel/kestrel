# kestrel
A local conversation prototype for Omarchy, with speech and the Bonsai brain on the laptop.

Bonsai 2 27B runs through the pinned Prism CUDA 12.8 server on the NVIDIA RTX 5080 laptop, with a 64,000-token context and F16 (16-bit floating-point) key and value caches. Hermes uses model alias `bonsai-2-27b` at `http://127.0.0.1:8080/v1`. No Ally connection is needed.

Bonsai uses the laptop's NVIDIA RTX 5080. Speech recognition and default Phonon voice generation use its CPU (central processing unit); explicit VoxCPM2 selection uses the GPU (graphics processing unit):

| Component | Model directory | Runtime |
| --- | --- | --- |
| Bonsai 2 27B, conversation | `.runtime/models/bonsai-2-27b/Ternary-Bonsai-2-27B-PQ2_0.gguf` | `.runtime/tools/bonsai-prism-b10787-73bfe6c/cuda-12.8/llama-prism-b10787-73bfe6c/llama-server` |
| [Nemotron Speech Streaming English 0.6B](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b), Q8 CPU speech to text | `.runtime/models/nemotron-q8` | `.runtime/voice-venv` with the pinned native CPU library |
| [Phonon 31M English](https://huggingface.co/gradium/phonon-31m-en/blob/541f5752bc3c79583068bb205bfda5eb39aaa08a/README.md), q8 CPU text to speech, public Bryony British English female voice | `.runtime/models/phonon-31m-en-q8` and `.runtime/models/phonon-bryony-gfP44RlHwr2kEwk7.safetensors` | `.runtime/voice-venv` with `ptts==0.4.0` |
| [VoxCPM2](https://github.com/OpenBMB/VoxCPM), explicit GPU text-to-speech rollback | `.runtime/models/voxcpm2` | `.runtime/voice-venv` |
| Hey Kestrel, local wake phrase | `.runtime/wakeword/hey_kestrel.tflite` | `.runtime/wakeword/venv` |

The voice environment uses project-local Python 3.12, `ptts==0.4.0`, CUDA-enabled PyTorch 2.11 and Transformers 4.57. Phonon uses its native CPU runtime; VoxCPM2 retains the CUDA stack for explicit rollback. Recognition runs a standard-library worker in that voice interpreter, loading the pinned Q8 model through the native CPU library under `.runtime/tools/nemo-speech-0.2.0-linux-x86_64-cpu`. It needs no separate Python dependency environment. The worker pins the recognition model's size and SHA-256 hash; [Phonon assets](#phonon-assets-and-package) have their own fixed pins. Existing VoxCPM2 model revisions are recorded in `.runtime/models/manifest.json` and voice package versions in `.runtime/voice-installed.txt`. Keep the old GPU (graphics processing unit) recognition assets and `.runtime/asr-venv` intact; startup does not download or repair recognition assets. Runtime files are excluded from Git.

Provision the brain assets into the existing stable checkout's ignored `.runtime/models/` and `.runtime/tools/` directories. Use the immutable sources below and verify both size and SHA-256 before extraction or execution. Keep existing assets, refuse unexpected destinations, and inspect archive members before extracting: paths and library links must remain inside the new destination, with no traversal, cycles, hardlinks or special files. New directories are mode `0700`, data files `0600` and executable binaries `0700`.

| Asset and licence | Immutable source | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| Bonsai 2 27B PQ2_0, Apache 2.0 | [Model revision b072e1d3b35a0a630cece372c2127528e0994386](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/b072e1d3b35a0a630cece372c2127528e0994386/Ternary-Bonsai-2-27B-PQ2_0.gguf) | 7206168928 | `3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1` |
| Prism CUDA 12.8 archive, MIT | [prism-b10787-73bfe6c](https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b10787-73bfe6c/llama-prism-b10787-73bfe6c-bin-linux-cuda-12.8-x64.tar.gz) | 208658605 | `f61ac818da2c8cddc47d75c955b6f5bf821738138760842dd50413c5181cdfe1` |
| Matching CUDA runtime archive, retain bundled licence notices | [b11815 CUDA 12.8 libraries](https://github.com/ggml-org/llama.cpp/releases/download/b11815/cudart-llama-b11815-bin-ubuntu-cuda-12.8-x64.tar.gz) | 594377568 | `b26946028fda3195d858f2e0cdb6763cc6572dfad860ff5741b2e95f0eba5384` |

Prism's source commit is `73bfe6cc485554822f80c473a3c0c4f25e80f41b`, pinned by [Bonsai demo backend support](https://github.com/PrismML-Eng/Bonsai-demo/blob/294035ef0d42faec196a49b6a32401d5f1129c58/BACKEND-SUPPORT.md). Extract Prism under `.runtime/tools/bonsai-prism-b10787-73bfe6c/cuda-12.8/` and the CUDA runtime under `.runtime/tools/cudart-b11815-cuda-12.8/`, preserving each archive's inner directory. The launcher sets `LD_LIBRARY_PATH` to those two runtime directories only. It pins full CUDA layer offload, one slot, 64,000 tokens, F16 key/value caches, flash attention, batch 256/microbatch 128, no automatic fit or context shift, the loopback endpoint restrictions and the private [brain key](#brain-key) file. Startup downloads or repairs nothing.

[brain-files.sha256](brain-files.sha256) records the SHA-256 checksum of the model and of every file inside both archives. The archive files' checksums were taken from a fresh download whose archives matched the sizes and checksums above, never from the copy on disk. After extraction, and whenever the brain's files should be checked, run this from the checkout or installation root:

```sh
sha256sum --check --strict --quiet brain-files.sha256 && echo 'Brain files match.'
```

It prints `Brain files match.` only when every listed file matches. Otherwise it names each changed, missing or unreadable file with `FAILED` and exits with a nonzero status. Extra files added to those folders are not detected, and the server can load extra libraries placed there.

Conversation runs through a direct Hermes Agent 0.22.2 child process, started by `bot.py` through `hermes_worker.py`. The checkout owns `.runtime/hermes-0.22.2/source`, its interpreter at `.runtime/hermes-0.22.2/venv/bin/python`, and the interpreter's backing files under `.runtime/hermes-0.22.2/managed`. The source must be at exact release commit `d923a5eb487a17c0a68801bba9ef0f56c81040a8`, with no tracked changes. Before importing the engine, readiness checks that identity and requires `run_agent` to resolve to that source's `run_agent.py`. The release reports package metadata `0.0.0`, which does not identify the reviewed source. These checks establish release identity, not cryptographic attestation of the dependency environment. Kestrel's private conversation-history adaptation is release-specific; upgrades require native compatibility checks. A missing interpreter or refused identity requires reinstalling the pinned source and recreating its environment from the upstream frozen lock with Python 3.14.7 and `HERMES_RUNTIME_DIR` set to the owned `managed` directory, then restarting Kestrel. Keep the interpreter backing in that owned layout, outside disposable temporary folders. Preparing a trial checkout does not upgrade the installed production services.

The history adapter applies the upstream thinking-only and continuation-nudge filters separately to each row on the constructed agent instance. This preserves distinct unanswered user turns without inventing assistant speech or changing the upstream class. Historical unanswered user text also keeps its singleton text-part encoding through request assembly: it protects literal leading and trailing spacing from an earlier upstream pass that trims string content. Later cache redecoration flattens those text parts back to strings; the instance adapter keeps the rows separate.

Hermes connects to the local Bonsai endpoint above. For accepted conversation turns, the engine enables Hermes' native local memory tool and exactly seven Kestrel desktop tools, with no fallback provider. Its private configuration disables tool search and its helper tools; a different tool set refuses the native session. Preparation has no tools or note access; background memory review is disabled. Kestrel handles [local mute](#local-mute), [local volume](#local-volume), [media pause and next track](#media-pause-and-next-track), [numbered workspace focus](#numbered-workspace-focus), [installed-app launching](#open-an-installed-app), [native screenshot saving](#take-a-screenshot), [stop or cancel](#stop-or-cancel), [repeat that](#repeat-that) and [spoken help](#what-can-i-say) before the engine. Natural requests can reach all seven desktop tools through the brain, including app launching and screenshots; exact local commands keep working without the brain.

Each service lifetime gets a new temporary Hermes home under ignored `.runtime/`, with isolated configuration. The child does not load the normal Hermes configuration, ambient memories or context files, and does not inherit provider credentials or proxy settings. The child writes Kestrel's identity as that home's `SOUL.md`, the engine's supported identity file. Hermes 0.22.2 also adds a documentation pointer, a profile line, a steering note and a runtime environment block that no setting removes; the worker removes exactly those blocks and fails the turn with an identity error if the prompt does not have that shape. The worker also turns off the engine's coding posture with its supported `agent.coding_context: off` setting, so no workspace snapshot or coding brief enters the brain's instructions. Each activation starts empty caller conversation history and requests a fresh native agent with a new snapshot of the bounded [automatic local notes](#automatic-local-notes). Only ordinary brain turns wait for that activation's native readiness; local controls and help remain available while it is pending. Pipecat's committed context supplies ordinary history only within that conversation. Reusable session storage, plugins and session search remain disabled. [Local diagnostic traces](#local-conversation-traces) are retained separately and never read into conversation history or notes. Shutdown terminates the child, waits for it to exit and removes only that service's temporary home, preserving the separate notes and traces.

To install a fresh pinned Hermes runtime, first provide Git, `/usr/bin/python`, network access for the official dependency build, and a real checkout-owned `.runtime` directory. Run this recipe from the intended checkout root. It verifies the release commit before importing upstream Python and builds from the frozen upstream lock. An existing target, including a failed partial installation, stops the recipe for inspection; it is never silently replaced.

```sh
(
  set -eu
  test -d .runtime && test ! -L .runtime
  kestrel_hermes_runtime="$PWD/.runtime/hermes-0.22.2"
  mkdir "$kestrel_hermes_runtime"
  git clone --depth 1 --branch v0.22.2 https://github.com/NousResearch/hermes-agent.git "$kestrel_hermes_runtime/source"
  test "$(git -C "$kestrel_hermes_runtime/source" rev-parse HEAD)" = d923a5eb487a17c0a68801bba9ef0f56c81040a8
  mkdir "$kestrel_hermes_runtime/home"
  cd "$kestrel_hermes_runtime/source"
  env -i HOME="$kestrel_hermes_runtime/home" PATH=/usr/bin:/bin LANG=C.UTF-8 HERMES_HOME="$kestrel_hermes_runtime/home/.hermes" HERMES_RUNTIME_DIR="$kestrel_hermes_runtime/managed" UV_CACHE_DIR="$kestrel_hermes_runtime/home/.cache/uv" /usr/bin/python -c 'from pathlib import Path; from pm import build_environment; print(build_environment(source=Path.cwd(), out=Path.cwd().parent / "venv", frozen=True, explicit=True, timeout=300))'
)
```

The managed Python backing and runtime home stay under this checkout-owned directory. Preparing a trial runtime does not authorise deploying it or restarting production.

### Brain key

The brain answers nothing but its `/health` readiness check without Kestrel's private key. The key is 64 lowercase hexadecimal characters and a newline in `.runtime/brain-api-key`, a regular file with no group or other permissions. Each checkout and retained installation has its own key. Create it once from that root before the brain first starts:

```sh
(umask 077 && set -o noclobber && { od -An -vtx1 -N32 /dev/urandom | tr -d ' \n'; echo; } > .runtime/brain-api-key)
```

The command refuses to replace an existing key. `run-brain.sh` gives the server the file's path, and Kestrel's conversation engine reads the file at startup; neither puts the key on a command line or in the environment. Both refuse to start when the file is missing, empty, malformed, a symbolic link, or open to other accounts. Never commit, print or copy the key. To replace the key, stop Kestrel, delete `.runtime/brain-api-key`, create it again with the command above and restart Kestrel. To query the brain by hand, pass the key to curl on standard input:

```sh
{ printf 'Authorization: Bearer '; cat .runtime/brain-api-key; } | curl -q --noproxy '*' -sS -H @- http://127.0.0.1:8080/v1/models
```

### Retained service installation

The base user units are installed from the stable checkout at `~/Projects/zaingulel/kestrel`. Save their effective definitions and all existing drop-ins before installation. The launchers require the provisioned assets above, the voice environments and the [Phonon package and assets](#phonon-assets-and-package).

```sh
systemctl --user cat kestrel-brain.service kestrel-voice.service
systemctl --user show kestrel-brain.service kestrel-voice.service -p WorkingDirectory -p ExecStart -p ExecStartPost -p Environment -p DropInPaths -p StandardOutput
```

A retained installation is an exact export of a reviewed full Git commit at `~/.local/share/kestrel/bonsai-27b-<full-commit>/`. Create that directory exclusively, then export with `git archive <full-commit>` and native `tar` extraction; a job worktree and `/run` overrides are temporary. Keep the installation when cleaning up its source job.

Its `.runtime` must be a real current-owner directory, mode `0700`. Link only the existing stable `bin`, `cache`, `python`, `asr-venv`, `voice-venv`, `models`, `voices`, `tools` and `hermes-0.22.2` dependency/asset directories. Copy the admitted [wake runtime](#wake-phrase-assets) as real private files. Notes, traces, logs, samples and temporary Hermes homes remain separate from shared dependency links. Create the installation's own [brain key](#brain-key) in it as a new file, never a link to another installation's key; a symbolic link is refused.

Before migrating notes or traces, stop voice and verify its brain, audio children and listener have exited. Admit the source stores with their existing [notes](#automatic-local-notes) and [trace](#local-conversation-traces) ownership, type, mode and link rules before reading any content. Refuse unsafe originals without repairing them. Copy admitted stores with no-follow reads into separate real private directories, preserve the originals, and validate destination admission. Keep notes mode `0700`/`0600` and traces mode `0700`/`0600`; do not merge another installation's stores. Pre-create the retained `.runtime/brain-server.log` and `.runtime/voice-server.log` privately with mode `0600`.

The base units can be installed with these existing commands while services are stopped:

```sh
install -Dm644 systemd/kestrel-brain.service ~/.config/systemd/user/kestrel-brain.service
install -Dm644 systemd/kestrel-voice.service ~/.config/systemd/user/kestrel-voice.service
```

Select the retained snapshot with persistent `~/.config/systemd/user/kestrel-brain.service.d/zz-kestrel.conf` and `~/.config/systemd/user/kestrel-voice.service.d/zz-kestrel.conf`. Where a file already exists, save its exact prior bytes first, then update it in place; otherwise create it exclusively. Other drop-ins stay as they are. Replace `<full-commit>` below with the reviewed commit; retain exact ownership copies and the prior definition bytes for rollback.

Brain drop-in:

```ini
[Service]
WorkingDirectory=%h/.local/share/kestrel/bonsai-27b-<full-commit>
ExecStart=
ExecStart=/usr/bin/env -i HOME=%h PATH=/usr/bin:/bin LANG=C.UTF-8 /usr/bin/bash %h/.local/share/kestrel/bonsai-27b-<full-commit>/run-brain.sh
ExecStartPost=
ExecStartPost=/usr/bin/env -i HOME=%h PATH=/usr/bin:/bin LANG=C.UTF-8 MAINPID=${MAINPID} /usr/bin/bash %h/.local/share/kestrel/bonsai-27b-<full-commit>/check-brain-ready.sh
StandardOutput=append:%h/.local/share/kestrel/bonsai-27b-<full-commit>/.runtime/brain-server.log
StandardError=inherit
```

Voice drop-in:

```ini
[Service]
WorkingDirectory=%h/.local/share/kestrel/bonsai-27b-<full-commit>
ExecStart=
ExecStart=%h/.local/share/kestrel/bonsai-27b-<full-commit>/run-voice.sh
Environment=KESTREL_TTS_MODEL=phonon KESTREL_VOICE=irish-female KESTREL_MANAGED_BRAIN=1
StandardOutput=append:%h/.local/share/kestrel/bonsai-27b-<full-commit>/.runtime/voice-server.log
StandardError=inherit
```

Read back every effective property and drop-in after `systemctl --user daemon-reload`. Both working directories, launchers, the brain readiness command and logs must resolve to the retained snapshot; CPU voice settings and existing service lifetime/kill settings must remain intact. Refuse unexpected later overrides or paths into a job worktree or `/run`.

```sh
systemctl --user daemon-reload
systemctl --user cat kestrel-brain.service kestrel-voice.service
systemctl --user show kestrel-brain.service kestrel-voice.service -p WorkingDirectory -p ExecStart -p ExecStartPost -p Environment -p DropInPaths -p StandardOutput
systemctl --user enable --now kestrel-voice.service
systemctl --user status kestrel-brain.service kestrel-voice.service
```

Startup leaves conversation inactive. Verify the actual Bonsai alias, 64,000-token context, CUDA/F16 placement, CPU speech and local readiness before activation; `/health` alone does not establish model identity. Confirm that a request without the key is refused: `curl -q --noproxy '*' -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/v1/models` prints `401`. Restart once with `systemctl --user restart kestrel-voice.service` and repeat effective-path/readiness/inactive checks. This verifies a service restart; graphical-login and reboot behaviour require their own observation.

For rollback, stop voice first and verify both units, owned children, socket and graphics allocation have released. Use `cmp` against saved owned copies before changing this installation's exact `zz-kestrel.conf` files: where prior bytes were saved, restore them over the file; remove the file with `rm -i` only where this installation created it. Unrelated drop-ins are preserved. Run `systemctl --user daemon-reload`, repeat `cat`/`show` above, and restore the recorded prior active state with `systemctl --user start kestrel-voice.service` only when it was previously active and voice is intended. Preserve installation snapshots and private owner stores.

Use the effective voice `WorkingDirectory` for its notes `.runtime/hermes-memory/` and traces `.runtime/hermes-traces/`. Inspect `StandardOutput` and the drop-ins for actual log destinations. The unchanged root-main GUI plugin and shortcut may remain at `~/Projects/zaingulel/kestrel/desktop` when `Panel.qml`, `Conversation.qml`, `Service.qml`, `NativeInputs.qml`, `control.py`, `status.py` and `conversation.py` are byte-identical to the retained installation. This preserves the local control protocol; otherwise use matching reviewed interface files before enabling controls.

The enabled voice service starts at graphical login after reboot and waits for the desktop session environment before launching voice. This also starts microphone use, including during speech startup. It first starts Bonsai and waits for a successful HTTP (Hypertext Transfer Protocol) 200 response from `/health`, bounded by the brain's 130-second startup allowance. The readiness command ignores curl configuration and proxies, discards the response body and refuses redirects. Managed readiness also verifies that the main process identifier (PID) supplied by systemd owns the listening socket at `127.0.0.1:8080`, using installed `lsof` and coreutils `timeout`. Missing, invalid or mismatched ownership refuses readiness. This verifies HTTP readiness and socket ownership at startup, not model identity. Before creating Hermes, managed voice checks that its owned `kestrel-brain.service` is active. Failed or unavailable status leaves local controls available but sends neither preparation nor user conversation to the port; an ordinary turn receives the engine-failure advice. Ownership and unit status are startup snapshots, not ongoing server identity verification; they do not prevent a later local takeover. Neither service restarts automatically.

```sh
systemctl --user status kestrel-voice.service kestrel-brain.service
systemctl --user restart kestrel-voice.service
systemctl --user stop kestrel-voice.service
```

Stopping or restarting voice also stops or restarts its brain; logout stops both. Brain has no separate enablement. Output appends to ignored `.runtime/voice-server.log` and `.runtime/brain-server.log`, which survive restarts. To stop now and prevent future login startup:

```sh
systemctl --user disable --now kestrel-voice.service
```

For foreground operation, stop the user service first. In one terminal, start the brain:

```sh
./run-brain.sh
```

In a second terminal, wait for readiness and start voice:

```sh
./check-brain-ready.sh && ./run-voice.sh
```

Both brain commands take no options. `./run-brain.sh` refuses to start until the checkout has its [brain key](#brain-key). Without a `MAINPID` environment key, `check-brain-ready.sh` checks HTTP readiness only; a present empty or malformed value is refused. Foreground voice connects directly to its configured loopback endpoint and does not query systemd, so this recipe requires the intended brain to own the listener. If the endpoint is unavailable, `./run-voice.sh` alone still provides local controls and the spoken brain-failure advice. If an unrelated compatible server owns the endpoint, foreground voice can send preparation and conversation to it. Stop foreground voice and brain with `Ctrl+C` in their respective terminals.

Kestrel captures and plays audio directly on the laptop through PipeWire. No browser is needed. Startup verifies Kestrel's own echo-removed microphone before loading and preparing the speech models. Ordinary speech recognition then stays inactive until you start a voice conversation; the prepared service can listen locally for **Hey Kestrel**. Explicit typed requests can use an output-only conversation while voice stays inactive. Stop the service, or press `Ctrl+C` in a foreground terminal, to release the microphone and models. To restart after a failure, use `systemctl --user restart kestrel-voice.service`.

### Wake phrase assets

The wake detector uses its own real, checkout-owned `.runtime/wakeword/venv` with Python 3.12 and the exact pins in [requirements-wakeword.txt](requirements-wakeword.txt): `pyopen-wakeword==1.1.0` and `numpy==2.5.4`. Provision it separately from the voice environment using copied SDK dependency files rather than hardlinks, without compiling Python bytecode, and provide the accepted private `.runtime/wakeword/hey_kestrel.tflite` model. Keep `.runtime/wakeword` real, private and owned by the service account; preserve that independent environment rather than linking a prototype checkout. The source identities in [wakeword.py](wakeword.py) are authoritative for the loaded software development kit (SDK) assets and custom model. The model is 206,764 bytes with SHA-256 `9a74847c8ba90dcf82c210c62d30e51ad84cf5682426c28509b0c0a9fe8797a9`. Loading refuses symlinks, unsafe ownership or write permissions, nonregular or multiply linked assets, mismatched bytes and an SDK package `__pycache__`. Startup downloads or repairs nothing.

Missing or refused assets, worker failure, invalid results or overloaded frame delivery disable wake detection for that service lifetime and log: **Wake phrase unavailable. Press Super + Shift + K to start. Check the service log and restart Kestrel.** The shortcut remains available when cleanup succeeds. Uncertain recorder or detector cleanup refuses new activation; inspect the service log and restart Kestrel.

Automated production-worker evidence covers the accepted private recording and equal-length silence. It does not establish real microphone reliability or rejection of ordinary conversation or television. Those require a separate owner-present trial.

### Thinking for one answer

Ordinary replies use thinking off. Begin the current request with **Think more deeply about** followed by a nonempty question to enable thinking for that answer, including its tool rounds. Matching ignores case and surrounding whitespace; quoted, negated, embedded or historical uses do not enable it. The next ordinary request returns to thinking off, including after a failed deep answer. The accepted request text remains unchanged in visible conversation history.

Ordinary requests initially allow 180 output tokens; explicit deep requests initially allow 16,384 with medium reasoning effort. Native within-turn continuations can increase a later call's allowance, so these are initial per-call settings rather than hard total-turn output budgets. Recognized reasoning delimiters and private structured fields are filtered before visible delivery; malformed reasoning content refuses the answer. See the [local conversation trace rules](#local-conversation-traces) for diagnostic contents and retention.

The worker exchange for an accepted brain turn is bounded to 1,800 seconds, including long-history prefill, in either thinking mode. Hermes worker startup, fixed preparation and fresh-session begin each use a 45-second bound. The separate brain-service startup allowance is 130 seconds. These bounds supervise failures; they are not response-time promises. [Stop or cancel](#stop-or-cancel) keeps its existing output suppression and accepted-work accounting while native generation drains.

### Start and end a conversation

Say **Hey Kestrel**, then wait for local speech readiness before making your request. The wake phrase starts a fresh conversation; its audio is discarded rather than forwarded as part of the request. Repeating the wake phrase while active cannot toggle or restart the conversation. With the [shortcut recipe](#native-conversation-panel-and-status-indicator) installed, **Super + Shift + K** also starts a fresh conversation. The panel's voice button, left of **Send message**, sends the same request. Once ready, speak naturally, pause for a reply, and speak again to interrupt it. Active idle means local speech is ready; it does not promise the engine or note snapshot is ready. Press the same shortcut or the voice button, or say **that's all**, to end the conversation. Quiet periods leave an active conversation ready for speech. **Super + F12** only opens or hides the conversation panel; closing that panel leaves conversation activation unchanged.

Starting is an accepted request, not proof that capture is ready. Startup and activation show starting; accepted dismissal immediately shows inactive while cleanup finishes. Ending immediately revokes new input, brain requests, local actions and playback, clears panel text and repeat state, and closes the conversation's capture and playback. Already-submitted recognition and brain requests, generator cleanup and already-started local actions finish under their existing bounds. An accepted note write can therefore finish during dismissal. A new activation waits for that work and its audio children to finish, then starts empty caller history, repeat and panel state. Its ordinary brain turns await their own fresh native session and note snapshot, while local controls and help can work immediately after local speech is ready. If you press the shortcut during cleanup, only the latest requested active or inactive state is kept. Cleanup failure or its 90-second watchdog leaves trouble and refuses further activation; restart the service after checking the log.

Inactive does not mean microphone release. The echo-removal process and warm models stay running, and the microphone remains in use. Inactive room audio is not admitted to ordinary recognition, spoken caller transcripts, brain requests or local actions. An explicit typed request can use the shared conversation and local controls, and receive a spoken reply, without changing voice activation or opening an ordinary recognition capture child. Startup's fixed model preparation is separate from ordinary recognition and conversation. The selected speech model loads once and completes a nonempty audio warmup before the service is prepared. Shutdown releases the model, including graphics memory when VoxCPM2 is selected. VoxType can stay running.

While inactive and prepared, Kestrel uses a temporary verified echo-removed capture and an isolated local detector for the wake phrase. This waiting audio never enters ordinary recognition, transcripts, brain requests, notes or local actions. The waiting recorder and detector are closed and reaped before conversation capture starts. Accepted typed requests immediately revoke waiting detection and keep it suppressed through the matching reply's actual output completion, including silent stop/cancel and confirmed local actions. A fresh waiting recorder and detector resume afterward when voice remains inactive, discarding previous audio and detector buffers.

Typed requests and completed spoken turns share the current conversation. Starting voice still starts a fresh conversation, including after typed-only use. Each accepted request takes ownership of later replies and interrupts obsolete output. Audio already delivered to the operating system cannot be recalled. Unfinished speech is discarded during typed handover; recognition waits for fresh detected speech afterward. Already-accepted local actions keep their order and execute once even if newer input replaces their reply; dismissal still revokes queued actions that have not started. Explicit stop or cancel also refuses queued mute, volume, media and workspace actions on both the exact and brain routes, and brain-requested app launches and screenshots that have not started.

The same-account control endpoint accepts bounded typed text through `desktop/control.py --submit`, using standard input rather than command-line text. A matching accepted receipt means Kestrel owns the request, not that an action or reply has finished. A lost receipt does not cancel or repeat accepted work. Refusal or uncertain delivery retains the draft; check the conversation before deliberately sending again because an action may already have run. Reconnect never resends. Hiding the panel leaves the conversation and draft intact; dismissing voice clears the conversation. Drafts exist only in the mounted panel's memory and are lost on plugin reload or destruction.

Speech goes from the microphone through owned echo-removed capture to local Nemotron recognition. Completed exact mute, volume, media, workspace, resolved installed-app, screenshot, stop/cancel, that's all, repeat and help commands are handled locally and stay out of later brain-request history. Brain-selected desktop calls and their results are retained in the current conversation for later brain requests. Other turns go through the local Hermes worker to local Bonsai, then through the selected local speech model and to native playback on the default output. Recognition processes speech segments after detected pauses; Kestrel does not provide word-by-word partial transcripts. Pipecat's local Silero speech detector and Smart Turn model control turn-taking. Smart Turn uses a 0.6-second silence fallback when it is uncertain, so Kestrel may reply during a thinking pause. It can still recognize a completed turn sooner. The selected speech adapter receives completed sentences and streams their audio. Phonon generates mono 24 kHz audio, continuously resampled to the existing 48 kHz playback format. The brain request disables reasoning output with `reasoning_effort: "none"` for responsive conversation.

For natural requests, the brain can choose `mute`, `set_volume` with an integer `percent` from 0 through 100, `pause_media`, `next_track`, `focus_workspace` with an integer `number` from 1 through 2147483647, `open_app` with a text `name` of 1 to 1,024 characters and at most 1,024 UTF-8 bytes, not blank and without control characters, or `take_screenshot`. `mute`, `pause_media`, `next_track` and `take_screenshot` take no arguments. Extra arguments, decimal or boolean values and out-of-range values are refused. Invented or fuzzy desktop names are not repaired into another tool. The brain cannot unmute as a separate action, resume media or go back a track; volume setting can still unmute as described below.

Both routes use the same implementations, permission checks, action queue and readback. The local command sections below describe the exact phrase route: a confirmed volume change, accepted app launch or saved screenshot says a short fixed confirmation, while other confirmed successes are silent; a brain-selected call gets no such confirmation and can receive a conversational reply. Each desktop tool name is allowed at most once per brain turn, without automatic action retries. Its JSON (JavaScript Object Notation) result contains `confirmed`, `attempted` and `reason`; confirmation reflects the operation's observed readback, including a verified no-op. The brain is instructed to claim an effect only when `confirmed` is true and never before its result arrives. Kestrel does not detect an unsupported prose claim, whether the model called no tool or spoke the claim before its tool's result; speech already delivered is not withdrawn. For `open_app`, `confirmed` means the launcher accepted the request, not that a window is visible; a name matching no installed app or several returns `no unique installed app`, and an unavailable or malformed lookup returns `app lookup failed`, each with fixed spoken advice and no launch. A `take_screenshot` result carries no path or image content.

An invalid call attempts to say **I couldn't use that request, so I didn't do it.** A call whose permission tier is not available attempts to say **That needs permission, which isn't available by voice yet, so I didn't do it.** Invalid, permission-refused or unconfirmed calls close that turn to further desktop effects; Kestrel uses fixed advisories and suppresses the model's later text. Already-started effects are not undone. The existing 45-second turn bound includes tool calls and any interrupted native turn still draining.

Bonsai chooses words and a delivery label together: neutral, curious, gently pleased or reassuring, with neutral preferred when uncertain. VoxCPM2 maps the label to subtle synthesis instructions; Phonon uses Bryony without those instructions. Generated replies are instructed to start with a short delivery header before the same first-sentence streaming path. Kestrel accepts only those four labels and keeps the header and synthesis instructions out of spoken-text attribution, panel text, repeat and caller conversation history. Later reserved delivery markers are also omitted from spoken words. Ordinary untagged prose uses neutral delivery and leaves the conversation available for later turns. Any reply beginning with `[` must have a valid delivery header immediately at the start; otherwise it is refused. A reply beginning with the reserved token `delivery:` after optional whitespace is also refused. Malformed, unknown, incomplete or whitespace-prefixed bracketed headers refuse the reply with restart advice.

VoxCPM2's reference-only synthesis can vary delivery and speaker characteristics. Subtlety, voice consistency and whether synthesis instructions stay inaudible require listening to completed-path audio; text-separation tests alone do not establish acoustic compliance. Kestrel does not promise deterministic acoustic compliance.

Hermes can continue a long reply with successive output caps of 180, 360, 720 and 1,440 tokens, a total budget of up to 2,700 tokens across four calls. If it still cannot finish, Kestrel speaks an incomplete-reply warning and requires restarting Kestrel. This output budget is separate from the 64,000-token context capacity, which holds conversation history, instructions and replies. Long conversations can eventually fill that context.

Speaking over a reply stops its speech and playback. Hermes continues the current brain request and its later desktop calls until it finishes; already-accepted actions still run in order. The next ordinary conversation turn waits for that work to drain, which can add a delay. Local controls, repeat and help do not wait for the interrupted brain request. Exact stop/cancel ends the reply without submitting another brain request and refuses further queued shared actions; it leaves native work draining as described under [Stop or cancel](#stop-or-cancel). Unheard text from the interrupted reply is discarded, so only the speech prefix delivered to output enters the next turn's text context; observed desktop tool records remain available even when that reply was interrupted. Replacement requests stay separate even when no sentence of the interrupted reply has entered conversation history, and earlier user context remains available. Shutdown ends the worker rather than draining another conversational turn.

If the engine or note initialization is unavailable, an activated conversation keeps exact local controls, repeat and help available. Status reports trouble; an ordinary conversation turn receives the engine advisory for an engine failure or the fixed notes advisory for unsafe or unreadable notes, with no automatic retry or claim of a fresh note snapshot. A later activation can still provide local controls, but the unavailable engine is not retried. This differs from uncertain resource cleanup, which refuses further activation. Brain failures, incomplete replies and invalid worker responses also produce a spoken explanation, with the diagnostic reason in the service log. A partial reply already spoken is not treated as a complete answer. The brain's iteration/tool-loop budget is nine calls; Hermes can then make an additional closing summary request, which Kestrel discards as unverified. That capped turn is marked failed and says **I couldn't get a complete reply from the brain.**, then the conversation status returns to active idle and the same engine session remains available for the next turn. Already-spoken speech and observed desktop tool records stay in the conversation, and Kestrel does not replay the failed user turn. If you spoke over the capped reply, its warning is suppressed. Kestrel does not automatically submit a failed user turn again or restart a broken engine session; follow the spoken advice and consult the diagnostic reason in the service log before restarting Kestrel. Every other brain failure, including output-cap truncation, keeps restart advice. Hermes may retry transient provider errors within a turn. Engine startup, each native session begin and each turn, including native retries or an interrupted turn draining, each have a 45-second bound.

### Speech model and reference selection

`KESTREL_TTS_MODEL` selects the speech model once at startup: an absent setting selects `phonon`; the only explicit values are `phonon` and `voxcpm2`. Blank or unknown values refuse startup. A failed model load or warmup stops preparation with advice; Kestrel never silently switches providers. These are setup instructions, not evidence that a retained installation has been upgraded.

Phonon uses the fixed local English 31M q8 checkpoint on the CPU with four runtime threads, the fixed public Bryony British English female voice (`gfP44RlHwr2kEwk7`) and seed 1234. The verified configuration is Linux x86-64 on this laptop using the pinned manylinux wheel; other CPU configurations are unverified. It receives spoken text without private reference audio, the reference transcript or VoxCPM2's expressive synthesis instructions. Internal reply delivery labels do not select Phonon voices or conditioning. Kestrel is instructed to ask useful follow-ups as separate sentences; occasional unnecessary follow-ups remain a limitation.

`KESTREL_VOICE` independently selects the local reference preset. Its default remains `irish-female`; `british-male` and the original `kestrel` reference remain available. This reference is still validated and used for recognition warmup with either speech model, so keep its WAV and transcript even with Phonon. It conditions generated speech only when VoxCPM2 is selected; selecting an Irish reference does not change Bryony's British English voice.

For explicit VoxCPM2 rollback with the British reference in a foreground terminal, run:

```sh
KESTREL_TTS_MODEL=voxcpm2 KESTREL_VOICE=british-male ./run-voice.sh
```

For the user service, inspect the effective installation described above and its existing overrides first. Run `systemctl --user edit kestrel-voice.service` and set:

```ini
[Service]
Environment=KESTREL_TTS_MODEL=voxcpm2
Environment=KESTREL_VOICE=british-male
```

Then run `systemctl --user daemon-reload` and `systemctl --user restart kestrel-voice.service`. Use `KESTREL_VOICE=irish-female` for the default reference or `KESTREL_VOICE=kestrel` for the original reference. To restore Phonon, set `Environment=KESTREL_TTS_MODEL=phonon` in the override and reload/restart. Foreground Phonon selection is `KESTREL_TTS_MODEL=phonon ./run-voice.sh`; leaving the variable absent also selects Phonon. Preserve local VoxCPM2 assets and dependencies for rollback; no uninstall or private-data deletion is needed.

Presets are local files in the ignored `.runtime/voices/` directory. Each preset named `<name>` has a matching `<name>.wav` and `<name>.txt` file. Names contain 1 to 64 lowercase letters, digits, underscores or hyphens, and begin with a letter or digit. The transcript is the exact spoken reference in UTF-8, must not be blank, and is limited to 4 KiB; ASCII control characters are not allowed except tab, carriage return and line feed. The WAV must be nonempty, mono 48 kHz PCM16, no longer than ten seconds and no larger than 1 MiB. To add a preset, place both correctly named files in that directory and put the exact spoken words in the text file; no code change is needed. Keep these local voice files out of commits and publication.

Kestrel selects and validates the pair once during startup, before loading the speech models. A missing or invalid selection or asset stops startup with an explanation rather than switching to another reference. Stop and restart Kestrel before changing files for the selected preset. With VoxCPM2 only, neutral replies, startup preparation, local command replies, repeat and failure advice use [paired audio and transcript cloning](https://github.com/OpenBMB/VoxCPM#-ultimate-cloning). Expressive conversational replies use reference-only cloning with the same selected audio reference and one fixed synthesis instruction. The selected reference stays the same across sentences and replies.

### Phonon assets and package

Provision Phonon manually before starting the default service. Work from the effective voice checkout, with the service stopped; keep its existing runtime environments, asset links, reference presets and private stores. Obtain the four public files from [this exact checkpoint revision](https://huggingface.co/gradium/phonon-31m-en/tree/541f5752bc3c79583068bb205bfda5eb39aaa08a). Stage them in a new directory under `.runtime/models/`, verify every byte size and SHA-256 below using `wc -c` and `sha256sum`, then rename that directory to `.runtime/models/phonon-31m-en-q8` only if the destination is absent. If a destination already exists, inspect and verify it rather than overwriting it.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `config.json` | 4,634 | `b5d0f88353638370d94035b7d73d7d6577c0554d78f8d7ecfd40490aae39ae85` |
| `tokenizer.json` | 277,967 | `691a00068fa7b989f2f3e5ae5daa2d1a5bb319f2d5360deafcfb19a8bb6e7936` |
| `model.q8.gguf` | 64,512,352 | `a7d9aad2cd6dc66473f24a08bc6d2939030ef4d751ef82349361fbef3272dbae` |
| `default-voice.safetensors` | 256,136 | `f739e8c4c76ee7f92e7c94a82002748c8cd22e99582ac49f7b9b94cd63786e18` |

The directory must contain exactly those four regular files, with no symlinked children or extra entries. The established parent `.runtime/models` asset link is allowed. The bundled `default-voice.safetensors` remains required and unchanged. Kestrel checks size and hash before native loading and requires a 24 kHz model with the bundled `default` voice.

Obtain Bryony separately from the [pinned public voice catalogue revision](https://huggingface.co/gradium/phonon-voices/blob/0ee17205f254b5abc43b266c8a0f215565c352f7/voices.jsonl), using its [voice embedding](https://huggingface.co/gradium/phonon-voices/resolve/0ee17205f254b5abc43b266c8a0f215565c352f7/voices/gfP44RlHwr2kEwk7.safetensors). Stage it as a new sibling file under `.runtime/models/`, verify its byte size and SHA-256 with the same commands, then rename it to the following path only if that destination is absent. Inspect and verify an existing destination rather than overwriting it. Keep it outside the four-file checkpoint directory.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `phonon-bryony-gfP44RlHwr2kEwk7.safetensors` | 256,136 | `bcc207a73b7885e45b49ab633d3377a10158292e3a7cef9cd6764ad107f1cb9b` |

Kestrel refuses a missing, corrupt, symlinked or nonregular Bryony file before native model loading. It holds the verified file open while registering the local voice as `bryony` and requires successful registration before preparation or replies. Registration failure stops preparation without falling back to the bundled voice.

Obtain the [ptts 0.4.0 Linux x86-64 wheel](https://pypi.org/project/ptts/0.4.0/#files), named `ptts-0.4.0-cp39-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl`, and verify SHA-256 `ad696a58469a8c48a47a09f119e60cb054c03835a52a7856da04b00bd9858bd1` before installation. Place that verified wheel in `.runtime/cache/`, then install only it into the existing voice environment:

```sh
uv pip install --python .runtime/voice-venv/bin/python --no-deps --only-binary=:all: .runtime/cache/ptts-0.4.0-cp39-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl
```

The existing NumPy dependency is retained; do not upgrade transitive packages as part of this installation. The pinned `_ptts.abi3.so` extension SHA-256 is `21c825ea117931edecf7a2b3e14daa578ec8d61df8fed87fecc386cb01bf9570`. Kestrel requires package version `0.4.0`. The [pinned Python API](https://github.com/gradium-ai/xn-ptts/blob/f07d7952db0c6127d5e4bc3f41c82b3304b6b5aa/ptts-pyo3/README.md) loads explicit local paths without downloading; Kestrel uses only this fixed local checkpoint and the separately pinned Bryony embedding, with no runtime catalogue lookup, download or cloning call.

Missing, incompatible or refused package/assets stop speech preparation. Check the voice service log, stop the service, and restore the exact package and file identities above, including the separate pinned Bryony file, before restarting. Do not use an unpinned latest package or a different checkpoint as a repair. Explicit VoxCPM2 selection above provides rollback when its retained local assets are available. Normal service startup and synthesis download or repair nothing.

This prototype supports conversation, natural requests for the seven desktop tools above, exact local mute and exact volume setting of the selected audio output, media pause and next track, numbered workspace focus, opening an installed app by name, saving a native screenshot, stopping a reply, ending the conversation by saying that's all, replay of the last spoken reply, and spoken help that describes what Kestrel can do, the exact phrases and the limits. It has automatic bounded local notes, with no browser research or reusable conversation archive. Transcript text can appear in the service's debug output; microphone recordings are not saved by the application. The Bonsai server listens only on local loopback at `127.0.0.1:8080` and answers nothing but its `/health` readiness check without Kestrel's private [brain key](#brain-key).

Run the speech adapters, native Hermes boundary and whole-conversation tests:

```sh
.runtime/voice-venv/bin/python -m unittest discover -s tests -v
```

Native audio uses the installed PipeWire and WirePlumber services, `pw-cat`, `pw-dump`, `stdbuf` and `setpriv`; PyAudio is unnecessary. Model files are loaded locally without automatic downloads. The voice environment also contains `voxcpm==2.0.3` and `pipecat-ai[silero,openai]==1.12.0`. The adapters follow [Pipecat's speech input and turn detection conventions](https://docs.pipecat.ai/pipecat/learn/speech-input).

VoxCPM2 only: generate a standalone sample using the retained VoxCPM command. This recipe does not exercise Phonon or change the service's selected model:

```sh
HF_HOME="$PWD/.runtime/cache/huggingface" \
MPLCONFIGDIR="$PWD/.runtime/cache/matplotlib" \
.runtime/voice-venv/bin/voxcpm design \
  --model-path .runtime/models/voxcpm2 \
  --device cuda --local-files-only --no-denoiser --no-optimize \
  --text "Hello. Speech recognition and voice generation are now running locally." \
  --output .runtime/samples/voice-demo.wav
```

The service launches `asr_worker.py` through `.runtime/voice-venv/bin/python`. It loads `.runtime/models/nemotron-q8/nemotron-speech-streaming-en-0.6b.q8_0.gguf` through `.runtime/tools/nemo-speech-0.2.0-linux-x86_64-cpu/lib/libnemo_speech_asr_c.so.1`, explicitly selecting CPU recognition. Missing or mismatched assets refuse startup with advice; the worker does not download or repair them. The caller bounds each recognition exchange, including pipe drainage and response reading, to 60 seconds.

Recorded-sample recognition has no verified runnable recipe here; do not count it as current evidence. Shortcut installation and actual dispatch, native visual and accessible-tree acceptance, microphone/speaker behaviour, live Bonsai replies and the quality of its automatic note decisions require separate installed and live acceptance. Automated boundary checks do not establish those results. Controlled-provider tests do not prove live Bonsai answers or actual login execution after reboot. Live recognition accuracy, physical playback and microphone-to-speaker latency require a spoken check. The service logs a numeric pipeline-response duration in seconds for each reply, measured by Pipecat from detected user silence to its bot-speaking frame. That frame is a pipeline proxy, not physical speaker onset; audible responsiveness still needs a spoken check.

## Local mute

Say **mute** on its own and finish the turn. After trimming surrounding whitespace and ignoring case, the recognized text must be exactly `mute`, `mute.` or `mute!`. `mute?`, quoted words, repeated punctuation, negation and longer requests go to the brain as ordinary conversation. Kestrel waits for the complete turn, not an individual speech segment. Recognition and turn detection can still mishear speech.

Kestrel uses Omarchy to resolve the selected audio output, including its physical output when digital signal processing routes sound through another sink. It explicitly sets that captured output muted at most once, never toggles it, and confirms success only after reading back mute status and checking that the selected output has not changed. Already muted is a silent no-op. Successful mute has no spoken acknowledgement or notification. The readback is a snapshot; other software can change the output afterwards.

Unmute manually through the desktop audio control. If digital signal processing routing changed, use the audio panel to select and unmute the affected output. The mute command never unmutes or retries an attempted mute. A new explicit mute turn is a new request.

If mute cannot be confirmed, Kestrel attempts to say **I couldn't confirm mute. Check the audio control. I won't retry.** and attempts a native desktop notification titled **Mute could not be confirmed**, with **Check the audio control. Kestrel will not retry.** The notification is transient and requests silent delivery. It contains fixed status text, never conversation text. Ordinary desktop notification settings apply; notification service failure is logged as unavailable. Muted speakers may hide the spoken error, and the desktop may suppress the notification, so check the audio control rather than treating silence as confirmation.

Speaking again can interrupt the failure speech while the attempted mute, readback and failure-notification attempt finish. Kestrel does not replay the request or speak a stale failure over the newer turn; if speech is interrupted and the notification is unavailable, only the local diagnostic may remain. Shutdown cancels and joins outstanding local work without undoing an attempted mute.

Startup prepares local speech and the engine concurrently. The engine receives one fixed public greeting whose reply is discarded, without note access or memory tools. The service stays inactive until explicit activation after local speech preparation. Once activated, local controls, repeat and help work even while engine preparation is pending, without an unsolicited greeting. Only ordinary brain turns await that activation's fresh native session and note snapshot, or receive failure advice if engine or note initialization is unavailable. Exact local controls work without the brain; natural requests use the brain's seven desktop tools through the same enforcement and readback.

## Local volume

Say **set the volume to 30** on its own and finish the turn to set the selected output to 30% and unmute it. Use `volume <level> percent` or `volume <level>%`, or the setter forms `set volume [to] <level>` and `set the volume [to] <level>`, where `to` is optional and the level is a whole percentage from 0 through 100. A `percent` or `%` suffix is required after `volume <level>` and optional after the setter forms. Units work with digits or words, including `volume fifty%`; `%` can have one preceding space. Bare `volume two` goes to conversation. One `please` is allowed at either end, never both, as in `please set volume to 100`. Levels can be ASCII digits (`0` through `9`) without leading zeros or English names: zero through nineteen, a multiple of ten from twenty through ninety optionally followed by one through nine separated by a space or hyphen, and one hundred. Case and surrounding whitespace are ignored; internal words use single spaces, with at most one final period or exclamation mark. Questions, quotes, negation, decimals, signed or out-of-range levels, repeated punctuation, internal newlines and longer requests go to the brain unchanged. Kestrel waits for the complete turn; recognition can still mishear speech.

Kestrel captures the selected output using Omarchy's resolver, including the physical output behind digital signal processing, then writes the exact percentage to that output at most once. It verifies every channel at the requested level before clearing mute, including at zero. It confirms success only after checking that the selected output and channel names are unchanged, every channel has the requested level and mute is off. Already exact and unmuted is a verified no-op. After any confirmed result Kestrel says **Volume <n>.**, for example **Volume 40.**; it plays at the new level, so at zero it is inaudible. Success sends no notification. Readback is a snapshot; other software can change the output afterwards.

If volume cannot be confirmed, Kestrel attempts to say **I couldn't confirm volume. Check the audio control. I won't retry.** and attempts a native desktop notification titled **Volume could not be confirmed**, with **Check the audio control. Kestrel will not retry.** It uses the same transient, silent, fixed-text pattern and delivery limitations as mute failure. If the volume write cannot be confirmed, Kestrel does not proceed to unmute. It never retries, undoes an attempted change or falls back to another output; a new explicit volume turn is a new request.

Speaking again can interrupt the failure speech while local verification and the notification attempt finish. Kestrel keeps the request out of brain history and suppresses stale failure speech over a newer turn. Shutdown cancels and joins outstanding local work without undoing an attempted change. Mute, volume, media, workspace, app-launch and screenshot actions run one at a time, in the order their spoken turns complete.

## Media pause and next track

Say **pause music** or **next track** on its own and finish the turn. These phrases, numbered workspace focus, screenshot saving and stop/cancel ignore case and surrounding whitespace and allow one final period or exclamation mark. Questions, quotes, negation, repeated punctuation, internal newlines and longer requests go to the brain unchanged. Internal words use single spaces. Kestrel waits for the completed turn; recognition and turn detection can still mishear speech.

Kestrel uses Omarchy's native media pause or next action and reads its active-player status. With no selected player, or with a paused player, it takes no action and says **I couldn't find a playing media player.** This describes the managed player's observed playback; other PipeWire audio can still be audible, so it does not establish global silence. Next also refuses before acting if the player cannot advance or its title or identity is unavailable.

Each request sends the action at most once, then reads back state. Pause confirms only when the same nonempty reported player identity and desktop entry remain selected, track metadata is unchanged and playback is stopped. Next requires that same player information, playback still running, nonempty titles before and after, and a changed title, artist or album. Identical track metadata leaves advancement unconfirmed. These snapshots cannot prove the command caused a change or uniquely identify a player; missing or changed player information leaves the result unconfirmed.

Confirmed actions are silent. If pause cannot be confirmed, Kestrel attempts to say **I couldn't confirm pause. Check the media player. I won't retry.** For next it says **I couldn't confirm next track. Check the media player. I won't retry.** Unavailable commands, invalid status and unhandled actions use these fixed advisories, without speaking command output. Each operation has a five-second deadline, with at most three readback observations for delayed desktop updates. It never retries or undoes the action; a new explicit turn is a new request. Media and workspace controls require access to the running desktop session.

Media and workspace failures use speech rather than the mute/volume desktop notification. Their requests and failure speech stay out of brain history. Speaking again interrupts the speech without undoing an attempted action; Kestrel suppresses stale failure speech over the newer turn. Shutdown cancels and joins outstanding local work.

## Numbered workspace focus

Say **workspace three** or **workspace 11** on its own and finish the turn, using the same [matching rules](#media-pause-and-next-track). ASCII digits without leading zeros cover 1 through 2147483647. English names use the [volume word forms](#local-volume) from one through one hundred, including `twenty one` and `twenty-one`; larger values require digits. Zero, signed numbers, decimals and out-of-range values go to the brain unchanged.

Kestrel uses the same Omarchy focus operation as the default numbered workspace keys. It reads the active workspace, sends at most one focus request, and confirms only after observing the requested numeric workspace identifier. Already on that workspace is a verified silent no-op. Successful focus is silent. The readback is a snapshot; another action can change focus afterwards.

If focus cannot be confirmed, Kestrel attempts to say **I couldn't confirm workspace 3. Check the desktop. I won't retry.**, using the requested number. The same five-second deadline and at most three readback observations apply. It never retries or undoes an attempted focus change.

## Open an installed app

Say **open Firefox** on its own and finish the turn, using the app's visible installed name. Matching ignores case and surrounding whitespace and allows one final period or exclamation mark. Names otherwise match exactly, with no fuzzy ranking. Questions, quotes around the phrase, internal newlines and empty names stay conversation. An unknown or ambiguous name, including a longer request that matches no installed name, goes to the brain with the original request and earlier context intact. Recognition and turn detection can still mishear speech.

Kestrel reads Gio's visible installed-app index through isolated system Python and sends a unique desktop-entry identifier through Omarchy's native `uwsm-app` and `gtk-launch` route. The lookup returns that identifier with the entry's installed name, which Kestrel validates before speaking it. It passes no app arguments or web addresses and does not interpret the spoken name as a command. This requires system `/usr/bin/python` with Gio introspection, `/usr/bin/env`, `/usr/bin/uwsm-app`, `/usr/bin/gtk-launch` and the running graphical desktop session. The voice environment does not import Gio.

Each eligible turn captures the account's canonical home plus the caller's `XDG_DATA_HOME`, `XDG_DATA_DIRS` and `XDG_CURRENT_DESKTOP`. Unset or empty data paths use the account home's `.local/share` and `/usr/local/share:/usr/share`; the desktop selector may be empty. Lookup and `gtk-launch` receive the same validated values, overriding conflicting activation-environment values. This keeps search roots and desktop visibility selectors consistent across the two processes. It does not freeze installed desktop-entry files against changes after lookup.

If lookup is unavailable, malformed or refused, Kestrel attempts to say **I couldn't check the installed apps. I didn't send an open request. Use the app menu.** It consumes that request locally and sends no launch request or brain fallback. Natural requests reach the same lookup and launch through the brain's `open_app` tool.

An accepted launch request says **Opening <name>.** with the matched app's installed name, for example **Opening Firefox.**; it does not prove that a window opened, so check the desktop. If dispatch fails or cannot be confirmed, Kestrel attempts to say **I couldn't confirm the app opened. Check the desktop. I won't retry.** It sends at most one launch request, with no automatic retry or brain fallback after an attempt. A new explicit turn is a new request. Known app turns and local failure advice stay out of brain history and work without the brain. Speaking again can interrupt failure speech while an attempted launch finishes; shutdown cancels and joins outstanding local work without undoing a launch. The app then has its normal permissions and behaviour, including any network access or side effects.

## Take a screenshot

Say **take a screenshot** on its own and finish the turn, using the same [matching rules](#media-pause-and-next-track). Kestrel waits for the complete turn; recognition and turn detection can still mishear speech.

Kestrel runs `omarchy capture screenshot fullscreen save` once to save the focused monitor through the installed native screenshot flow. It requires the running Wayland/Hyprland desktop session. The destination follows the same native policy as the keyboard screenshot flow: `OMARCHY_SCREENSHOT_DIR`, then `XDG_PICTURES_DIR`, then the account home's `Pictures` folder. The native script sources the account's `~/.config/user-dirs.dirs`, so its values and precedence remain authoritative. Supplied destination variables must be absolute paths without control characters, at most 4096 characters each; invalid values refuse capture. The save mode uses no clipboard or editor processing.

A confirmed save says **Screenshot saved.** Kestrel confirms only one absolute native `screenshot-YYYY-MM-DD_HH-MM-SS.png` path naming a non-symlink regular file with positive size and modification time at or after invocation. This is a metadata snapshot; it does not validate image content or prove what appears in the image. Kestrel does not open, read, decode, copy, send or delete the image, or log its path or native output. The screenshot remains in the native destination under the account's normal file permissions.

If saving cannot be confirmed, Kestrel attempts to say **I couldn't confirm the screenshot. Check your screenshot folder. I won't retry.** This includes command failure, a two-second command timeout, native cancellation or empty selection, malformed output and unavailable, stale or empty files. An unconfirmed operation may already have saved a file. Kestrel never retries or undoes capture; a new explicit turn is a new request.

Exact screenshot requests and their failure advice stay out of brain history and work without the brain. A brain-requested screenshot keeps only its confirmed, attempted and reason result in conversation history, never the path or content. Speaking again can interrupt failure speech while the native save finishes; Kestrel suppresses stale failure speech over a newer turn. Shutdown cancels and joins outstanding local work without deleting a saved file. Cursor restoration belongs to the native script; forced termination can leave restoration unconfirmed.

## Stop or cancel

Say **stop** or **cancel** on its own and finish the turn, using the same [matching rules](#media-pause-and-next-track). Speaking over a reply interrupts speech and discards queued playback, but work carries on. A completed stop/cancel is handled locally without a new brain request and additionally refuses mute, volume, media and workspace actions that have not started, on both routes, and brain-requested app launches and screenshots that have not started. Exact app and screenshot commands keep their existing behavior; for a brain-requested app launch, Done means the launch request was accepted. Already-started actions finish under their existing bounds and are never undone.

Stop/cancel returns without waiting for the current brain request or pending desktop actions. When shared-tool outcomes remain unreported, it attempts a fixed account beginning **Stopped.**, with **Done:** for confirmed outcomes, **Couldn't confirm:** for attempted but unconfirmed outcomes, and **Still finishing:** for actions still running, followed by **I won't undo anything.** Earlier outcomes whose reply output was interrupted, empty, failed or only partly delivered are included. Final outcomes retire only after their reply or stop account completes successful output delivery; an interrupted or failed account can therefore repeat at the next stop. These observations can be stale and do not prove that anyone heard the account. With no unreported shared-tool outcomes, stop/cancel is silent, including when the engine is unavailable.

The current brain request keeps draining under its existing deadline, with later desktop calls refused as stopped; the next ordinary conversation turn waits for it. Only the speech prefix delivered to output remains in text history, alongside retained desktop tool records. Stop/cancel keeps the service and microphone active. Say **that's all** or press **Super + Shift + K** to end the conversation, or the service stop command above to shut Kestrel down and release the microphone.

## That's all

Say **that's all** on its own and finish the turn to end the conversation. After trimming surrounding whitespace and ignoring case, the recognized text must be exactly `that's all`, `that’s all`, `thats all` or `that is all`, optionally followed by one period or exclamation mark, with single spaces between words. Questions, quotes, repeated punctuation, internal newlines and longer sentences, such as `that's all I wanted to ask about the weather`, go to the brain unchanged. Recognition and turn detection can still mishear speech.

Ending this way matches pressing **Super + Shift + K** during a conversation: Kestrel says nothing, the phrase never reaches the brain, status shows inactive at once, and the panel, repeat state and conversation history are cleared as [Start and end a conversation](#start-and-end-a-conversation) describes. It does not wait for the engine and works when the engine is unavailable. Typed **that's all** ends the current conversation the same way but never starts voice; after typed-only use, voice stays inactive.

## Repeat that

Say **repeat that** on its own and finish the turn to hear the last spoken reply again, word for word, without another brain request. After trimming surrounding whitespace and ignoring case, the recognized text must be exactly `repeat that`, `repeat that.`, `repeat that!` or `repeat that?`. Quoted words, repeated punctuation, negation, longer requests and an internal newline go to the brain as ordinary conversation. Kestrel waits for the complete turn, not an individual speech segment. Recognition and turn detection can still mishear speech.

Repeat uses the latest spoken reply, including a local command confirmation, a local control failure notice or an engine-failure advisory. After an interrupted reply it repeats only the heard prefix; a local notice interrupted before reaching speech output cannot replace the earlier reply. Repeating again uses the same text. Repeat never redoes a local action, adds a brain-history turn or waits for an interrupted brain request to finish. It also works when the engine is unavailable.

With no earlier spoken reply, Kestrel says “I haven't said anything to repeat yet.” The one temporary last-reply value stays in the active conversation and is cleared on dismissal; each activation starts with no reply to repeat. Repeat state is not saved in local notes.

## What can I say?

Say **what can I say?** on its own and finish the turn to hear examples of the current local tools and their permission status. After trimming surrounding whitespace and ignoring case, the recognized text must be exactly `what can I say`, `what can I say?`, `what can I say.` or `what can I say!`. Quotes, negation, repeated punctuation, internal newlines and additional words go to ordinary conversation. Recognition and turn detection can still mishear speech.

Kestrel builds the answer locally from the tool registry on each request, in registry order. The answer says that Kestrel can talk with you, answer general knowledge questions and keep short notes between conversations, and it states the limits: no internet or live information and no view of the screen. Current examples are **mute**, **set the volume to thirty**, **pause music**, **next track**, **workspace three**, **open followed by an installed app's exact name** and **take a screenshot**. The app example describes the required name; use an installed app's exact visible name after **open**. Help describes registered commands without checking whether the desktop, app lookup or screenshot capture is currently available. Each tool's operating limits above still apply. It names the conversation controls **repeat that**, **stop**, **that's all** and **what can I say**, which are separate from the tools.

The current tools need no permission first, which the answer states. If a registered tool requires permission, help labels it **Permission required** and explains that it is not available by voice yet; there is no voice confirmation flow. Forbidden tools are omitted. If no tools can be offered, Kestrel explicitly says so and directs you to check its setup.

Help executes no tool and sends neither the request nor its reply to brain history. It works with an unavailable or still-preparing engine and does not wait for an interrupted brain request. **Repeat that** replays the spoken help, and speaking again interrupts it through the existing playback controls. These are speech-output behaviours; recognition and audible playback still depend on the local speech and audio setup.

## Native conversation panel and status indicator

The optional `local.kestrel` Omarchy plugin in `desktop/` displays Kestrel's status immediately before the clock in the center of the native bar. Install that directory through Omarchy's manual-plugin mechanism at `~/.config/omarchy/plugins/local.kestrel`, enable the plugin and place `local.kestrel` before `omarchy.clock` in `bar.layout.center`, preserving the clock anchor and unrelated settings. The voice service works without the plugin. Click the indicator to open or hide the conversation panel. Finalized user turns and Kestrel's speech-output text appear as they happen through the [private conversation feed](#private-conversation-feed). The transcript and composer use plain text, with no active links. Type below the conversation to send a turn into the same local conversation; Kestrel replies out loud. An empty transcript shows a hint for the current voice state, and unavailable, interrupted, incomplete and oversized states use the [design system's fixed messages](docs/DESIGN-SYSTEM.md#conversation-panel), independently of microphone status.

The panel header shows a short state word with no icon and the verified microphone use, such as `Listening · Mic in use`, `Not running · Mic released` or `Starting · Mic in use?`. Its full truthful microphone status remains available through the native tooltip and accessibility metadata. The header tooltip gives `Move: Super + left drag`. Kestrel bubbles sit left and owner bubbles right. Only spoken owner messages carry the small microphone identifying `Spoken message`; typed messages have no microphone caption. Short feeds rest at the bottom, and an empty transcript shows a centred hint for the current state. Only the live reply tail, which names its state in a small word, and the listening ghost can animate, following the native motion preference; history and new turns appear without entrance animation. Reply marks follow the accepted feed, while the header words and voice button follow the separate verified service status. Interrupted and failed empty replies retain their notices.

The voice button beside **Send message** starts or ends voice exactly like **Super + Shift + K**: it runs `control.py --toggle` from the installed plugin directory, so keep the plugin and shortcut control sources byte-identical to the active voice installation as described above. A filled microphone means verified voice on and names the button **End voice conversation**; an outline microphone means voice off and **Start voice conversation**. While status is starting, in trouble or unknown, and from a press until the next status update, a question badge marks it **Start or end voice conversation**. A press while the previous press's command is still running is ignored; once that command ends, the next press is sent as the shortcut would send it. Refusal, a missing service or an unconfirmed reply attempts the shortcut's native notification; the button never retries and never reads its state from the reply.

For keyboard access, first verify `Super + Shift + K` and `Super + F12` are unused in all compositor submaps. These are installation instructions, not a claim that either binding is installed or verified. The example below uses the default stable checkout. For a retained installation override, the unchanged root-main plugin and shortcut paths can stay in place after the interface-byte comparison above; otherwise use the effective voice checkout for both paths. Add these bindings to `~/.config/hypr/bindings.lua`, preserving existing bindings:

```lua
o.bind("SUPER + SHIFT + K", "Kestrel start or end conversation", "/usr/bin/python3 /home/zain/Projects/zaingulel/kestrel/desktop/control.py --toggle")
o.bind("SUPER + F12", "Kestrel panel", "omarchy-shell shell toggle local.kestrel")
```

`desktop/control.py --toggle` is the standard-library control command from the selected voice checkout. It contacts only the running service, makes one attempt and does not start the service. A successful `starting` or `inactive` acknowledgement describes the accepted requested state. Refusal, missing service or an ambiguous response fails with fixed advice and attempts a silent native notification; it never retries a toggle automatically.

Reload with `hyprctl reload` and require `hyprctl configerrors` to remain clean. `Super + F12` opens or hides the panel and opening focuses the composer at the draft end. `Enter` or `Return` sends a valid nonblank message; `Shift + Enter` inserts a newline. Input-method composition keeps Enter for committing text and prevents Send. The native field grows to five wrapped lines, then scrolls. `Tab` cycles composer, the voice button, enabled **Send message**, **Close panel**, the advisory text while it is too long to show whole, and transcript; `Shift + Tab` reverses, skipping disabled Send and a disabled voice button. `Enter` or `Space` activates the voice button or close. In the transcript or a scrolling advisory, arrows, `PageUp`, `PageDown`, `Home` and `End` scroll; the editor also sends `PageUp` and `PageDown` to the transcript. `Escape`, native window close and the close button hide the panel and return compositor focus to the prior window. Updates follow the bottom only while it is already being read; earlier text stays in place.

Sending stops the current reply and works while voice activation is inactive. A pending send shows **Sending…** and leaves editing available. Only confirmed acceptance clears an unchanged draft; edits made while pending survive. Refused, unavailable and unconfirmed delivery retain the draft with guidance. After unconfirmed delivery, check the conversation before sending again because an action may already have run. Reopening or reconnecting never resends. Hide/show preserves the in-memory draft, selection and editor scroll, while opening deliberately places the cursor at the end; plugin reload or destruction loses the draft. No draft is stored on disk.

The panel is 448 by 640 logical pixels. First opening uses the focused monitor's bottom-right work area, accounting for reserved space, outer gaps and native border. Move it with `Super + left drag`; hide/reopen, native close and shell/plugin reload retain its actual dragged position within the current compositor configuration lifetime. Changed monitors or work areas clamp an otherwise off-screen position. A deliberately partial off-screen drag is retained when the work area is unchanged. Compositor configuration reload resets placement to the focused monitor; cross-reload or restart position storage is not provided.

A scoped native rule and synchronous compositor callbacks place the window before visible composition on the verified Hyprland 0.56.2 build. A changed compositor, Quickshell or host version requires native placement verification again. If placement cannot be confirmed, the indicator actively shows **Panel position could not be confirmed. Try closing and reopening it.** in the native tooltip, even when the panel remains hidden. If the initial configuration check finds errors, it shows **Hyprland has configuration errors. Run hyprctl configerrors, fix the errors, then reopen the panel.** The panel stays hidden until placement and clean configuration are confirmed. The same advisory appears in the panel and accessible button name; it does not change microphone status. Cleanup failures preserve the original advisory, and a confirmed opening clears it. Native errors and window metadata are not displayed.

The current-state indicator distinguishes starting, inactive, active idle, listening, thinking, speaking, trouble, not running and status unavailable by shape. The exact shapes, words and accessibility meaning live in the [design system](docs/DESIGN-SYSTEM.md#the-three-marks). Colours and tooltip typography follow the native host's reactive palette, including theme changes. Listening, thinking and speaking move only when a successful, fresh Hyprland animation-preference query explicitly enables animations; unknown or reduced-motion preferences use the still shapes.

Kestrel writes a private, atomic status snapshot at `$XDG_RUNTIME_DIR/kestrel/indicator.json`. It contains only fixed status, process identities and freshness metadata, never audio, transcripts or conversation history. In trouble, the fixed status names one verified cause from a closed list, or none; failure text never enters the snapshot. One plugin service shares a bounded status-only watcher across monitors. Invalid data, a dead watcher or three seconds of silence displays **Status unavailable. Microphone use unknown.** Missing status never establishes microphone release.

**Starting. Microphone may be in use.** is the tooltip and accessible status until input is ready. **Voice off. Microphone in use. Press Super + Shift + K to start.** means ordinary speech recognition is inactive, with warm resources retained. Explicit typed requests and their playback leave that microphone status inactive. While inactive, active idle, listening, thinking, speaking or in trouble, treat the microphone as in use. In trouble, the tooltip and panel name the cause and the next step, or say the cause is unknown, as set out in the [trouble advisories](docs/DESIGN-SYSTEM.md#trouble-advisories). **Not running. Microphone released by Kestrel.** requires an orderly cleanup receipt, exit of its publisher and recorded audio owners, and a fresh bounded check for other Kestrel microphone owners, including another checkout. If that check cannot establish release, status stays unavailable. A newly installed indicator can therefore show unavailable until a verified orderly stop. This is evidence about Kestrel at the observation time, not other applications or future microphone access.

## Private conversation feed

The running voice service keeps a temporary conversation feed in memory. It includes finalized user turns and Kestrel's speech-output text, including local help, repeat and failure replies. Each whole speech chunk appears when its first nonempty audio buffer successfully reaches output, while Kestrel is speaking. Future chunks stay hidden until their output starts. This is an output-buffer observation, not word alignment or sample-accurate physical playback. A chunk that has started remains visible in full if playback is interrupted or fails. A reply with a silent or incompletely delivered segment uses the existing incomplete-reply warning, even when other segments were delivered. An attempt with no delivered audio has an empty interrupted or failed row. If a native audio context times out during synthesis, playback from its replacement context does not resume panel display. This panel accounting does not change repeat or conversation-history behaviour. Local command confirmations appear like other local replies; silent successful commands add no reply. Warmup and engine preparation never appear in the feed. Dismissal clears the feed; every activation starts an empty conversation with a new feed session identity.

The native reader is `/usr/bin/python3 ~/.config/omarchy/plugins/local.kestrel/conversation.py --watch`. It accepts no conversation arguments or input commands. Its standard output carries newline-delimited JSON (JavaScript Object Notation) snapshots with exactly `version: 2`, an opaque `session` string and `turns`. Each turn contains `speaker` (`you` or `kestrel`), `text` and `state` (`complete`, `thinking`, `speaking`, `interrupted` or `failed`). User turns also require `source` (`typed` or `spoken`); assistant turns have no source field. Only spoken user turns carry the microphone provenance caption. Missing or invalid provenance refuses the snapshot. Heartbeats contain only `alive` with the current session. A disconnect or invalid record clears stale text through the fixed record `{"unavailable":"Conversation unavailable. Reopen the panel."}`. A snapshot larger than 1 MiB produces only `{"unavailable":"Conversation is too large to display. Restart Kestrel to begin a new conversation."}` and retains that refusal while connected, without truncating the history into an apparently complete result.

The channel is a read-only abstract Unix socket named `\0kestrel.conversation.<uid>.<digest>`, where `\0` denotes the abstract namespace, `uid` is the user identifier and `digest` is the full SHA-256 hexadecimal digest of the UTF-8 bytes of `XDG_RUNTIME_DIR`. That variable must be an absolute path without control characters, at most 4096 bytes. Both peers check the kernel's `SO_PEERCRED` user identifier before transferring transcript data. Other processes running as the same account can read this channel; abstract sockets have no filesystem permission barrier. Only one reader is accepted. Incoming writes, invalid peers and blocked readers are disconnected; connection, output drainage and writer closure each have a one-second bound. The reader clears unavailable data and reconnects, with no prior-session text retained.

This feed writes no transcript files, status fields, notifications, arguments, environment values or diagnostic logs. Its reader emits only the snapshots and fixed unavailable records above. Application logs, temporary provider diagnostics and retained local traces are described in [Privacy and runtime boundary](#privacy-and-runtime-boundary).

## Echo removal

Kestrel takes its own voice out of what the microphone hears, so it works on open speakers. Starting Kestrel also starts a PipeWire process from `echo-removal.conf`. It loads PipeWire's echo-cancel module, which uses the WebRTC canceller, reads the default microphone and the sound sent to the default output, and offers the result as a microphone named **Kestrel microphone (echo removed)**, `kestrel-microphone` to PipeWire. It removes everything played on the default output, not only Kestrel's voice, and follows that output when it changes, for example from the speakers to headphones. The module also applies its standard high-pass filter and noise suppression. Kestrel changes no system default and writes no PipeWire configuration, and the Kestrel microphone exists only while Kestrel runs.

While Kestrel runs, that process can keep the laptop's microphone in use, including during startup, as [Privacy and runtime boundary](#privacy-and-runtime-boundary) says. Stop Kestrel to release it.

Kestrel verifies that its echo-removal process owns the unique microphone source, then targets that source's serial with its own recorder. It verifies the recorder's ownership and its active link from that exact source, rejecting any extra incoming source. Each conversation's capture cannot fall back to a raw microphone, move to another source or reconnect. Kestrel discards input until capture is verified and the conversation input is ready; it never replays startup audio.

Missing or unverified capture refuses readiness within a ten-second allowance. End of input, a truncated frame, a read failure or a five-second input stall ends the service with `Laptop microphone capture failed. Restart Kestrel.` Playback failure similarly ends the service with `Laptop audio playback failed. Restart Kestrel.` An unexpected echo-process exit stops Kestrel. Audio children are killed and reaped on shutdown, and are bound to die if Kestrel dies. Restart Kestrel after fixing the audio system; it never silently opens a replacement raw capture.

Echo removal needs a spoken check if the log shows `broadcasting interruption` straight after `Bot started speaking`, followed by a transcript of Kestrel's own words. Its voice is still reaching the microphone. Check that playback uses the default output and that the Kestrel microphone appears under Sources in `wpctl status` while Kestrel runs.

After a change to the audio system, the volume or the devices, run the spoken check on open speakers at normal volume: speak ten turns, staying silent until each reply ends, then interrupt two replies by speaking. It passes when no reply is cut off by Kestrel's own voice, the log holds no transcript of Kestrel's own words, and both interruptions stop the reply.

## Development workflow

[AGENTS.md](AGENTS.md) defines the repository contract. The [local profile](.agents/REPOSITORY.md) records repository conventions; [docs/README.md](docs/README.md) indexes the standards and tracker manual. Factory adoption preserves this conversation prototype. Product discovery and drilling with the owner precede further product implementation.

Follow the [testing strategy](docs/TESTING-STRATEGY.md#6-local-suites) for focused evidence and the full before-push checks, including native Ruff without changing the model environments.

The git guard and the other runtime hooks run only in a runtime that has trusted this repository's hook files, and only once those files are on `main` in the root checkout. An installed hook is not proof that it fires: the proof is a live probe in each runtime, in which a command the guard refuses, such as `git commit --no-verify --dry-run`, comes back blocked. Repeat the probe after a release install or update changes a hook file or a runtime's hook configuration.

## Privacy and runtime boundary

Microphone recognition and voice generation run locally on the laptop. Conversation transcripts and system context stay on the laptop and are sent to the local Bonsai server at `http://127.0.0.1:8080/v1`. Bonsai listens on loopback at `127.0.0.1:8080` and answers nothing but its `/health` readiness check without Kestrel's private brain key; processes running as this account can read the key, while other accounts and web pages cannot use the brain. Kestrel sends the key to whatever process holds that address, so recreate the key after any other program has held it. When the brain is available, Kestrel starts a preparation request to Bonsai with the fixed public text `Hello.`. Its reply is discarded, and neither preparation message enters caller conversation history. The enabled voice service starts at graphical login after reboot, starts inactive and can use the microphone during startup and inactivity through echo removal. Ordinary microphone recognition and spoken caller transcripts are admitted only while voice is active. Explicitly accepted typed requests can use the shared conversation, exact local commands and spoken replies while voice stays inactive; typing does not activate microphone recognition. Same-account processes can submit bounded typed text through the authenticated local control socket. It captures only from its verified owned echo-removed microphone and refuses unverified capture without falling back to a raw microphone. Kestrel's desktop tools are local mute and exact volume setting of the selected audio output, media pause and next track, numbered workspace focus, saving a native screenshot, and launching a uniquely matched visible installed app by name. App lookup and launch use the same captured local search paths and desktop selectors. An accepted launch request does not prove a window opened. Launched apps keep their normal permissions and behaviour, including any network access or side effects. Kestrel does not read, copy or send screenshot content. The brain can invoke the native local memory tool and the seven desktop tools described above, including app launching and screenshot saving, through shared validation, permission checks and observed results. The brain chooses these calls itself from any accepted spoken or typed turn, without per-call approval. A brain screenshot result carries only confirmed, attempted and a fixed reason, never its path or content. It cannot invoke other desktop tools. Audio failure notifications contain fixed status text, never conversation text. Kestrel has no browser research or reusable conversation archive. Automatic notes may be added, changed or removed by the native memory tool without per-write approval. Desktop file deletion, sending messages, publishing and arbitrary command execution are not available through Kestrel.

Outside text is text that reaches the brain through a tool result or a feature input instead of the caller's own speech or typing. Kestrel marks its own observed desktop results, including the records it replays into later turns; any tool result or record without that mark is outside text. Kestrel's fixed instructions, the note snapshot loaded at conversation start and the native memory tool's own results are not outside text. Once outside text enters a conversation, the brain can still read and answer and can still mute, set the volume, pause media, skip to the next track and focus a numbered workspace, but Kestrel refuses note additions, changes and removals, app launches, screenshots and any other brain tool for the rest of that conversation and says aloud why. Exact local commands still work, and a fresh conversation starts with every tool available again. No current Kestrel feature delivers outside text.

While prepared and inactive, the optional local wake detector receives temporary PCM (pulse-code modulation) audio only from the verified owned echo-removed microphone. The parent capture queue holds at most four 20-millisecond frames; the isolated detector keeps roughly ten seconds of recent waiting audio plus derived features in memory until the waiting interval closes. Waiting audio is never recorded or sent to ordinary recognition, caller transcripts, brain requests, notes or local actions. The worker emits only fixed detection/refusal bytes, and wake diagnostics contain no audio or score payloads. Typed requests suppress waiting capture until their matching output has finished. Activation reaps waiting capture before starting fresh conversation capture; stale detections and detections during an active conversation cannot toggle it. Wake assets and the private positive test recording remain ignored in `.runtime/wakeword/` and must never be published.

Runtime models, reference audio and logs remain ignored in `.runtime/` and must never be published. Transcript text may appear in the local voice and brain service logs, which are retained across restarts; the application does not save microphone recordings. The brain service log can record the last four characters of the brain key at startup, never the whole key.

Echo removal runs on the laptop in a PipeWire process that starts and stops with the voice service. While the voice service runs, that process can open the default microphone and read it at any time, including during startup: it does so whenever any program is sending sound to the default output or recording from the `kestrel-microphone` source. Treat the microphone as in use for as long as Kestrel runs. The process also reads the sound sent to the default output. It holds both in memory only, passes on the microphone signal with that sound removed, sends nothing over the network and saves nothing.

Hermes provider-error diagnostics can also contain transcript text in `sessions/request_dump_*.json` inside the service's owned temporary Hermes home under `.runtime/`. On an orderly shutdown, these local diagnostics are removed with that home after the worker exits; a hard-killed service or power loss can leave the folder behind. They can also hold the brain key masked to its first eight and last four characters, never the whole key. They are not reusable conversation storage. Do not publish them.

### Automatic local notes

Hermes can automatically maintain small facts and preferences through its sole native memory tool, including add, patch, remove and consolidation operations without a separate approval for each write. Memory availability does not prove the model chose to save any particular fact. A conversational claim that something was remembered is not storage evidence; inspect the files. Notes can contain personal information selected from an accepted turn. There is no background review, trace ingestion, session search or access to arbitrary files through this tool.

The runtime-created files are `.runtime/hermes-memory/MEMORY.md` for general notes and `.runtime/hermes-memory/USER.md` for user notes. The native budgets are 2,200 and 1,375 characters respectively, including separators in the native rendered entry text. Files use UTF-8, with an optional byte-order mark accepted on read; entries are separated by a line containing only `§`, the native delimiter `\n§\n`. Native parsing trims entries and drops empty ones. Each raw file is also bounded to 16 KiB. Missing note files mean empty notes.

The notes directory must be real, owned by the current account and mode `0700`. Existing note files and native `.lock` files must be regular, current-owner, mode `0600`, with one hard link and no symlinks. The parent `.runtime` must be real, current-owner and without group or world write access. Kestrel creates missing private storage, but refuses unreadable, malformed, over-budget or unsafe existing storage without changing its bytes or permissions. Check the fixed refusal in the service log or, after an ordinary turn, its spoken notes advisory and repair the reported condition yourself before restarting; refusal never authorises Kestrel to adopt or repair an unsafe path. Other processes running as your account can still read these notes.

Each activation requests a fresh note snapshot for its new native agent. Ordinary brain turns wait for that activation's successful native readiness; local controls and help can work while it is pending. Failure leaves the engine unavailable without a snapshot claim or retry. Caller history, repeat and panel state start empty. An already-accepted turn can finish a note write while dismissal drains it, before the next snapshot is created. Preparation has no note access. The temporary Hermes home links only its native notes directory to this fixed store; orderly cleanup removes the temporary link and home, preserving the notes.

Notes persist across dismissal and service restarts without automatic pruning. The native memory tool can revise or remove entries during accepted turns; you can also inspect, edit or delete the files yourself. To inspect or change them when ready, dismiss an active conversation with **Super + Shift + K**, then stop the voice service before using ordinary local file operations. These commands are operator instructions; inspect the effective installation above and run them from its voice checkout only when you intend to stop the service:

```sh
cd -- "$(systemctl --user show kestrel-voice.service -p WorkingDirectory --value)"
systemctl --user stop kestrel-voice.service
```

For note files that exist, inspect their ownership, modes and content before editing. For example:

```sh
stat .runtime/hermes-memory .runtime/hermes-memory/MEMORY.md .runtime/hermes-memory/USER.md
cat .runtime/hermes-memory/MEMORY.md .runtime/hermes-memory/USER.md
vi .runtime/hermes-memory/MEMORY.md .runtime/hermes-memory/USER.md
```

Use your usual local editor in place of `vi` if needed. Preserve the native format, character budgets, directory mode `0700` and file mode `0600`; an editor that replaces a file must preserve those properties. Do not follow or edit a refused symlink or unexpected hard link. To clear notes instead, inspect the exact files first and remove only the chosen note file, for example `rm -i .runtime/hermes-memory/MEMORY.md` or `rm -i .runtime/hermes-memory/USER.md`. Missing files are valid empty notes; leave native lock files alone. Restart later with `systemctl --user start kestrel-voice.service`, then summon a fresh conversation to load the changed snapshot. No persistent broad Hermes home or Hermes command-line session is needed.

Editing or deleting notes does not rewrite retained diagnostic traces, service logs or temporary provider diagnostics. Those have separate retention and deletion rules below.

### Local conversation traces

Conversation traces stay on this laptop until you delete them; Kestrel never uploads them or uses them as later conversation memory.

Each Hermes worker creates a fresh `.runtime/hermes-traces/session-*/events.jsonl` in its checkout. These ignored native diagnostic records can contain full conversation payloads, system context, model reasoning, preparation turns, memory and desktop tool payloads, including calls, arguments and results, and generated text that was never heard. They are not audio recordings or an exact record of what was spoken. They survive worker shutdown and removal of its temporary Hermes home, including failed sessions. Kestrel never reads them back into the brain or prunes them automatically. Disk use grows until you remove them; never commit or publish them.

The trace root and each session directory belong to the current user with mode `0700`; each events file has mode `0600`. The trace root's parent must be a real directory owned by the current user without group or world write access. Kestrel refuses unsafe existing paths, symlinks and preexisting plugin-configuration entries without repairing or replacing them. Other processes running as your account can still read these files. This is application configuration isolation, not an operating-system sandbox.

Raw local diagnostic traces may include delivery headers and remain subject to the same retention rules. These traces are separate from caller conversation history, which holds ordinary conversation text and the current conversation's desktop tool calls, arguments and observed results. Those records can reach later brain requests after interruption and belong to the current conversation. Persistent notes and retained traces keep their separate rules; Kestrel has no reusable conversation archive.

Kestrel creates its own private Relay configuration, disables built-in file, stream and OpenTelemetry exporters, and registers one native local file exporter. A `.env` entry inside the pinned Hermes source or `/etc/nemo-relay/plugins.toml` prevents startup before engine import. Keep environment files outside the pinned source, and use an environment without that system plugin file. User plugin configuration and inherited proxy or exporter settings are excluded.

Tracing must start before the worker reports ready. A private runtime-home refusal requires checking that home's ownership and permissions before restarting Kestrel. Use the reported service-log cause of a trace-startup refusal to check free space, storage permissions or Relay configuration as indicated. Engine import and construction failures report their original cause; use that cause to repair the installed runtime rather than assuming a permissions problem. A trace write or flush failure stops further turns and reports failure instead of successful completion; check free disk space and runtime permissions, then restart Kestrel. An engine-close failure reports that Hermes could not close cleanly and requires restarting Kestrel. Cleanup API failures propagated to Kestrel are reported with their cause in the service log and make the worker exit unsuccessfully; remaining cleanup steps still run. Hermes can suppress errors while closing its own tracing scopes, so even an orderly shutdown may leave incomplete final scope markers. Completed turns are flushed before their completion event; this is not a power-loss durability guarantee. Process termination can interrupt final lifecycle cleanup and leave an incomplete tail.

To remove the retained diagnostics, stop Kestrel first, then manually delete only `.runtime/hermes-traces/` in the checkout you ran. The next worker creates a fresh private trace root. Removing that directory does not remove the separate service logs or temporary provider diagnostics described above.
