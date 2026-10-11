// ESLint config for Fabraik's first-party programs: workflow scripts and hook shells
// that gate every Bash and Agent tool call, which the agent platforms spawn from dot-directories
// that read like configuration. It catches mistakes (an undefined name, an unused variable, a
// duplicate key); it is NOT a style enforcer.
//
// Run it with:  npm run lint
import js from '@eslint/js';
import globals from 'globals';

const rules = {
  ...js.configs.recommended.rules,

  // `catch {}` is used deliberately throughout to swallow expected errors.
  'no-empty': ['error', { allowEmptyCatch: true }],

  // Too noisy for this codebase's defensive "init then assign in branches"
  // style (`let x = null; if (...) x = ...`) — more false alarms than bugs.
  'no-useless-assignment': 'off',

  // These are standalone programs, so an unused first-party variable is a real defect and blocks.
  'no-unused-vars': ['error', {
    caughtErrors: 'none',
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    // `({ linkProblem, ...correction }) => correction` strips a property on purpose.
    ignoreRestSiblings: true,
  }],

  // Existing `throw` sites drop the caught error; rewrapping them is its own campaign,
  // not this correctness gate.
  'preserve-caught-error': 'off',

  // Matchers for aligned CLI output legitimately contain literal runs of spaces.
  'no-regex-spaces': 'off',
};

export default [
  {
    files: [
      'scripts/**/*.mjs',
      '.claude/hooks/**/*.mjs',
      '.codex/hooks/**/*.mjs',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules,
  },
];
