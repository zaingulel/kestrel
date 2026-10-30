// Jira configuration expectations come from the tracker contract, independently of validation code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateJiraConfig } from './jira-config.mjs';
import { JIRA_IDENTIFIER } from './tracker.mjs';

test('Jira configuration accepts exact mappings and rejects hostile values', () => {
  const configured = {
    site: 'https://example.atlassian.net',
    project: 'ENG',
    states: { Backlog: '10', Ready: '11', 'In progress': '12', 'Awaiting push': '13', 'In review': '14', Done: '15' },
    issueTypes: { epic: '10001', feature: '10002', task: '10002', bug: '10002', docs: '10002' },
    blockLinkType: '10003',
  };
  const fresh = () => structuredClone(configured);
  const validated = validateJiraConfig(configured, 'test Jira');
  assert.deepEqual(validated, configured);
  assert.notEqual(validated, configured);
  assert.notEqual(validated.states, configured.states);
  assert.notEqual(validated.issueTypes, configured.issueTypes);
  for (const value of [validated, validated.states, validated.issueTypes]) assert.ok(Object.isFrozen(value));
  assert.equal(Object.isFrozen(configured), false);
  assert.equal(Object.isFrozen(configured.states), false);
  assert.equal(Object.isFrozen(configured.issueTypes), false);
  assert.throws(() => { validated.project = 'OTHER'; }, TypeError);
  assert.throws(() => { validated.states.Ready = '99'; }, TypeError);
  assert.throws(() => { validated.issueTypes.task = '99'; }, TypeError);
  const caller = fresh();
  const snapshot = validateJiraConfig(caller, 'test Jira');
  caller.project = 'OTHER';
  caller.states.Ready = '99';
  caller.issueTypes.task = '99';
  assert.deepEqual(snapshot, configured);

  const refuse = (value, field) => assert.throws(
    () => validateJiraConfig(value, 'test Jira'),
    (error) => error instanceof Error && error.message.includes('test Jira') && error.message.includes(field),
  );
  for (const value of [null, [], 'jira']) refuse(value, 'test Jira');
  for (const key of ['site', 'project', 'states', 'issueTypes', 'blockLinkType']) {
    const value = fresh();
    delete value[key];
    refuse(value, key);
  }
  refuse({ ...fresh(), token: 'must not be configuration' }, 'token');

  for (const site of [
    'http://example.atlassian.net', 'https://example.atlassian.net.attacker.example',
    'https://user:password@example.atlassian.net', 'https://example.atlassian.net/',
    'https://example.atlassian.net/rest', 'https://example.atlassian.net?query=1',
    'https://example.atlassian.net#fragment', 'https://example.atlassian.net:443',
    'https://nested.example.atlassian.net', 'https://-example.atlassian.net',
    'https://example-.atlassian.net', 'https://example.atlassian.net\n', null,
  ]) refuse({ ...fresh(), site }, 'site');
  for (const project of ['E', 'eng', '2ENG', 'ENG-X', ' ENG', 'ENG\n', null]) {
    refuse({ ...fresh(), project }, 'project');
  }
  assert.equal(validateJiraConfig({ ...fresh(), project: 'E2E' }, 'test Jira').project, 'E2E');

  for (const key of ['states', 'issueTypes']) {
    for (const value of [null, [], 'mapping']) refuse({ ...fresh(), [key]: value }, key);
    for (const name of Object.keys(configured[key])) {
      const value = fresh();
      delete value[key][name];
      refuse(value, name);
    }
    const extra = fresh();
    extra[key].unexpected = '99';
    refuse(extra, 'unexpected');
  }
  const duplicate = fresh();
  duplicate.states.Ready = '10';
  refuse(duplicate, 'states');
  for (const id of ['', '0', '010', '-1', '1.5', '1e2', ' 10', '10\n', 10, null]) {
    const state = fresh();
    state.states.Ready = id;
    refuse(state, 'states');
    const type = fresh();
    type.issueTypes.task = id;
    refuse(type, 'issueTypes');
    refuse({ ...fresh(), blockLinkType: id }, 'blockLinkType');
  }

  for (const key of ['ENG-2', 'AB-1', 'E2E-100']) assert.match(key, JIRA_IDENTIFIER, key);
  for (const key of ['ENG-0', 'ENG-02', 'eng-2', 'A-2', '2ENG-2', 'ENG--2', 'ENG-2x', 'ENG-2\n']) {
    assert.doesNotMatch(key, JIRA_IDENTIFIER, key);
  }
});
