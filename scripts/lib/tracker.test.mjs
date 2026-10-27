// tracker.test.mjs — direct tests of the tracker choice and of a card's identity.
// Run: node --test scripts/lib/tracker.test.mjs
//
// tracker.mjs imports no configuration, so these tests load it directly. Each expected value is
// written by hand from Linear's schema (Issue.identifier "e.g. ENG-123", Team.key the prefix) or from
// the GitHub output the board tools already print.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINEAR_IDENTIFIER, cardRef, compareCardIds, trackerOf } from './tracker.mjs';

test('trackerOf reads a configuration without TRACKER as github and accepts github, markdown and linear', () => {
  assert.equal(trackerOf({}), 'github');
  assert.equal(trackerOf({ TRACKER: 'github' }), 'github');
  assert.equal(trackerOf({ TRACKER: 'markdown' }), 'markdown');
  assert.equal(trackerOf({ TRACKER: 'linear' }), 'linear');
});

test('trackerOf refuses a value other than github, markdown or linear', () => {
  assert.throws(
    () => trackerOf({ TRACKER: 'Markdown' }),
    { message: 'scripts/lib/board-config.mjs: TRACKER must be "github", "markdown" or "linear"; found "Markdown"' },
  );
  assert.throws(() => trackerOf({ TRACKER: 'Linear' }), { message: /; found "Linear"$/ });
  assert.throws(() => trackerOf({ TRACKER: null }), { message: /; found null$/ });
});

test('LINEAR_IDENTIFIER accepts ENG-123 and refuses lowercase, a zero or leading-zero number, a missing team or number and trailing text', () => {
  for (const id of ['ENG-123', 'ENG-1', 'A-9', 'E2E-40', 'FAB-1000000']) {
    assert.match(id, LINEAR_IDENTIFIER, id);
  }
  for (const id of ['eng-123', 'Eng-1', 'ENG-0', 'ENG-012', 'ENG-', 'ENG', '-1', '2ENG-1', 'ENG-1x', 'ENG-1\n', 'ENG-1 ', ' ENG-1', 'ENG--1', 'ENG-1-2', '123', '']) {
    assert.doesNotMatch(id, LINEAR_IDENTIFIER, JSON.stringify(id));
  }
});

test('compareCardIds orders numbers numerically, identifiers by team then number without converting them, and null last', () => {
  const order = (ids) => [...ids].sort(compareCardIds);
  assert.deepEqual(order([10, 9, 100]), [9, 10, 100]);
  assert.deepEqual(order(['ENG-10', 'ENG-9', 'ENG-100']), ['ENG-9', 'ENG-10', 'ENG-100']);
  assert.deepEqual(order(['ENG-2', 'FAB-1', 'ABC-7']), ['ABC-7', 'ENG-2', 'FAB-1']);
  assert.deepEqual(order(['ENG-9007199254740993', 'ENG-9007199254740992']), ['ENG-9007199254740992', 'ENG-9007199254740993']);
  assert.deepEqual(order([null, 'ENG-1', 3, null, 'ENG-9', 1]), [1, 3, 'ENG-1', 'ENG-9', null, null]);
  assert.equal(compareCardIds(null, null), 0);
  assert.ok(compareCardIds(5, null) < 0);
  assert.ok(compareCardIds(null, 'ENG-1') > 0);
});

test('cardRef prints a Linear identifier as it is and anything else, a sentinel string included, as #<value>', () => {
  assert.equal(cardRef('ENG-123'), 'ENG-123');
  assert.equal(cardRef(272), '#272');
  assert.equal(cardRef('(summary)'), '#(summary)');
  assert.equal(cardRef('?'), '#?');
  assert.equal(cardRef('eng-1'), '#eng-1');
});
