// runtime-boundary.test.mjs — the privacy and runtime boundary the README promises.
//
// Bonsai listens only on local loopback, and local echo removal loads only local PipeWire
// modules. The exact privacy disclosure is the user promise; executed Python startup fixtures
// observe the brain configuration, environment and health checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');

const DISCLOSURE = [
  "Microphone recognition and voice generation run locally on the laptop. Conversation transcripts and system context stay on the laptop and are sent to the local Bonsai server at `http://127.0.0.1:8080/v1`. Bonsai listens on loopback at `127.0.0.1:8080` and answers nothing but its `/health` readiness check without Kestrel's private brain key; processes running as this account can read the key, while other accounts and web pages cannot use the brain. When the brain is available, Kestrel starts a preparation request to Bonsai with the fixed public text `Hello.`. Its reply is discarded, and neither preparation message enters caller conversation history. The enabled voice service starts at graphical login after reboot, starts inactive and can use the microphone during startup and inactivity through echo removal. Ordinary microphone recognition and spoken caller transcripts are admitted only while voice is active. Explicitly accepted typed requests can use the shared conversation, exact local commands and spoken replies while voice stays inactive; typing does not activate microphone recognition. Same-account processes can submit bounded typed text through the authenticated local control socket. It captures only from its verified owned echo-removed microphone and refuses unverified capture without falling back to a raw microphone. Kestrel's desktop tools are local mute and exact volume setting of the selected audio output, media pause and next track, numbered workspace focus, saving a native screenshot, and launching a uniquely matched visible installed app by name. App lookup and launch use the same captured local search paths and desktop selectors. An accepted launch request does not prove a window opened. Launched apps keep their normal permissions and behaviour, including any network access or side effects. Kestrel does not read, copy or send screenshot content. The brain can invoke the native local memory tool and the seven desktop tools described above, including app launching and screenshot saving, through shared validation, permission checks and observed results. The brain chooses these calls itself from any accepted spoken or typed turn, without per-call approval. A brain screenshot result carries only confirmed, attempted and a fixed reason, never its path or content. It cannot invoke other desktop tools. Audio failure notifications contain fixed status text, never conversation text. Kestrel has no browser research or reusable conversation archive. Automatic notes may be added, changed or removed by the native memory tool without per-write approval. Desktop file deletion, sending messages, publishing and arbitrary command execution are not available through Kestrel.",
  'While prepared and inactive, the optional local wake detector receives temporary PCM (pulse-code modulation) audio only from the verified owned echo-removed microphone. The parent capture queue holds at most four 20-millisecond frames; the isolated detector keeps roughly ten seconds of recent waiting audio plus derived features in memory until the waiting interval closes. Waiting audio is never recorded or sent to ordinary recognition, caller transcripts, brain requests, notes or local actions. The worker emits only fixed detection/refusal bytes, and wake diagnostics contain no audio or score payloads. Typed requests suppress waiting capture until their matching output has finished. Activation reaps waiting capture before starting fresh conversation capture; stale detections and detections during an active conversation cannot toggle it. Wake assets and the private positive test recording remain ignored in `.runtime/wakeword/` and must never be published.',
  'Runtime models, reference audio and logs remain ignored in `.runtime/` and must never be published. Transcript text may appear in the local voice and brain service logs, which are retained across restarts; the application does not save microphone recordings. The brain service log can record the last four characters of the brain key at startup, never the whole key.',
  'Echo removal runs on the laptop in a PipeWire process that starts and stops with the voice service. While the voice service runs, that process can open the default microphone and read it at any time, including during startup: it does so whenever any program is sending sound to the default output or recording from the `kestrel-microphone` source. Treat the microphone as in use for as long as Kestrel runs. The process also reads the sound sent to the default output. It holds both in memory only, passes on the microphone signal with that sound removed, sends nothing over the network and saves nothing.',
  'Hermes provider-error diagnostics can also contain transcript text in `sessions/request_dump_*.json` inside the service\'s owned temporary Hermes home under `.runtime/`. On an orderly shutdown, these local diagnostics are removed with that home after the worker exits; a hard-killed service or power loss can leave the folder behind. They can also hold the brain key masked to its first eight and last four characters, never the whole key. They are not reusable conversation storage. Do not publish them.',
];

test('the launcher starts the native conversation without a browser service', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'kestrel-native-launcher-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  copyFileSync(resolve(ROOT, 'run-voice.sh'), join(fixture, 'run-voice.sh'));
  mkdirSync(join(fixture, '.runtime/voice-venv/bin'), { recursive: true });
  const interpreter = join(fixture, '.runtime/voice-venv/bin/python');
  writeFileSync(interpreter, `#!/usr/bin/env bash\nprintf '%s\\n' "$@"\n`);
  chmodSync(interpreter, 0o755);
  const output = execFileSync('/usr/bin/bash', [join(fixture, 'run-voice.sh')], {
    cwd: '/', encoding: 'utf8',
  });
  assert.deepEqual(output.trim().split('\n'), ['bot.py']);
});

test('the echo removal process loads only local PipeWire modules', () => {
  const config = JSON.parse(read('echo-removal.conf'));
  assert.deepEqual(Object.keys(config).sort(), ['context.modules', 'context.properties', 'context.spa-libs']);
  assert.deepEqual(config['context.modules'].map((entry) => entry.name), [
    'libpipewire-module-rt',
    'libpipewire-module-protocol-native',
    'libpipewire-module-client-node',
    'libpipewire-module-adapter',
    'libpipewire-module-echo-cancel',
  ]);
});

test('the README states the privacy and runtime boundary in its exact words', () => {
  const readme = read('README.md');
  for (const paragraph of DISCLOSURE) {
    assert.ok(readme.includes(`\n${paragraph}\n`), `missing disclosure: ${paragraph.slice(0, 60)}`);
  }
});
