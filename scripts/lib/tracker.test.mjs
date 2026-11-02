// tracker.test.mjs — direct tests of the tracker choice and of a card's identity.
// Run: node --test scripts/lib/tracker.test.mjs
//
// tracker.mjs imports no configuration, so these tests load it directly. Each expected value is
// written by hand from the Jira tracker contract, Linear's schema (Issue.identifier "e.g. ENG-123",
// Team.key the prefix) or the GitHub output the board tools already print.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINEAR_IDENTIFIER, cardRef, compareCardIds, isAzureIdentifier, kindTypesOf, trackerOf } from './tracker.mjs';

test('trackerOf reads a configuration without TRACKER as github and accepts github, markdown and linear', () => {
  assert.equal(trackerOf({}), 'github');
  assert.equal(trackerOf({ TRACKER: 'github' }), 'github');
  assert.equal(trackerOf({ TRACKER: 'markdown' }), 'markdown');
  assert.equal(trackerOf({ TRACKER: 'linear' }), 'linear');
});

test('Jira is accepted without changing existing identities', () => {
  assert.equal(trackerOf({}), 'github');
  assert.equal(trackerOf({ TRACKER: 'github' }), 'github');
  assert.equal(trackerOf({ TRACKER: 'markdown' }), 'markdown');
  assert.equal(trackerOf({ TRACKER: 'linear' }), 'linear');
  assert.equal(cardRef('ENG-2'), 'ENG-2');
  assert.deepEqual(['ENG-10', 'ENG-2'].sort(compareCardIds), ['ENG-2', 'ENG-10']);
  assert.equal(trackerOf({ TRACKER: 'jira' }), 'jira');
});

test('trackerOf refuses a value other than github, markdown, linear, jira or azure', () => {
  assert.throws(
    () => trackerOf({ TRACKER: 'Markdown' }),
    { message: 'scripts/lib/board-config.mjs: TRACKER must be "github", "markdown", "linear", "jira" or "azure"; found "Markdown"' },
  );
  assert.throws(() => trackerOf({ TRACKER: 'Linear' }), { message: /; found "Linear"$/ });
  assert.throws(() => trackerOf({ TRACKER: null }), { message: /; found null$/ });
});

test('Azure accepts exactly AB identifiers in the positive int32 range', () => {
  assert.equal(trackerOf({ TRACKER: 'azure' }), 'azure');
  for (const id of ['AB-1', 'AB-299', 'AB-2147483647']) {
    assert.equal(isAzureIdentifier(id), true, id);
    assert.equal(cardRef(id), id);
  }
  for (const id of ['AB-0', 'AB-01', 'AB--1', 'AB-2147483648', 'AB-999999999999999999999', 'AB-1.5', 'ab-1', 'ENG-1', 'AB-1\n', ' AB-1', 'AB-1 ', '1', 1, null]) {
    assert.equal(isAzureIdentifier(id), false, JSON.stringify(id));
  }
  assert.deepEqual(['AB-10', 'AB-2', 'AB-1'].sort(compareCardIds), ['AB-1', 'AB-2', 'AB-10']);
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

const KIND_TYPES = { epic: 'Epic', feature: 'Feature', task: 'Task', bug: 'Bug', docs: 'Documentation' };
const KIND_LABELS = { epic: 'epic', feature: 'enhancement', task: 'task', bug: 'bug', docs: 'documentation' };

test('kindTypesOf reads a configuration without KIND_TYPES as labels on every tracker and owner', () => {
  for (const TRACKER of [undefined, 'github', 'markdown', 'linear', 'jira', 'azure', 'jra']) {
    for (const BOARD_OWNER_TYPE of ['user', 'organization']) {
      assert.equal(kindTypesOf({ TRACKER, BOARD_OWNER_TYPE, KIND_LABELS }), null, `${TRACKER} ${BOARD_OWNER_TYPE}`);
    }
  }
  assert.equal(kindTypesOf({ KIND_LABELS }), null);
});

test('kindTypesOf returns the map of a configuration owned by an organisation', () => {
  assert.deepEqual(kindTypesOf({ BOARD_OWNER_TYPE: 'organization', KIND_LABELS, KIND_TYPES }), KIND_TYPES);
  assert.deepEqual(kindTypesOf({ TRACKER: 'github', BOARD_OWNER_TYPE: 'organization', KIND_TYPES }), KIND_TYPES);
});

test('kindTypesOf refuses another tracker, a personal account and a malformed map', () => {
  const trackerRefusal = (tracker) => `scripts/lib/board-config.mjs: KIND_TYPES chooses GitHub native issue types, which apply only to the GitHub tracker, but TRACKER is "${tracker}"; remove KIND_TYPES`;
  for (const TRACKER of ['markdown', 'linear', 'jira', 'azure']) {
    assert.throws(() => kindTypesOf({ TRACKER, BOARD_OWNER_TYPE: 'organization', KIND_TYPES }), { message: trackerRefusal(TRACKER) });
  }
  assert.throws(() => kindTypesOf({ TRACKER: 'jira', BOARD_OWNER_TYPE: 'user', KIND_TYPES: null }), { message: trackerRefusal('jira') });

  assert.throws(
    () => kindTypesOf({ BOARD_OWNER_TYPE: 'user', KIND_TYPES }),
    { message: 'scripts/lib/board-config.mjs: KIND_TYPES chooses GitHub native issue types, which only an organisation\'s repositories have, but BOARD_OWNER_TYPE is "user"; remove KIND_TYPES' },
  );
  assert.throws(() => kindTypesOf({ BOARD_OWNER_TYPE: 'user', KIND_TYPES: null }), { message: /but BOARD_OWNER_TYPE is "user"/ });

  const missingKey = { ...KIND_TYPES };
  delete missingKey.docs;
  const malformed = [null, [], ['Epic', 'Feature', 'Task', 'Bug', 'Documentation'], 'Epic', missingKey, { ...KIND_TYPES, story: 'Story' }, {},
    { ...KIND_TYPES, task: '' }, { ...KIND_TYPES, task: ' Task' }, { ...KIND_TYPES, task: 'Task ' }, { ...KIND_TYPES, task: 7 },
    { ...KIND_TYPES, task: 'Epic' }];
  for (const types of malformed) {
    assert.throws(
      () => kindTypesOf({ BOARD_OWNER_TYPE: 'organization', KIND_TYPES: types }),
      { message: 'scripts/lib/board-config.mjs: KIND_TYPES must map exactly the kinds epic, feature, task, bug, docs to unique non-empty type names' },
      JSON.stringify(types),
    );
  }
});
