# kestrel
A local conversation prototype for Omarchy, with speech on the laptop and Saluki on the Ally.

Saluki runs through LM Studio on the ROG Ally X with the Radeon RX 9060 XT. Its server is reachable at `http://192.168.0.150:1234`. The laptop connects to that server; it does not need another LM Studio installation for speech.

The laptop's local speech models use the NVIDIA RTX 5080:

| Component | Model directory | Python environment |
| --- | --- | --- |
| [Nemotron Speech Streaming English 0.6B](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b), speech to text | `.runtime/models/nemotron` | `.runtime/asr-venv` |
| [VoxCPM2](https://github.com/OpenBMB/VoxCPM), text to speech | `.runtime/models/voxcpm2` | `.runtime/voice-venv` |

Both environments use project-local Python 3.12 and CUDA-enabled PyTorch 2.11. Recognition uses Transformers 5.19, which supports Nemotron's streaming model. Voice generation uses Transformers 4.57 in a separate environment to keep its dependencies independent. Model revisions are recorded in `.runtime/models/manifest.json`; installed package versions are in `.runtime/asr-installed.txt` and `.runtime/voice-installed.txt`. Runtime files are excluded from Git.

Conversation runs through a direct Hermes Agent 0.19.0 child process, started by `bot.py` through `hermes_worker.py`. It requires the installed interpreter at `/home/zain/.local/share/mise/installs/pipx-hermes-agent/0.19.0/hermes-agent/bin/python`; a missing interpreter or different Hermes version is refused explicitly. Hermes connects to Saluki through the Ally endpoint above. The engine enables no tools, including the terminal, and has no fallback provider. Kestrel handles [local mute](#local-mute) and [repeat that](#repeat-that) before the engine; the brain cannot invoke local actions.

Each service lifetime gets a new temporary Hermes home under ignored `.runtime/`, with isolated configuration. The child does not load the normal Hermes configuration, memories or context files, and does not inherit provider credentials or proxy settings. Conversation history comes from Pipecat's committed context; reusable conversation storage, session snapshots and memory are disabled. Shutdown terminates the child, waits for it to exit and removes only that service's temporary home. Restarting Kestrel starts with empty conversation history.

Run commands from this directory. Start the conversation trial as a user service so it stays running independently of the launching terminal or chat command:

```sh
systemd-run --user --unit=kestrel-voice --collect --service-type=exec \
  --working-directory="$PWD" \
  --property="StandardOutput=append:$PWD/.runtime/voice-server.log" \
  --property=StandardError=inherit --property=TimeoutStopSec=15s --property=KillMode=mixed \
  "$PWD/run-voice.sh"
```

Check or stop the service with `systemctl --user status kestrel-voice` or `systemctl --user stop kestrel-voice`. Service output is in `.runtime/voice-server.log`. This temporary service does not start automatically after a reboot. To run in a foreground terminal instead, use:

```sh
./run-voice.sh
```

Kestrel captures and plays audio directly on the laptop through PipeWire. No browser is needed. Wait for the ready message before speaking, then speak naturally, pause for a reply, and speak again to interrupt it. Startup verifies Kestrel's own echo-removed microphone before loading and preparing the speech models. Stop the service, or press `Ctrl+C` in a foreground terminal, to release the microphone, models and conversation. To restart after a failure, launch it again with the command above.

One conversation lasts for as long as the service runs. Quiet periods do not end the conversation; Kestrel stays ready until you stop it. VoxCPM2 loads and warms once in that lifetime. Shutdown releases its graphics memory and clears the conversation; the next launch loads it again. VoxType can stay running.

Speech goes from the microphone through owned echo-removed capture to local Nemotron recognition. Completed exact mute and repeat commands are handled locally and stay out of later brain-request history. Other turns go through the local Hermes worker to Saluki on the Ally, then through local VoxCPM2 and to native playback on the default output. Recognition processes speech segments after detected pauses; this trial does not provide word-by-word partial transcripts. Pipecat's local Silero speech detector and Smart Turn model control turn-taking. Smart Turn uses a 0.6-second silence fallback when it is uncertain, so Kestrel may reply during a thinking pause. It can still recognize a completed turn sooner. VoxCPM2 receives completed sentences and streams their audio. The brain request disables reasoning output with `reasoning_effort: "none"` for responsive conversation.

Hermes can continue a long reply with successive output caps of 180, 360, 720 and 1,440 tokens, a total budget of up to 2,700 tokens across four calls. If it still cannot finish, Kestrel speaks an incomplete-reply warning and requires restarting Kestrel. This output budget is separate from the 64,000-token context capacity, which holds conversation history, instructions and replies. Long conversations can eventually fill that context.

Speaking over a reply stops its speech and playback. Hermes continues the current brain request until it finishes; the next ordinary conversation turn waits for that work to drain, which can add a delay. Local mute and repeat do not wait for the interrupted brain request. Unheard text from the interrupted reply is discarded, so only the heard prefix enters the next turn's context. Shutdown ends the worker rather than draining another conversational turn.

If the engine is unavailable, Kestrel explains that after an ordinary conversation turn; exact mute and repeat still take the local route. Brain failures, incomplete replies and invalid worker responses also produce a spoken explanation, with the diagnostic reason in the service log. A partial reply already spoken is not treated as a complete answer. Kestrel does not automatically submit a failed user turn again or restart a broken engine session; follow the spoken advice and consult the diagnostic reason in the service log before restarting Kestrel. Hermes may retry transient provider errors within a turn. Engine startup and each turn, including native retries or an interrupted turn draining, are bounded at 45 seconds.

Every sentence uses the same generated speaker reference at `.runtime/voices/kestrel.wav`, paired with its exact transcript in `speech.py`. This anchors speaker identity across sentences, replies and service restarts. Keep the reference fixed; replacing it changes Kestrel's voice. The reference uses [VoxCPM2's audio and transcript cloning mode](https://github.com/OpenBMB/VoxCPM#-ultimate-cloning). Startup preparation also reads this reference. It must be a complete, nonempty, mono 48 kHz WAV using 16-bit pulse-code modulation (PCM16), no longer than ten seconds; unsupported or truncated files prevent the conversation from starting.

This prototype supports conversation, local mute of the selected audio output and replay of the last spoken reply. It has no browser research or persistent conversation memory. Transcript text can appear in the service's debug output; microphone recordings are not saved by the application. Kestrel opens no listening network service.

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

Recorded-sample recognition and Saluki checks have no verified runnable recipe here; do not count them as current evidence. Live recognition accuracy, physical playback and microphone-to-speaker latency require a spoken check. The service logs a numeric pipeline-response duration in seconds for each reply, measured by Pipecat from detected user silence to its bot-speaking frame. That frame is a pipeline proxy, not physical speaker onset; audible responsiveness still needs a spoken check.

## Local mute

Say **mute** on its own and finish the turn. After trimming surrounding whitespace and ignoring case, the recognized text must be exactly `mute`, `mute.` or `mute!`. `mute?`, quoted words, repeated punctuation, negation and longer requests go to the brain as ordinary conversation. Kestrel waits for the complete turn, not an individual speech segment. Recognition and turn detection can still mishear speech.

Kestrel uses Omarchy to resolve the selected audio output, including its physical output when digital signal processing routes sound through another sink. It explicitly sets that captured output muted at most once, never toggles it, and confirms success only after reading back mute status and checking that the selected output has not changed. Already muted is a silent no-op. Successful mute has no spoken acknowledgement or notification. The readback is a snapshot; other software can change the output afterwards.

Unmute manually through the desktop audio control. If digital signal processing routing changed, use the audio panel to select and unmute the affected output. Kestrel never automatically unmutes or retries an attempted mute. A new explicit mute turn is a new request.

If mute cannot be confirmed, Kestrel attempts to say **I couldn't confirm mute. Check the audio control. I won't retry.** and attempts a native desktop notification titled **Mute could not be confirmed**, with **Check the audio control. Kestrel will not retry.** The notification is transient and requests silent delivery. It contains fixed status text, never conversation text. Ordinary desktop notification settings apply; notification service failure is logged as unavailable. Muted speakers may hide the spoken error, and the desktop may suppress the notification, so check the audio control rather than treating silence as confirmation.

Speaking again can interrupt the failure speech while the attempted mute, readback and failure-notification attempt finish. Kestrel does not replay the request or speak a stale failure over the newer turn; if speech is interrupted and the notification is unavailable, only the local diagnostic may remain. Shutdown cancels and joins outstanding local work without undoing an attempted mute.

Startup prepares local speech and the engine concurrently. The engine receives one fixed public greeting whose reply is discarded. Once local speech is ready, the conversation pipeline starts and local mute works even while engine preparation is pending. The first ordinary turn waits for any remaining preparation, or receives the existing failure advisory if preparation fails. Local mute adds no engine tools, browser research or persistent conversation memory.

## Repeat that

Say **repeat that** on its own and finish the turn to hear the last spoken reply again, word for word, without another brain request. After trimming surrounding whitespace and ignoring case, the recognized text must be exactly `repeat that`, `repeat that.`, `repeat that!` or `repeat that?`. Quoted words, repeated punctuation, negation, longer requests and an internal newline go to the brain as ordinary conversation. Kestrel waits for the complete turn, not an individual speech segment. Recognition and turn detection can still mishear speech.

Repeat uses the latest spoken reply, including a mute-failure notice or engine-failure advisory. After an interrupted reply it repeats only the heard prefix; a local notice interrupted before reaching speech output cannot replace the earlier reply. Repeating again uses the same text. Repeat never redoes a mute command, adds a brain-history turn or waits for an interrupted brain request to finish. It also works when the engine is unavailable.

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

Microphone recognition and voice generation run locally on the laptop. Conversation transcripts and system context are sent to Saluki through the Ally's LM Studio server at `http://192.168.0.150:1234/v1` over the local area network. On startup, Kestrel starts a preparation request to the Ally with the fixed public text `Hello.`. Its reply is discarded, and neither preparation message enters caller conversation history. Kestrel opens no listening network service. It captures only from its verified owned echo-removed microphone and refuses unverified capture without falling back to a raw microphone. Kestrel's only desktop tool is local mute of the selected audio output. The brain cannot invoke it or any other tool. Mute failure notifications contain fixed status text, never conversation text. Kestrel has no browser research or persistent conversation memory and adds no network destination. Deleting, sending messages, publishing and arbitrary command execution are not available by voice.

Runtime models, reference audio and logs remain ignored in `.runtime/` and must never be published. Transcript text may appear in the local service's debug output; the application does not save microphone recordings.

Echo removal runs on the laptop in a PipeWire process that starts and stops with the voice service. While the voice service runs, that process can open the default microphone and read it at any time, including during startup: it does so whenever any program is sending sound to the default output or recording from the `kestrel-microphone` source. Treat the microphone as in use for as long as Kestrel runs. The process also reads the sound sent to the default output. It holds both in memory only, passes on the microphone signal with that sound removed, sends nothing over the network and saves nothing.

Hermes provider-error diagnostics can also contain transcript text in `sessions/request_dump_*.json` inside the service's owned temporary Hermes home under `.runtime/`. On an orderly shutdown, these local diagnostics are removed with that home after the worker exits; a hard-killed service or power loss can leave the folder behind. They are not reusable conversation storage. Do not publish them.
