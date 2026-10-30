import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAzureConfig } from './azure-config.mjs';

test('Azure configuration refuses ambiguous mappings and secret-bearing input', () => {
  // Literal mappings are the reviewed configuration contract, not validator-derived expectations.
  const configured = {
    organization: 'example-org',
    project: '11111111-1111-4111-8111-111111111111',
    workItemTypes: { epic: 'Epic', feature: 'User Story', task: 'Task', bug: 'Bug', docs: 'Task' },
    states: {
      Epic: { Backlog: 'New', Ready: 'Ready', 'In progress': 'Active', 'Awaiting push': 'Awaiting Push', 'In review': 'In Review', Done: 'Closed' },
      'User Story': { Backlog: 'New', Ready: 'Ready', 'In progress': 'Active', 'Awaiting push': 'Awaiting Push', 'In review': 'In Review', Done: 'Closed' },
      Task: { Backlog: 'New', Ready: 'Ready', 'In progress': 'Active', 'Awaiting push': 'Awaiting Push', 'In review': 'In Review', Done: 'Closed' },
      Bug: { Backlog: 'New', Ready: 'Ready', 'In progress': 'Active', 'Awaiting push': 'Awaiting Push', 'In review': 'In Review', Done: 'Closed' },
    },
  };
  const fresh = () => structuredClone(configured);
  assert.deepEqual(validateAzureConfig(configured), configured);
  const exact = fresh();
  exact.organization = 'Example-Org';
  exact.project = 'ABCDEF01-2345-6789-ABCD-EF0123456789';
  exact.states.Epic.Ready = ' Ready ';
  exact.workItemTypes.epic = ' Epic ';
  exact.states[' Epic '] = exact.states.Epic;
  delete exact.states.Epic;
  const validatedExact = validateAzureConfig(exact);
  assert.equal(exact.project, 'ABCDEF01-2345-6789-ABCD-EF0123456789');
  assert.deepEqual(validatedExact, { ...exact, project: 'abcdef01-2345-6789-abcd-ef0123456789' });
  for (const organization of ['a', 'A9', 'a'.repeat(49)]) {
    const value = { ...fresh(), organization };
    assert.deepEqual(validateAzureConfig(value), value);
  }
  const longest = fresh();
  longest.workItemTypes.epic = 'E'.repeat(255);
  longest.states['E'.repeat(255)] = longest.states.Epic;
  delete longest.states.Epic;
  longest.states.Task.Done = 'D'.repeat(255);
  assert.deepEqual(validateAzureConfig(longest), longest);

  const sentinel = 'SECRET_SENTINEL_AZURE_CONFIG';
  const refuse = (value, field) => assert.throws(
    () => validateAzureConfig(value),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('AZURE_CONFIG'), error.message);
      assert.ok(error.message.includes(field), error.message);
      assert.ok(!error.message.includes(sentinel), 'diagnostic leaked rejected input');
      return true;
    },
  );
  for (const value of [null, [], 'azure', 1]) refuse(value, 'AZURE_CONFIG');
  for (const key of ['organization', 'project', 'workItemTypes', 'states']) {
    const value = fresh();
    delete value[key];
    refuse(value, key);
  }
  for (const key of ['token', 'authentication', 'endpoint', sentinel]) {
    refuse({ ...fresh(), [key]: sentinel }, 'AZURE_CONFIG');
  }
  for (const organization of [
    '', ' ', 'a'.repeat(50), '-org', 'org-', 'org_name', 'a.b', 'a/b',
    'https://dev.azure.com/example-org', 'org?token=secret', ' org', 'org ',
    'org\n', 'org\u0080', sentinel + '/unsafe', null, [],
  ]) refuse({ ...fresh(), organization }, 'organization');
  for (const project of [
    '', 'Example Project', '11111111111141118111111111111111',
    '11111111-1111-4111-8111-11111111111g',
    '11111111-1111-4111-8111-111111111111\n',
    '../11111111-1111-4111-8111-111111111111', sentinel, null, [],
  ]) refuse({ ...fresh(), project }, 'project');

  for (const key of ['workItemTypes', 'states']) {
    for (const invalid of [null, [], 'mapping']) refuse({ ...fresh(), [key]: invalid }, key);
    for (const name of Object.keys(configured[key])) {
      const missing = fresh();
      delete missing[key][name];
      refuse(missing, key);
    }
    const extra = fresh();
    extra[key][sentinel] = sentinel;
    refuse(extra, key);
  }
  for (const type of ['Epic', 'User Story', 'Task', 'Bug']) {
    for (const invalid of [null, [], 'mapping']) {
      const value = fresh();
      value.states[type] = invalid;
      refuse(value, 'states');
    }
    for (const column of ['Backlog', 'Ready', 'In progress', 'Awaiting push', 'In review', 'Done']) {
      const missing = fresh();
      delete missing.states[type][column];
      refuse(missing, 'states');
    }
    const extra = fresh();
    extra.states[type][sentinel] = sentinel;
    refuse(extra, 'states');
    const duplicate = fresh();
    duplicate.states[type].Ready = 'New';
    refuse(duplicate, 'states');
  }
  const oversizedType = fresh();
  oversizedType.workItemTypes.epic = 'E'.repeat(256);
  oversizedType.states['E'.repeat(256)] = oversizedType.states.Epic;
  delete oversizedType.states.Epic;
  refuse(oversizedType, 'workItemTypes');
  const oversizedState = fresh();
  oversizedState.states.Task.Ready = 'S'.repeat(256);
  refuse(oversizedState, 'states');
  for (const invalid of ['', '   ', 'x'.repeat(256), null, [], 1,
    ...['\0', '\n', '\r', '\u001f', '\u007f', '\u0080', '\u009f'].map((control) => sentinel + control)]) {
    const type = fresh();
    type.workItemTypes.task = invalid;
    refuse(type, 'workItemTypes');
    const state = fresh();
    state.states.Task.Ready = invalid;
    refuse(state, 'states');
  }
  const secretType = fresh();
  secretType.workItemTypes.epic = sentinel;
  delete secretType.states.Epic;
  refuse(secretType, 'states');
  const wrongState = fresh();
  wrongState.states[sentinel] = wrongState.states.Epic;
  delete wrongState.states.Epic;
  refuse(wrongState, 'states');
  assert.throws(() => validateAzureConfig(null, 'answers.board.azure'), /answers\.board\.azure.*object/);
});
