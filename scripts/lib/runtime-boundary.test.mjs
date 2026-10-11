// runtime-boundary.test.mjs — the privacy and runtime boundary the README promises.
//
// The service binds to loopback, the only remote endpoint is LM Studio on the Ally, and the
// README's disclosure says exactly that. Each assertion reads the committed bytes, so widening
// the bind, pointing the conversation elsewhere or rewording the promise goes red here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');

const DISCLOSURE = [
  'Microphone recognition and voice generation run locally on the laptop. Conversation transcripts and system context are sent to Saluki through the Ally\'s LM Studio server at `http://192.168.0.150:1234/v1` over the local area network. The browser service listens only on loopback at `127.0.0.1:7860`. The prototype has no tools or persistent memory.',
  'Runtime models, reference audio and logs remain ignored in `.runtime/` and must never be published. Transcript text may appear in the local server\'s debug output; the application does not save microphone recordings.',
];

test('the voice service binds to loopback only', () => {
  const hosts = read('run-voice.sh').match(/--host \S+/g);
  assert.deepEqual(hosts, ['--host 127.0.0.1']);
  assert.match(read('run-voice.sh'), / --port 7860 /);
});

test('the conversation goes only to LM Studio on the Ally', () => {
  const urls = read('bot.py').match(/https?:\/\/[^"'\s]+/g);
  assert.deepEqual(urls, ['http://192.168.0.150:1234/v1']);
});

test('the README states the privacy and runtime boundary in its exact words', () => {
  const readme = read('README.md');
  for (const paragraph of DISCLOSURE) {
    assert.ok(readme.includes(`\n${paragraph}\n`), `missing disclosure: ${paragraph.slice(0, 60)}`);
  }
});
