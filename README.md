# kestrel
A local conversation prototype for Omarchy, with speech and the Bonsai brain on the laptop.

Bonsai 2 9B runs through the pinned Prism CUDA 12.8 server on the NVIDIA RTX 5080 laptop, with a 64,000-token context and F16 (16-bit floating-point) key and value caches. Hermes uses model alias `bonsai-2-9b` at `http://127.0.0.1:8080/v1`. No Ally connection is needed.

The laptop's local models use the NVIDIA RTX 5080:

| Component | Model directory | Runtime |
| --- | --- | --- |
| Bonsai 2 9B, conversation | `.runtime/models/bonsai-2-9b/Ternary-Bonsai-2-9B-PQ2_0.gguf` | `.runtime/tools/bonsai-prism-b10777-e3de715/cuda-12.8/llama-prism-b10777-e3de715/llama-server` |
| [Nemotron Speech Streaming English 0.6B](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b), speech to text | `.runtime/models/nemotron` | `.runtime/asr-venv` |
| [VoxCPM2](https://github.com/OpenBMB/VoxCPM), text to speech | `.runtime/models/voxcpm2` | `.runtime/voice-venv` |

Both speech environments use project-local Python 3.12 and CUDA-enabled PyTorch 2.11. Recognition uses Transformers 5.19, which supports Nemotron's streaming model. Voice generation uses Transformers 4.57 in a separate environment to keep its dependencies independent. Model revisions are recorded in `.runtime/models/manifest.json`; installed package versions are in `.runtime/asr-installed.txt` and `.runtime/voice-installed.txt`. Runtime files are excluded from Git.

Conversation runs through a direct Hermes Agent 0.19.0 child process, started by `bot.py` through `hermes_worker.py`. It requires the installed interpreter at `/home/zain/.local/share/mise/installs/pipx-hermes-agent/0.19.0/hermes-agent/bin/python`; a missing interpreter or different Hermes version is refused explicitly. Hermes connects to the local Bonsai endpoint above. The engine enables no tools, including the terminal, and has no fallback provider. Kestrel handles [local mute](#local-mute), [local volume](#local-volume), [media pause and next track](#media-pause-and-next-track), [numbered workspace focus](#numbered-workspace-focus), [stop or cancel](#stop-or-cancel) and [repeat that](#repeat-that) before the engine; the brain cannot invoke local actions.

Each service lifetime gets a new temporary Hermes home under ignored `.runtime/`, with isolated configuration. The child does not load the normal Hermes configuration, memories or context files, and does not inherit provider credentials or proxy settings. Conversation history comes from Pipecat's committed context; reusable conversation storage, session snapshots and memory are disabled. Shutdown terminates the child, waits for it to exit and removes only that service's temporary home. Restarting Kestrel starts with empty conversation history.

Run service installation commands from the stable checkout at `~/Projects/zaingulel/kestrel`. The tracked user units use that path, so do not install them from a trial checkout. They require the existing ignored model assets and environments; the launchers do not download or repair them. Inspect and save any existing installed unit definitions before replacing them. Stop any existing transient Kestrel service and brain before installing these units.

```sh
install -Dm644 systemd/kestrel-brain.service ~/.config/systemd/user/kestrel-brain.service
install -Dm644 systemd/kestrel-voice.service ~/.config/systemd/user/kestrel-voice.service
systemctl --user daemon-reload
systemctl --user enable --now kestrel-voice.service
```

The enabled voice service starts at graphical login after reboot. This also starts microphone use, including during speech startup. It first starts Bonsai and waits for a successful HTTP (Hypertext Transfer Protocol) 200 response from `/health`, bounded by the brain's 130-second startup allowance. The readiness command ignores curl configuration and proxies, discards the response body and refuses redirects. It observes server readiness, not model identity. If brain startup fails, voice can still start for local controls and reports the brain failure on an ordinary turn. Neither service restarts automatically.

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

Both brain commands take no options. If brain startup fails, `./run-voice.sh` alone still provides local controls and the spoken brain-failure advice. Stop foreground voice and brain with `Ctrl+C` in their respective terminals.

Kestrel captures and plays audio directly on the laptop through PipeWire. No browser is needed. Wait for the ready message before speaking, then speak naturally, pause for a reply, and speak again to interrupt it. Startup verifies Kestrel's own echo-removed microphone before loading and preparing the speech models. Stop the service, or press `Ctrl+C` in a foreground terminal, to release the microphone, models and conversation. To restart after a failure, use `systemctl --user restart kestrel-voice.service`.

One conversation lasts for as long as the service runs. Quiet periods do not end the conversation; Kestrel stays ready until the service stops. VoxCPM2 loads and warms once in that lifetime. Shutdown releases its graphics memory and clears the conversation; the next launch loads it again. VoxType can stay running.

Speech goes from the microphone through owned echo-removed capture to local Nemotron recognition. Completed exact mute, volume, media, workspace, stop/cancel and repeat commands are handled locally and stay out of later brain-request history. Other turns go through the local Hermes worker to local Bonsai, then through local VoxCPM2 and to native playback on the default output. Recognition processes speech segments after detected pauses; Kestrel does not provide word-by-word partial transcripts. Pipecat's local Silero speech detector and Smart Turn model control turn-taking. Smart Turn uses a 0.6-second silence fallback when it is uncertain, so Kestrel may reply during a thinking pause. It can still recognize a completed turn sooner. VoxCPM2 receives completed sentences and streams their audio. The brain request disables reasoning output with `reasoning_effort: "none"` for responsive conversation.

Hermes can continue a long reply with successive output caps of 180, 360, 720 and 1,440 tokens, a total budget of up to 2,700 tokens across four calls. If it still cannot finish, Kestrel speaks an incomplete-reply warning and requires restarting Kestrel. This output budget is separate from the 64,000-token context capacity, which holds conversation history, instructions and replies. Long conversations can eventually fill that context.

Speaking over a reply stops its speech and playback. Hermes continues the current brain request until it finishes; the next ordinary conversation turn waits for that work to drain, which can add a delay. Local controls and repeat do not wait for the interrupted brain request. Exact stop/cancel ends the reply without submitting another brain request; it leaves that native work draining. Unheard text from the interrupted reply is discarded, so only the heard prefix enters the next turn's context. Replacement requests stay separate even when no sentence of the interrupted reply has entered conversation history, and earlier user context remains available. Shutdown ends the worker rather than draining another conversational turn.

If the engine is unavailable, Kestrel explains that after an ordinary conversation turn; exact local controls and repeat still take the local route. Brain failures, incomplete replies and invalid worker responses also produce a spoken explanation, with the diagnostic reason in the service log. A partial reply already spoken is not treated as a complete answer. Kestrel does not automatically submit a failed user turn again or restart a broken engine session; follow the spoken advice and consult the diagnostic reason in the service log before restarting Kestrel. Hermes may retry transient provider errors within a turn. Engine startup and each turn, including native retries or an interrupted turn draining, are bounded at 45 seconds.

Kestrel selects one local voice preset when it starts. The default is `irish-female`; `british-male` is the named British alternative. The original voice remains available as `kestrel` for rollback. To select the British voice in a foreground terminal, run:

```sh
KESTREL_VOICE=british-male ./run-voice.sh
```

For the user service, run `systemctl --user edit kestrel-voice.service` and set the voice in its override:

```ini
[Service]
Environment=KESTREL_VOICE=british-male
```

Then run `systemctl --user daemon-reload` and `systemctl --user restart kestrel-voice.service`. Use `irish-female` in that override to restore the default, or `kestrel` for the original voice. The foreground equivalent for the original voice is `KESTREL_VOICE=kestrel ./run-voice.sh`.

Presets are local files in the ignored `.runtime/voices/` directory. Each preset named `<name>` has a matching `<name>.wav` and `<name>.txt` file. Names contain 1 to 64 lowercase letters, digits, underscores or hyphens, and begin with a letter or digit. The transcript is the exact spoken reference in UTF-8, must not be blank, and is limited to 4 KiB; ASCII control characters are not allowed except tab, carriage return and line feed. The WAV must be nonempty, mono 48 kHz PCM16, no longer than ten seconds and no larger than 1 MiB. To add a preset, place both correctly named files in that directory and put the exact spoken words in the text file; no code change is needed. Keep these local voice files out of commits and publication.

Kestrel selects and validates the pair once during startup, before loading the speech models. A missing or invalid selection or asset stops startup with an explanation rather than switching to another voice. Stop and restart Kestrel before changing files for the selected preset. The reference uses [VoxCPM2's audio and transcript cloning mode](https://github.com/OpenBMB/VoxCPM#-ultimate-cloning), keeping the same speaker reference across sentences and replies.

This prototype supports conversation, local mute and exact volume setting of the selected audio output, media pause and next track, numbered workspace focus, stopping a reply, and replay of the last spoken reply. It has no browser research or persistent conversation memory. Transcript text can appear in the service's debug output; microphone recordings are not saved by the application. The Bonsai server listens only on unauthenticated local loopback at `127.0.0.1:8080`.

Run the speech adapters, native Hermes boundary and whole-conversation tests:

```sh
.runtime/voice-venv/bin/python -m unittest discover -s tests -v
```

Native audio uses the installed PipeWire and WirePlumber services, `pw-cat`, `pw-dump`, `stdbuf` and `setpriv`; PyAudio is unnecessary. Model files are loaded locally without automatic downloads. The voice environment also contains `voxcpm==2.0.3` and `pipecat-ai[silero,openai]==1.12.0`. The adapters follow [Pipecat's speech input and turn detection conventions](https://docs.pipecat.ai/pipecat/learn/speech-input).

Generate a standalone voice sample using the installed VoxCPM command:

```sh
HF_HOME="$PWD/.runtime/cache/huggingface" \
MPLCONFIGDIR="$PWD/.runtime/cache/matplotlib" \
.runtime/voice-venv/bin/voxcpm design \
  --model-path .runtime/models/voxcpm2 \
  --device cuda --local-files-only --no-denoiser --no-optimize \
  --text "Hello. Speech recognition and voice generation are now running locally." \
  --output .runtime/samples/voice-demo.wav
```

Use `.runtime/asr-venv/bin/python` with NVIDIA's documented Transformers interface to load the local recognition model. Specify `local_files_only=True` and move the model to `cuda` to run without network downloads or a CPU fallback.

Recorded-sample recognition has no verified runnable recipe here; do not count it as current evidence. Controlled-provider tests do not prove live Bonsai answers or actual login execution after reboot. Live recognition accuracy, physical playback and microphone-to-speaker latency require a spoken check. The service logs a numeric pipeline-response duration in seconds for each reply, measured by Pipecat from detected user silence to its bot-speaking frame. That frame is a pipeline proxy, not physical speaker onset; audible responsiveness still needs a spoken check.

## Local mute

Say **mute** on its own and finish the turn. After trimming surrounding whitespace and ignoring case, the recognized text must be exactly `mute`, `mute.` or `mute!`. `mute?`, quoted words, repeated punctuation, negation and longer requests go to the brain as ordinary conversation. Kestrel waits for the complete turn, not an individual speech segment. Recognition and turn detection can still mishear speech.

Kestrel uses Omarchy to resolve the selected audio output, including its physical output when digital signal processing routes sound through another sink. It explicitly sets that captured output muted at most once, never toggles it, and confirms success only after reading back mute status and checking that the selected output has not changed. Already muted is a silent no-op. Successful mute has no spoken acknowledgement or notification. The readback is a snapshot; other software can change the output afterwards.

Unmute manually through the desktop audio control. If digital signal processing routing changed, use the audio panel to select and unmute the affected output. The mute command never unmutes or retries an attempted mute. A new explicit mute turn is a new request.

If mute cannot be confirmed, Kestrel attempts to say **I couldn't confirm mute. Check the audio control. I won't retry.** and attempts a native desktop notification titled **Mute could not be confirmed**, with **Check the audio control. Kestrel will not retry.** The notification is transient and requests silent delivery. It contains fixed status text, never conversation text. Ordinary desktop notification settings apply; notification service failure is logged as unavailable. Muted speakers may hide the spoken error, and the desktop may suppress the notification, so check the audio control rather than treating silence as confirmation.

Speaking again can interrupt the failure speech while the attempted mute, readback and failure-notification attempt finish. Kestrel does not replay the request or speak a stale failure over the newer turn; if speech is interrupted and the notification is unavailable, only the local diagnostic may remain. Shutdown cancels and joins outstanding local work without undoing an attempted mute.

Startup prepares local speech and the engine concurrently. The engine receives one fixed public greeting whose reply is discarded. Once local speech is ready, the conversation pipeline starts and local controls and repeat work even while engine preparation is pending. The first ordinary turn waits for any remaining preparation, or receives the existing failure advisory if preparation fails. Local controls add no engine tools, browser research or persistent conversation memory.

## Local volume

Say **set the volume to 30** on its own and finish the turn to set the selected output to 30% and unmute it. Use `volume <level> percent` or `volume <level>%`, or the setter forms `set volume [to] <level>` and `set the volume [to] <level>`, where `to` is optional and the level is a whole percentage from 0 through 100. A `percent` or `%` suffix is required after `volume <level>` and optional after the setter forms. Units work with digits or words, including `volume fifty%`; `%` can have one preceding space. Bare `volume two` goes to conversation. One `please` is allowed at either end, never both, as in `please set volume to 100`. Levels can be ASCII digits (`0` through `9`) without leading zeros or English names: zero through nineteen, a multiple of ten from twenty through ninety optionally followed by one through nine separated by a space or hyphen, and one hundred. Case and surrounding whitespace are ignored; internal words use single spaces, with at most one final period or exclamation mark. Questions, quotes, negation, decimals, signed or out-of-range levels, repeated punctuation, internal newlines and longer requests go to the brain unchanged. Kestrel waits for the complete turn; recognition can still mishear speech.

Kestrel captures the selected output using Omarchy's resolver, including the physical output behind digital signal processing, then writes the exact percentage to that output at most once. It verifies every channel at the requested level before clearing mute, including at zero. It confirms success only after checking that the selected output and channel names are unchanged, every channel has the requested level and mute is off. Already exact and unmuted is a verified silent no-op. Successful volume setting has no spoken acknowledgement or notification. Readback is a snapshot; other software can change the output afterwards.

If volume cannot be confirmed, Kestrel attempts to say **I couldn't confirm volume. Check the audio control. I won't retry.** and attempts a native desktop notification titled **Volume could not be confirmed**, with **Check the audio control. Kestrel will not retry.** It uses the same transient, silent, fixed-text pattern and delivery limitations as mute failure. If the volume write cannot be confirmed, Kestrel does not proceed to unmute. It never retries, undoes an attempted change or falls back to another output; a new explicit volume turn is a new request.

Speaking again can interrupt the failure speech while local verification and the notification attempt finish. Kestrel keeps the request out of brain history and suppresses stale failure speech over a newer turn. Shutdown cancels and joins outstanding local work without undoing an attempted change. Mute, volume, media and workspace actions run one at a time, in the order their spoken turns complete.

## Media pause and next track

Say **pause music** or **next track** on its own and finish the turn. These phrases, numbered workspace focus and stop/cancel ignore case and surrounding whitespace and allow one final period or exclamation mark. Questions, quotes, negation, repeated punctuation, internal newlines and longer requests go to the brain unchanged. Internal words use single spaces. Kestrel waits for the completed turn; recognition and turn detection can still mishear speech.

Kestrel uses Omarchy's native media pause or next action and reads its active-player status. With no selected player, or with a paused player, it takes no action and says **I couldn't find a playing media player.** This describes the managed player's observed playback; other PipeWire audio can still be audible, so it does not establish global silence. Next also refuses before acting if the player cannot advance or its title or identity is unavailable.

Each request sends the action at most once, then reads back state. Pause confirms only when the same nonempty reported player identity and desktop entry remain selected, track metadata is unchanged and playback is stopped. Next requires that same player information, playback still running, nonempty titles before and after, and a changed title, artist or album. Identical track metadata leaves advancement unconfirmed. These snapshots cannot prove the command caused a change or uniquely identify a player; missing or changed player information leaves the result unconfirmed.

Confirmed actions are silent. If pause cannot be confirmed, Kestrel attempts to say **I couldn't confirm pause. Check the media player. I won't retry.** For next it says **I couldn't confirm next track. Check the media player. I won't retry.** Unavailable commands, invalid status and unhandled actions use these fixed advisories, without speaking command output. Each operation has a five-second deadline, with at most three readback observations for delayed desktop updates. It never retries or undoes the action; a new explicit turn is a new request. Media and workspace controls require access to the running desktop session.

Media and workspace failures use speech rather than the mute/volume desktop notification. Their requests and failure speech stay out of brain history. Speaking again interrupts the speech without undoing an attempted action; Kestrel suppresses stale failure speech over the newer turn. Shutdown cancels and joins outstanding local work.

## Numbered workspace focus

Say **workspace three** or **workspace 11** on its own and finish the turn, using the same [matching rules](#media-pause-and-next-track). ASCII digits without leading zeros cover 1 through 2147483647. English names use the [volume word forms](#local-volume) from one through one hundred, including `twenty one` and `twenty-one`; larger values require digits. Zero, signed numbers, decimals and out-of-range values go to the brain unchanged.

Kestrel uses the same Omarchy focus operation as the default numbered workspace keys. It reads the active workspace, sends at most one focus request, and confirms only after observing the requested numeric workspace identifier. Already on that workspace is a verified silent no-op. Successful focus is silent. The readback is a snapshot; another action can change focus afterwards.

If focus cannot be confirmed, Kestrel attempts to say **I couldn't confirm workspace 3. Check the desktop. I won't retry.**, using the requested number. The same five-second deadline and at most three readback observations apply. It never retries or undoes an attempted focus change.

## Stop or cancel

Say **stop** or **cancel** on its own and finish the turn, using the same [matching rules](#media-pause-and-next-track). Speaking over a reply starts the existing native interruption and discards queued playback. The completed stop/cancel turn is consumed locally with no acknowledgement or new brain request. Only the prefix already heard remains in conversation history; the unheard tail is discarded.

The current brain request continues draining under its existing deadline, and the next ordinary conversation turn waits for it. Stop/cancel returns without waiting for that request or pending desktop actions. It leaves attempted desktop actions running and keeps the service and microphone active. Idle stop/cancel is silent, including when the engine is unavailable. Use the service stop command above to shut Kestrel down.

## Repeat that

Say **repeat that** on its own and finish the turn to hear the last spoken reply again, word for word, without another brain request. After trimming surrounding whitespace and ignoring case, the recognized text must be exactly `repeat that`, `repeat that.`, `repeat that!` or `repeat that?`. Quoted words, repeated punctuation, negation, longer requests and an internal newline go to the brain as ordinary conversation. Kestrel waits for the complete turn, not an individual speech segment. Recognition and turn detection can still mishear speech.

Repeat uses the latest spoken reply, including a local control failure notice or engine-failure advisory. After an interrupted reply it repeats only the heard prefix; a local notice interrupted before reaching speech output cannot replace the earlier reply. Repeating again uses the same text. Repeat never redoes a local action, adds a brain-history turn or waits for an interrupted brain request to finish. It also works when the engine is unavailable.

With no earlier spoken reply, Kestrel says “I haven't said anything to repeat yet.” The one temporary last-reply value stays in the running conversation and is cleared on shutdown; a fresh service starts with no reply to repeat. It is not saved as persistent conversation memory.

## Echo removal

Kestrel takes its own voice out of what the microphone hears, so it works on open speakers. Starting Kestrel also starts a PipeWire process from `echo-removal.conf`. It loads PipeWire's echo-cancel module, which uses the WebRTC canceller, reads the default microphone and the sound sent to the default output, and offers the result as a microphone named **Kestrel microphone (echo removed)**, `kestrel-microphone` to PipeWire. It removes everything played on the default output, not only Kestrel's voice, and follows that output when it changes, for example from the speakers to headphones. The module also applies its standard high-pass filter and noise suppression. Kestrel changes no system default and writes no PipeWire configuration, and the Kestrel microphone exists only while Kestrel runs.

While Kestrel runs, that process can keep the laptop's microphone in use, including during startup, as [Privacy and runtime boundary](#privacy-and-runtime-boundary) says. Stop Kestrel to release it.

Kestrel verifies that its echo-removal process owns the unique microphone source, then targets that source's serial with its own recorder. It verifies the recorder's ownership and its active link from that exact source, rejecting any extra incoming source. Capture cannot fall back to a raw microphone, move to another source or reconnect. Kestrel discards input until capture is verified and the conversation input is ready; it never replays startup audio.

Missing or unverified capture refuses startup within a ten-second allowance. End of input, a truncated frame, a read failure or a five-second input stall ends the service with `Laptop microphone capture failed. Restart Kestrel.` Playback failure similarly ends the service with `Laptop audio playback failed. Restart Kestrel.` An unexpected echo-process exit stops Kestrel. Audio children are killed and reaped on shutdown, and are bound to die if Kestrel dies. Restart Kestrel after fixing the audio system; it never silently opens a replacement raw capture.

Echo removal needs a spoken check if the log shows `broadcasting interruption` straight after `Bot started speaking`, followed by a transcript of Kestrel's own words. Its voice is still reaching the microphone. Check that playback uses the default output and that the Kestrel microphone appears under Sources in `wpctl status` while Kestrel runs.

After a change to the audio system, the volume or the devices, run the spoken check on open speakers at normal volume: speak ten turns, staying silent until each reply ends, then interrupt two replies by speaking. It passes when no reply is cut off by Kestrel's own voice, the log holds no transcript of Kestrel's own words, and both interruptions stop the reply.

## Development workflow

[AGENTS.md](AGENTS.md) defines the repository contract. The [local profile](.agents/REPOSITORY.md) records repository conventions; [docs/README.md](docs/README.md) indexes the standards and tracker manual. Factory adoption preserves this conversation prototype. Product discovery and drilling with the owner precede further product implementation.

Follow the [testing strategy](docs/TESTING-STRATEGY.md#6-local-suites) for focused evidence and the full before-push checks, including native Ruff without changing the model environments.

The git guard and the other runtime hooks run only in a runtime that has trusted this repository's hook files, and only once those files are on `main` in the root checkout. An installed hook is not proof that it fires: the proof is a live probe in each runtime, in which a command the guard refuses, such as `git commit --no-verify --dry-run`, comes back blocked. Repeat the probe after a sync changes a hook file or a runtime's hook configuration.

## Privacy and runtime boundary

Microphone recognition and voice generation run locally on the laptop. Conversation transcripts and system context stay on the laptop and are sent to the local Bonsai server at `http://127.0.0.1:8080/v1`. Bonsai listens on unauthenticated loopback at `127.0.0.1:8080`; other local processes can reach it. On startup, Kestrel starts a preparation request to Bonsai with the fixed public text `Hello.`. Its reply is discarded, and neither preparation message enters caller conversation history. The enabled voice service starts at graphical login after reboot and can use the microphone during startup. It captures only from its verified owned echo-removed microphone and refuses unverified capture without falling back to a raw microphone. Kestrel's desktop tools are local mute and exact volume setting of the selected audio output, media pause and next track, and numbered workspace focus. The brain cannot invoke them or any other tool. Audio failure notifications contain fixed status text, never conversation text. Kestrel has no browser research or persistent conversation memory. Deleting, sending messages, publishing and arbitrary command execution are not available by voice.

Runtime models, reference audio and logs remain ignored in `.runtime/` and must never be published. Transcript text may appear in the local voice and brain service logs, which are retained across restarts; the application does not save microphone recordings.

Echo removal runs on the laptop in a PipeWire process that starts and stops with the voice service. While the voice service runs, that process can open the default microphone and read it at any time, including during startup: it does so whenever any program is sending sound to the default output or recording from the `kestrel-microphone` source. Treat the microphone as in use for as long as Kestrel runs. The process also reads the sound sent to the default output. It holds both in memory only, passes on the microphone signal with that sound removed, sends nothing over the network and saves nothing.

Hermes provider-error diagnostics can also contain transcript text in `sessions/request_dump_*.json` inside the service's owned temporary Hermes home under `.runtime/`. On an orderly shutdown, these local diagnostics are removed with that home after the worker exits; a hard-killed service or power loss can leave the folder behind. They are not reusable conversation storage. Do not publish them.
