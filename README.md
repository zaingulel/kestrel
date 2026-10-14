# kestrel
A local conversation prototype for Omarchy, with speech on the laptop and Saluki on the Ally.

Saluki runs through LM Studio on the ROG Ally X with the Radeon RX 9060 XT. Its server is reachable at `http://192.168.0.150:1234`. The laptop connects to that server; it does not need another LM Studio installation for speech.

The laptop's local speech models use the NVIDIA RTX 5080:

| Component | Model directory | Python environment |
| --- | --- | --- |
| [Nemotron Speech Streaming English 0.6B](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b), speech to text | `.runtime/models/nemotron` | `.runtime/asr-venv` |
| [VoxCPM2](https://github.com/OpenBMB/VoxCPM), text to speech | `.runtime/models/voxcpm2` | `.runtime/voice-venv` |

Both environments use project-local Python 3.12 and CUDA-enabled PyTorch 2.11. Recognition uses Transformers 5.19, which supports Nemotron's streaming model. Voice generation uses Transformers 4.57 in a separate environment to keep its dependencies independent. Model revisions are recorded in `.runtime/models/manifest.json`; installed package versions are in `.runtime/asr-installed.txt` and `.runtime/voice-installed.txt`. Runtime files are excluded from Git.

Conversation runs through a direct Hermes Agent 0.19.0 child process, started by `bot.py` through `hermes_worker.py`. It requires the installed interpreter at `/home/zain/.local/share/mise/installs/pipx-hermes-agent/0.19.0/hermes-agent/bin/python`; a missing interpreter or different Hermes version is refused explicitly. Hermes connects to Saluki through the Ally endpoint above. The engine enables no tools, including the terminal, and has no fallback provider. Kestrel handles [local mute](#local-mute) before the engine; the brain cannot invoke it.

Each connection gets a new temporary Hermes home under ignored `.runtime/`, with isolated configuration. The child does not load the normal Hermes configuration, memories or context files, and does not inherit provider credentials or proxy settings. Conversation history comes from Pipecat's committed context; reusable conversation storage, session snapshots and memory are disabled. Disconnect terminates the child, waits for it to exit and removes only that connection's temporary home. A new connection starts with empty conversation history.

Run commands from this directory. Start the conversation trial as a user service so it stays running independently of the launching terminal or chat command:

```sh
systemd-run --user --unit=kestrel-voice --collect --service-type=exec \
  --working-directory="$PWD" \
  --property="StandardOutput=append:$PWD/.runtime/voice-server.log" \
  --property=StandardError=inherit --property=TimeoutStopSec=15s \
  "$PWD/run-voice.sh"
```

Check or stop the service with `systemctl --user status kestrel-voice` or `systemctl --user stop kestrel-voice`. Server output is in `.runtime/voice-server.log`. This temporary service does not start automatically after a reboot. To run in a foreground terminal instead, use:

```sh
./run-voice.sh
```

Open [the local voice interface](http://127.0.0.1:7860/client/) in a browser with microphone access. The Pipecat test interface labels Start/Stop as **Connect/Disconnect**. Allow the microphone, choose **Kestrel microphone (echo removed)** in the page's microphone menu, click Connect, and wait for the agent to become ready before speaking. Kestrel refuses to start a conversation while no program is recording from that microphone. The first connection loads the speech models. Speak naturally, pause for a reply, and speak again to interrupt it. Disconnect stops the audio connection and clears the conversation. For foreground runs, press `Ctrl+C` in the server terminal to shut down Kestrel.

Only one conversation can run at a time. VoxCPM2 stays loaded in the laptop's graphics memory between connections to avoid reloading its weights. Shut down the server to release that memory. VoxType can stay running.

Speech goes from the microphone through echo removal to the browser, then to local Nemotron recognition. A completed exact mute command is handled locally and stays out of later brain-request history. Other turns go through the local Hermes worker to Saluki on the Ally, then through local VoxCPM2 and back to browser playback. Recognition processes speech segments after detected pauses; this trial does not provide word-by-word partial transcripts. Pipecat's local Silero speech detector and Smart Turn model control turn-taking. Smart Turn uses a 0.6-second silence fallback when it is uncertain, so Kestrel may reply during a thinking pause. It can still recognize a completed turn sooner. VoxCPM2 receives completed sentences and streams their audio. The brain request disables reasoning output with `reasoning_effort: "none"` for responsive conversation.

Hermes can continue a long reply with successive output caps of 180, 360, 720 and 1,440 tokens, a total budget of up to 2,700 tokens across four calls. If it still cannot finish, Kestrel speaks an incomplete-reply warning and requires reconnecting. This output budget is separate from the 64,000-token context capacity, which holds conversation history, instructions and replies. Long conversations can eventually fill that context.

Speaking over a reply stops its speech and playback. Hermes continues the current brain request until it finishes; the next ordinary conversation turn waits for that work to drain, which can add a delay. Local mute does not wait for the interrupted brain request. Unheard text from the interrupted reply is discarded, so only the heard prefix enters the next turn's context. Disconnect ends the worker rather than draining another conversational turn.

If the engine is unavailable, Kestrel explains that after an ordinary conversation turn; exact mute still takes the local route. Brain failures, incomplete replies and invalid worker responses also produce a spoken explanation, with the diagnostic reason in the server log. A partial reply already spoken is not treated as a complete answer. Kestrel does not automatically submit a failed user turn again or restart a broken engine session; follow the spoken advice and consult the diagnostic reason in the server log before reconnecting. Hermes may retry transient provider errors within a turn. Engine startup and each turn, including native retries or an interrupted turn draining, are bounded at 45 seconds.

Every sentence uses the same generated speaker reference at `.runtime/voices/kestrel.wav`, paired with its exact transcript in `speech.py`. This anchors speaker identity across sentences, replies and reconnections. Keep the reference fixed; replacing it changes Kestrel's voice. The reference uses [VoxCPM2's audio and transcript cloning mode](https://github.com/OpenBMB/VoxCPM#-ultimate-cloning). Startup preparation also reads this reference. It must be a complete, nonempty, mono 48 kHz WAV using 16-bit pulse-code modulation (PCM16), no longer than ten seconds; unsupported or truncated files prevent the conversation from starting.

This prototype supports conversation and local mute of the selected audio output. It has no browser research or persistent conversation memory. Transcript text can appear in the server's debug output; microphone recordings are not saved by the application. The server listens only on `127.0.0.1`.

Run the speech adapters, native Hermes boundary and whole-conversation tests:

```sh
.runtime/voice-venv/bin/python -m unittest discover -s tests -v
```

Model files are loaded locally without automatic downloads. The voice environment also contains `voxcpm==2.0.3` and `pipecat-ai[runner,webrtc,silero,openai]==1.12.0`. The adapters follow [Pipecat's speech input and turn detection conventions](https://docs.pipecat.ai/pipecat/learn/speech-input).

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

Installation checks, recorded-sample pipeline checks and generated audio are available under `.runtime/`. Recorded-sample checks verify the full recognition, Saluki and browser audio transport path; they do not establish recognition accuracy on the user's voice or live microphone-to-speaker latency.

## Local mute

Say **mute** on its own and finish the turn. After trimming surrounding whitespace and ignoring case, the recognized text must be exactly `mute`, `mute.` or `mute!`. `mute?`, quoted words, repeated punctuation, negation and longer requests go to the brain as ordinary conversation. Kestrel waits for the complete turn, not an individual speech segment. Recognition and turn detection can still mishear speech.

Kestrel uses Omarchy to resolve the selected audio output, including its physical output when digital signal processing routes sound through another sink. It explicitly sets that captured output muted at most once, never toggles it, and confirms success only after reading back mute status and checking that the selected output has not changed. Already muted is a silent no-op. Successful mute has no spoken acknowledgement or notification. The readback is a snapshot; other software can change the output afterwards.

Unmute manually through the desktop audio control. If digital signal processing routing changed, use the audio panel to select and unmute the affected output. Kestrel never automatically unmutes or retries an attempted mute. A new explicit mute turn is a new request.

If mute cannot be confirmed, Kestrel attempts to say **I couldn't confirm mute. Check the audio control. I won't retry.** and attempts a native desktop notification titled **Mute could not be confirmed**, with **Check the audio control. Kestrel will not retry.** The notification is transient and requests silent delivery. It contains fixed status text, never conversation text. Ordinary desktop notification settings apply; notification service failure is logged as unavailable. Muted speakers may hide the spoken error, and the desktop may suppress the notification, so check the audio control rather than treating silence as confirmation.

Speaking again can interrupt the failure speech while the attempted mute, readback and failure-notification attempt finish. Kestrel does not replay the request or speak a stale failure over the newer turn; if speech is interrupted and the notification is unavailable, only the local diagnostic may remain. Disconnect cancels and joins outstanding local work without undoing an attempted mute.

Startup prepares local speech and the engine concurrently. The engine receives one fixed public greeting whose reply is discarded. Once local speech is ready, the conversation pipeline starts and local mute works even while engine preparation is pending. The first ordinary turn waits for any remaining preparation, or receives the existing failure advisory if preparation fails. Local mute adds no engine tools, browser research or persistent conversation memory.

## Echo removal

Kestrel takes its own voice out of what the microphone hears, so it works on open speakers. Starting Kestrel also starts a PipeWire process from `echo-removal.conf`. It loads PipeWire's echo-cancel module, which uses the WebRTC canceller, reads the default microphone and the sound sent to the default output, and offers the result as a microphone named **Kestrel microphone (echo removed)**, `kestrel-microphone` to PipeWire. It removes everything played on the default output, not only Kestrel's voice, and follows that output when it changes, for example from the speakers to headphones. The module also applies its standard high-pass filter and noise suppression. Kestrel changes no system default and writes no PipeWire configuration, and the Kestrel microphone exists only while Kestrel runs.

While Kestrel runs, that process can keep the laptop's microphone in use even when no conversation is connected, as [Privacy and runtime boundary](#privacy-and-runtime-boundary) says. Stop Kestrel to release it.

Whatever captures speech for Kestrel must record from the Kestrel microphone and play Kestrel's voice on the default output. In the browser page, choose it in the microphone menu, leave the speaker on the default and connect with the microphone on; the page remembers the choice.

When a conversation starts, Kestrel checks that some program is recording from the Kestrel microphone, keeps looking for about ten seconds because a page starts recording a moment after it connects, longer if the audio system is slow to answer, and refuses the conversation if none is by then. The check cannot tell which program is recording and does not run again once the conversation is accepted. It misses a page that uses another microphone while a different program records from the Kestrel microphone, and a microphone changed in the page after the conversation has started. The last sign below shows both.

Echo removal is off when any of these is true:

- Kestrel drops the connection and the log says `Refusing the microphone session:` with the reason.
- The log says `Echo removal stopped`. Kestrel ends the conversation and stops; start it again. Stopping the service with `systemctl` writes the same line.
- `wpctl status` does not list the Kestrel microphone under Sources while Kestrel runs.
- The log shows `broadcasting interruption` straight after `Bot started speaking`, followed by a transcript of Kestrel's own words. Its voice is still reaching the microphone, for example because the page records from another microphone or plays through an output that is not the default.

After a change to the audio system, the volume or the devices, run the spoken check on open speakers at normal volume: speak ten turns, staying silent until each reply ends, then interrupt two replies by speaking. It passes when no reply is cut off by Kestrel's own voice, the log holds no transcript of Kestrel's own words, and both interruptions stop the reply.

## Development workflow

[AGENTS.md](AGENTS.md) defines the repository contract. The [local profile](.agents/REPOSITORY.md) records repository conventions; [docs/README.md](docs/README.md) indexes the standards and tracker manual. Factory adoption preserves this conversation prototype. Product discovery and drilling with the owner precede further product implementation.

Run `npm run lint`, `npm run lint:docs` and `npm run test:scripts` for the factory checks. `npm run test:speech` runs the existing Python tests with the local voice environment; `npm test` runs both suites.

The git guard and the other runtime hooks run only in a runtime that has trusted this repository's hook files, and only once those files are on `main` in the root checkout. An installed hook is not proof that it fires: the proof is a live probe in each runtime, in which a command the guard refuses, such as `git commit --no-verify --dry-run`, comes back blocked. Repeat the probe after a sync changes a hook file or a runtime's hook configuration.

## Privacy and runtime boundary

Microphone recognition and voice generation run locally on the laptop. Conversation transcripts and system context are sent to Saluki through the Ally's LM Studio server at `http://192.168.0.150:1234/v1` over the local area network. On connect, Kestrel starts a preparation request to the Ally with the fixed public text `Hello.`. Its reply is discarded, and neither preparation message enters caller conversation history. The browser service listens only on loopback at `127.0.0.1:7860`. Kestrel's only desktop tool is local mute of the selected audio output. The brain cannot invoke it or any other tool. Mute failure notifications contain fixed status text, never conversation text. Kestrel has no browser research or persistent conversation memory and adds no network destination. Deleting, sending messages, publishing and arbitrary command execution are not available by voice.

Runtime models, reference audio and logs remain ignored in `.runtime/` and must never be published. Transcript text may appear in the local server's debug output; the application does not save microphone recordings.

Echo removal runs on the laptop in a PipeWire process that starts and stops with the voice service. While the voice service runs, that process can open the default microphone and read it at any time, whether or not a conversation is connected: it does so whenever any program is sending sound to the default output or recording from the `kestrel-microphone` source. Treat the microphone as in use for as long as Kestrel runs. The process also reads the sound sent to the default output. It holds both in memory only, passes on the microphone signal with that sound removed, sends nothing over the network and saves nothing.

Hermes provider-error diagnostics can also contain transcript text in `sessions/request_dump_*.json` inside the connection's owned temporary Hermes home under `.runtime/`. On an orderly disconnect or shutdown, these local diagnostics are removed with that home after the worker exits; a hard-killed service or power loss can leave the folder behind. They are not reusable conversation storage. Do not publish them.
