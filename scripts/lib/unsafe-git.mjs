// @ts-nocheck
// unsafe-git.mjs: Git refusals shared by the Claude and Codex PreToolUse(Bash) guards, plus
// cleanup-specific permission for the Claude root hook. The hooks supply checkout facts; direct unit
// tests cover the policy and subprocess tests cover its wiring. The rules read nothing, except that a
// pre-approved run session's publish is judged on git and GitHub reads (merge-evidence.mjs), and a Herdr job's
// `gh api` call reads the body file it names.
//
// Sixteen plain rules, judged on the actual command segments of an agent's shell call:
//   git push / gh pr create / ready / merge in a pre-approved run session
//                            -> admitted only as a plain delivery form, the whole command, from the
//                                session's own working directory, for its own job/<n> card, open and
//                                not a proposal in its origin repository, whose newest claim its
//                                GitHub account made during the run, while fetched main sets
//                                waitForOwner to on-screen or when-needed, a level a Herdr job
//                                ignores; a push also needs none of
//                                the origin repository's open pull requests from that branch to be
//                                ready or have a merge queued, a ready or merge also needs neither
//                                the saved write-up at HEAD nor the published body to hold a wait
//                                reason, the card's show-me-first label and, at on-screen, work on
//                                screen among them, unless the card's recorded owner answer admits
//                                that head outside a Herdr job, and every label of the card readable;
//                                a coordinated Claude job's push to main is held by any wait reason. In a
//                                Herdr job only check, screenshot and the label are wait reasons. A
//                                Herdr job marks ready and merges on its exact pull request, and holds
//                                without using either legacy answer; verified Codex Herdr delivery
//                                also checks the bound worktree and version. Taking its own
//                                job pull request back to draft is always admitted. Judged only when
//                                the hook passes `{ preApproved }`.
//   git push / gh pr create / ready / merge and node …/merge-watch.mjs in a coordinated Claude job
//                            -> first needs the job's workflow version to verify, with the shared
//                                contracts unchanged except for its own `gh pr ready <number> --undo`
//                                and the one-argument merge-watch cleanup; the merge watch runs only
//                                as `node "$FABRAIK_WORKFLOW_ROOT/scripts/merge-watch.mjs" <arguments>`,
//                                the whole command. Judged only when the hook passes `verifyJobPin`.
//   a Herdr job's plainly written command that clears its card's show-me-first marker
//                            -> only the owner removes it: `gh issue edit --remove-label` naming
//                                it, `gh label delete` naming it or `edit` renaming it, `gh api`
//                                PUT, PATCH or DELETE on an issue's labels or on the marker among
//                                them, PATCH or DELETE on the repository's marker label, PATCH or
//                                POST on an issue with a `labels` field or an `--input` body whose
//                                labels leave it out, a GraphQL query, inline, `query=@<file>` or
//                                an `--input` body, that removes, clears, deletes or edits labels
//                                or sets an issue's `labelIds`, and the `show-first` off forms of
//                                scripts/owner-queue.mjs and the Queue panel's queue.mjs; a gh
//                                command is read through a plain `env` prefix and without `-R` or
//                                `--repo`, and a body file the guard cannot read counts as clearing.
//                                Judged only for a `coordinated` or `codexHerdr` job, or a Codex
//                                Herdr terminal whose binding could not be read.
//   git commit --no-verify   -> skips the pre-commit gates
//   git push --no-verify     -> skips the lint pre-push hook
//   git -c core.hooksPath=… / git --config-env core.hooksPath=… /
//   GIT_CONFIG_KEY_<n>=core.hooksPath / GIT_CONFIG_PARAMETERS=…'core.hooksPath=…'…
//                            -> points git at other hooks for that command, so the commit, merge
//                                and push hooks are skipped; refused on any git subcommand and
//                                whatever the value
//   git config core.hooksPath <other than .githooks> / --unset / unset
//                            -> disarms the hooks for every later command in the repository, its
//                                worktrees included; only the arming step and a read that ends at
//                                the key pass
//   git push --force / -f    -> unsafe overwrite (--force-with-lease is ALLOWED)
//   git filter-branch        -> history rewrite
//   git worktree add -B / --force / -f
//                            -> -B resets a branch that already exists to the start point, dropping
//                                the commits only it held, and --force overrides git's refusal to
//                                check out a branch another worktree holds or to reuse a missing or
//                                locked worktree's path; read in every spelling git takes (`-qB`,
//                                `-df`, `-Bmain`, `--fo`)
//   git worktree add <path holding .claude/worktrees/ and then a `..` step>
//                            -> climbs back out of the job worktrees folder; while a word holds
//                                that folder, every word after `add` must be plain, so a quoted,
//                                escaped, variable, substituted, glob or brace word is refused;
//                                the words are read with redirections and a trailing comment set
//                                aside
//   git worktree remove --force / -f
//                            -> deletes the worktree's uncommitted and untracked changes, and,
//                                given twice, a locked worktree
//   gh pr create / new (no --draft)
//                            -> skips the draft stage before the metered suite
//   gh pr merge              -> ordinary and legacy jobs use `gh pr merge --auto --squash --delete-branch <number>`
//                                alone in its segment, so GitHub waits for green checks. A Herdr job,
//                                coordinated Claude Code or verified Codex, uses a standalone
//                                `--match-head-commit` merge with checks green
//   gh pr ready              -> only `gh pr ready <number>`, with or without --undo, alone in its
//                                segment, is allowed
//   git commit / checkout / switch / branch <new> / merge (not --ff-only) / cherry-pick / revert /
//   rebase / am in the root checkout
//                            -> the root is the integration checkout: it stays on main and
//                                nothing is branched, switched, or committed there; a job runs in
//                                a linked worktree. Judged only when the hook passes
//                                `checkout` ({ cwd, isRootCheckout(dir), platform }, resolved in
//                                scripts/lib/checkout-context.mjs); `git switch main`,
//                                `git branch -d`, pulls, and worktree upkeep stay allowed
//
// Quoted spans and heredoc bodies are data, not invocations, and are blanked before the rules look,
// so a commit message or pull request body that mentions `--force` or `--draft` trips nothing. A
// backslash-escaped character outside single quotes is a character and nothing more: an escaped
// quote opens and closes no span and an escaped `<` opens no heredoc, so neither can turn a live
// command into data. The guard reads the command text with regular expressions and does not
// tokenise it, and it does not look inside a shell wrapper, a command substitution, or an `env -S`
// string. A plain `env` prefix is the one wrapper it reads: `env`, then any of `-i`, `-`,
// `--ignore-environment`, `--`, `-u NAME`, `-uNAME`, `--unset=NAME` or `--unset NAME`, where NAME
// is letters, digits and underscores, then `NAME=value` words, then git, is judged as the git
// command it runs by every git rule, the root-checkout rule included. Any other `env` form (`-S`,
// `-C`, `--chdir`, joined short options, an unset name of any other shape, an option after an
// assignment, a whole quoted assignment, a second `env`) is not read, and `env` in front of `cd`
// or `gh pr create` is not read either. The guard is an accident-catcher for an agent's own
// plainly written tool calls, not a security boundary, and a manual command in your own
// terminal is not a tool call, so your escape hatch survives. The rules on the server bind
// only an identity that cannot bypass them. Where the administrator role may bypass them,
// which the direct route to `main` relies on, a push to `main` by that role is judged
// locally, by the pre-push hook with the gate as it stands on the remote's `main`. Git runs
// that hook from the checkout that pushes, so a push that skips it, or comes from a checkout
// whose copy of it was changed or from a machine where the git configuration or attribute
// files git reads for that push, at any level, were changed, is not judged. The permission
// prompt on a push is an approval checkpoint and not a boundary either: this guard reads the
// command an agent submits, not what a program started by that command does afterwards, so
// nothing here establishes that every way of publishing meets that prompt. A push that runs
// unprompted would need a boundary on the server first.
// The `gh pr merge` and `gh pr ready` rules are the exception: the allow rules in
// `.claude/settings.json` run those prefixes unprompted, so these two rules bound what the prefixes
// admit and fail closed on any segment that invokes either and that they cannot fully read (a
// quoted word, the command words `gh`, `pr`, `merge` and `ready` included, a variable, a command
// substitution, a redirection, a wrapper, an assignment prefix, -R/--repo, a path-qualified or
// capitalised `gh`). They also read five shapes the other rules leave alone: an invocation glued to
// a lone `&` or `|&`, one that follows a shell comment or arithmetic holding a `<<word` or a quote
// character, one in a command substitution inside a double-quoted span, where a backslash-escaped
// `$(` or backtick is text and opens or closes nothing, one captured by a leading assignment, such
// as `out=$(gh pr merge ...)`, which assignment stripping would otherwise remove, and one whose
// `gh`, `pr`, `merge` or `ready` word is quoted, which is seen and refused even when the rest of
// the segment is the delivery form. Residuals, none of which matches the two `gh` allow rules: a
// `sh -c` or other
// wrapper string is not looked inside, a substitution that carries a heredoc inside double quotes
// is not read, and a quoted capitalised or path-qualified name and a partly quoted or
// backslash-escaped command word are not unquoted, and a `$(…)` inside double quotes whose closing
// `)` is hidden by a nested quote, a `case` pattern or an unbalanced literal `)` is read only to
// that early `)`, so an invocation after it is not seen. One residual does run unprompted: the
// working directory is not judged, so a delivery form after a `cd`, in the same command or an
// earlier call, passes, and `gh` acts on the repository that directory belongs to, which is another
// repository only where one sits inside the session's working directories. The environment is not
// judged either: after an `export` of `GH_REPO`, `GH_HOST`, `GH_TOKEN` or `GH_CONFIG_DIR` in the
// same command a delivery form passes, and `gh` acts on the repository or account the variable
// names. The allow rules do not cover the `export`, so they do not run that command unprompted. An
// ANSI-C `$'…'` span is paired as a plain single-quoted one, so a `\'` inside it ends the span
// early for the guard, and a command between it and the next `'` is read as quoted data and not
// seen. The segment walk does not read a backslash. An escaped `;` or `|`, a backslash-newline and
// an escaped blank in an assignment value each end a segment or a value for it, so a `--force` or
// `--no-verify` after one (`git push origin HEAD \` with the flag on the next line, `git commit -m
// a\;b --no-verify`) is not seen by the git rules, a `--draft` on a continuation line is not seen
// by the create rule, which refuses, and the merge and ready rules refuse the cut segment. A
// backslash-newline between the command words themselves (`gh pr \` then `merge`, `git \` then
// `push --force`) hides the invocation from every rule, and whether such a command then runs
// unprompted depends on how the runtime matches a continued command against the allow rules, which
// the guard does not control. A `#` straight after a closing `)` is not read as a comment, because
// after a substitution (`$(…)#`) it is a character; after a subshell it is a comment, so a
// `<<word` or a quote character in it (`(cmd)# <<word`) is read as an operator or a span and the
// lines up to its pairing are not seen. Arithmetic is one `((` to the next `))` with no depth, so a
// nested `))` ends it early and a shift after it (`$(( ((1)) << word ))`) is read as a heredoc
// operator. In both, the unseen line can be one the `gh pr ready` allow rule matches.
// Executable names (git, gh) are matched case-insensitively: this repository lives on a
// case-insensitive volume, so `Git push --force` runs the real binary. Only the name is widened;
// subcommands and flags stay exact (`git COMMIT` is not a command, `-F` is not `-f`), and `cd` stays
// lowercase because a capitalised `CD` runs /usr/bin/cd in a child process and moves nothing.
// The hooks-path rule reads four carriers of the setting: `-c core.hooksPath=<value>` and
// `--config-env core.hooksPath=<variable>` (or `--config-env=…`) among a git invocation's own
// options, before the subcommand; the word `GIT_CONFIG_KEY_<n>=core.hooksPath` anywhere in a
// segment, so an `export`, an `env` prefix and a command that names no git are read too; and an
// assignment of `GIT_CONFIG_PARAMETERS`, the variable git uses to hand `-c` to its own child
// processes, one of whose entries has the key as its complete key. Git takes the payload as a
// blank-separated list of single-quoted entries (`'key=value'`, `'key'` or `'key'='value'`), so
// the key counts only in an entry's key position: straight after a single quote that opens the
// payload or follows a blank, and straight before a `=` or a single quote. A longer key
// (`core.hooksPathology`), a value that mentions the key
// (`'alias.hooks=config --get core.hooksPath'`) and a value that is the quoted key
// (`'user.name'='core.hooksPath'`) pass. A payload written outside quotes has each of its single
// quotes and blanks backslash-escaped (`GIT_CONFIG_PARAMETERS=\'core.hooksPath\'=\'/dev/null\'`)
// and is read by the same key position. Git reads the key in any letter case, so the rule does,
// and the two environment names are read in any letter case too, because Git for Windows reads
// them so; `-c` stays exact, because `-C` is a directory.
// A redirection glued to the key word (`GIT_CONFIG_KEY_0=core.hooksPath>/dev/null`) ends it as a
// blank does. The value is not judged: no tool call needs the override, and the arming step
// `git config core.hooksPath .githooks` is a different command.
// Quoting hides none of the usual spellings. A quoted span that is the key alone, or the key and
// its value, keeps the key. One quoted span straight after `GIT_CONFIG_PARAMETERS=` that holds such
// an entry keeps the key. The whole value word of a `GIT_CONFIG_PARAMETERS` assignment is also read
// as the shell hands it to git, before anything else is rewritten: its quoted spans,
// backslash-escaped characters and bare characters are joined up to the first unquoted blank or
// operator, so a payload split across several quoted pieces (`"'"core.hooksPath=/dev/null"'"`) is
// read as the one payload it is, and a word that holds such an entry keeps the key. A quoted span
// that is a whole assignment (`"GIT_CONFIG_KEY_0=core.hooksPath"`,
// `"GIT_CONFIG_PARAMETERS='core.hooksPath=…'"`) is refused when its segment holds `export`,
// `declare`, `typeset` or `env` before it, and is a mention otherwise (`echo`, `grep`). Refused
// with the rule although harmless: an unquoted mention of either environment word (`grep
// GIT_CONFIG_KEY_0=core.hooksPath`), so quote the mention, an unquoted mention whose payload is
// split across quoted pieces, as the single-span mention is, a malformed payload git itself rejects
// whose joined word still holds the entry (`"'core.hooksPath=x'"extra`), and a quoted whole
// assignment used as plain text after one of those four words. An empty `GIT_CONFIG_PARAMETERS=`
// and one whose entries have other keys pass. Not refused, because git itself rejects them: a glued
// `-ccore.hooksPath=…` and a `-c core.hooksPath` with no `=`. Not refused, because the repository's
// own armed setting outranks them: `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM`. Residuals: a key or
// a payload behind a variable or a substitution (`-c "$KEY=…"`, `GIT_CONFIG_PARAMETERS=$P`), a
// partly quoted or backslash-escaped key, name, option or assignment outside the value word of a
// `GIT_CONFIG_PARAMETERS` assignment (`core."hooksPath"`, `"GIT_CONFIG_KEY_0"=core.hooksPath`, `-c
// core.hooksPath"=/dev/null"`, `-c core.hooks\Path=/dev/null`, `"-c" core.hooksPath=/dev/null`), a
// payload written as an ANSI-C `$'…'` span, a configuration file that carries the key (`-c
// include.path=<file>`) and a shell alias given by `-c alias.<name>=!…` whose body carries the
// override are not read; and an option carrier on a git that is subshelled, substituted, or wrapped
// by anything but a plain `env` prefix is not seen, as a `--no-verify` there is not.
// An edit of the configuration file itself, a `git config --edit`, and a `git config` that removes
// or renames the whole `core` section are not judged.
// The `git config` rule reads the words after `config`. When one of them is the key, the command
// passes only as a read (no word follows the key), as the arming step (the word after the key is
// `.githooks`, unquoted), or when its own key is read as another setting, as described below; every
// other unset form is refused. A word after the key is refused even when it looks like an option,
// because the older syntax stores it as the value: `git config core.hooksPath --get` sets the hooks
// path to `--get`. Put options before the key. The command's own key is read when the text after
// `config` is readable as written, character by character. Blanks are spaces and tabs. The words
// are an optional first word `set`, `unset` or `get`; then only these options, spelled in full:
// `--global`, `--system`, `--local`, `--worktree`, `--get`, `--get-all`, `--add`, `--replace-all`,
// `--unset`, `--unset-all`, `--all`, `--fixed-value`, and `-f`, `--file`, `--type`, `--default` and
// `--value`, each with a plain word, the long ones also glued with `=`; then a plain dotted key;
// then plain words that do not start with a dash; then, at the end only, plain redirections (`>`,
// `>>` or `<` with a plain target, one descriptor digit allowed) and a comment. A plain word is
// letters, digits and `_ . / : @ + , -`; a quoted span that is exactly the key counts as the key.
// When the command's key is another setting the command passes, although it names `core.hooksPath`
// as a value, a pattern or an option's value: `git config --unset user.name core.hooksPath` unsets
// `user.name`. Anything else is not read and keeps the refusal: an abbreviated or unlisted option,
// any other quoted word, a backslash, a variable, a glob, a word after the key that starts with a
// dash, an ampersand, a parenthesis, a descriptor copy (`2>&1`), a here-string, any other blank
// character anywhere in the command, and any command in which a quoted `gh`, `pr`, `merge` or
// `ready` was unquoted, because that reading leaves a blank where the shell joins two pieces. The
// scope is not judged, so a `--global` write is refused although the repository's own armed setting
// outranks it. A redirection is not a word, whether a blank precedes it or it is glued to the word
// before it (`core.hooksPath>/dev/null`), and neither is a trailing comment, so a read followed by
// either passes. A backslash-escaped blank does not end a word, so a redirection target that holds
// one (`>/tmp/my\ log`) is one target, and a `#` after it starts no comment. An abbreviated
// `--unset-all` (`--unset-a`, `--unset-al`) is an unset, because git takes a unique prefix of a
// long option.
// The `git worktree` rules find every invocation anywhere in a segment, after a blank, `(`, a
// backtick or `&`, so a wrapper (`time`, `nice`, `timeout`), a lone `&`, a subshell or an earlier
// harmless invocation in front of it hides nothing, and, like the merge and ready rules, they read
// a command substitution inside a double-quoted span. Each invocation is judged on the words after
// its `add` or `remove` up to the next invocation, split on spaces and tabs, with each operator
// character (`;`, `|`, `&`, `<`, `>`, `(`, `)`, a backtick or a newline) read as a word of its own,
// so an option glued to one (`--force>/dev/null`, `--force&`) is still read. A plain word is
// letters, digits and `_ . / : @ + , -`, and a redirection before the subcommand is passed over
// whatever its target, and one after it, after a blank or glued onto the subcommand, whose target is
// plain, is not a word. Any other redirection is a word, whether glued elsewhere, escaped, or with a
// target holding a backslash or a quote. A `..`
// before the folder (`../../.claude/worktrees/x`) leads into it and passes. Refused with the rule
// although harmless: an unquoted mention (`echo git worktree add -B x`), so quote it, and an add
// under the folder sent to the background, whose `&` is not a plain word. Residuals: where no word
// shows the folder, only plain words are read, so a quoted, escaped or variable `-B` or `--force`
// there is not seen, nor is an option carried onto a continuation line, nor a path whose
// `.claude/worktrees/` is itself quoted or behind a variable; a `>` after a blank inside a `${...}`
// expansion is read as a redirection with its target; a process substitution nested inside another
// hides the invocation its redirection precedes; and `git worktree move --force` is not judged.
import { posix, resolve as resolvePath, win32 } from 'node:path';
import { boundedBytes, COMMIT_TEXT, publishCheck, SHOW_FIRST } from './merge-evidence.mjs';
import { watchDriftAllowed } from './workflow-pin.mjs';

export const CODEX_HERDR_UNAVAILABLE = 'a Codex Herdr job binding is unavailable';
const PINNED_MERGE = new RegExp(`^gh pr merge --squash --delete-branch --match-head-commit (${COMMIT_TEXT}) ([1-9]\\d*)$`);
const PINNED_PUSH = new RegExp(String.raw`^git push --no-follow-tags origin (${COMMIT_TEXT})\^\{object\}:refs/heads/main$`);
// Each place a node run of any merge-watch.mjs starts, its command word bare or quoted (`"node"`); and the one pinned
// form. A syntax check is exempt only as `SYNTAX_CHECK`, the whole command: preloads from the command line or the
// environment still run under `--check`, and the shell can build or source that environment. Its path holds only plain
// path characters, since brace and glob expansion could otherwise turn it into options.
const MERGE_WATCH_RUN = /(?<=^|[\s;&|(`'"/])(?=(["']?)node(?:\.exe)?\1[ \t][^\n;&|]*?merge-watch\.mjs(?![\w.-]))/g;
const SYNTAX_CHECK = /^node(?:\.exe)? (?:--check|-c) [\w./][\w./-]*$/;
const PINNED_WATCH = '`node "$FABRAIK_WORKFLOW_ROOT/scripts/merge-watch.mjs" <arguments>`';
const PINNED_WATCH_RUN = /^node "\$FABRAIK_WORKFLOW_ROOT\/scripts\/merge-watch\.mjs"((?: [\w./:@+,=-]+)*)$/;
const NEVER_CLEARS_MARKER = `a Herdr job never clears the ${SHOW_FIRST} marker: the owner removes it`;
// The `gh api` options that take the next word as their value.
const API_VALUE_OPTIONS = ['-X', '--method', '-H', '--header', '-f', '--raw-field', '-F', '--field', '--input', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview'];
// A GraphQL label mutation. A label's node id does not show whether it is the marker, so deleting or editing any label
// counts.
const LABEL_MUTATION = /\b(?:removeLabelsFromLabelable|clearLabelsFromLabelable|deleteLabel|updateLabel)\b/;
const isMarker = (name) => name.trim().toLowerCase() === SHOW_FIRST;

// Whether a Herdr job's command, as `words` split into `segments` of plain words, clears its card's show-me-first
// marker, as the plainly written forms the header lists do; `cwd` is where a `gh api` body file is read from. A segment
// is read without a plain leading `env` and its assignments, and a gh segment without gh's `-R` or `--repo` option
// wherever it sits. The marker name is matched trimmed and in any letter case, also inside a comma list.
function clearsMarker(segments, cwd) {
  return segments.some((segment) => {
    let words = segment[0] === 'env' ? segment.slice(1) : segment;
    while (/^\w+=/.test(words[0] ?? '')) words = words.slice(1);
    if (/^(?:\S*\/)?gh$/i.test(words[0] ?? '')) {
      const repo = (word) => word === '-R' || word === '--repo';
      words = words.filter((word, at) => !repo(word) && !repo(words[at - 1]) && !word.startsWith('--repo='));
      const [, noun, verb, ...rest] = words;
      if (noun === 'issue' && verb === 'edit') {
        return rest.some((word, at) => {
          const value = word === '--remove-label' ? rest[at + 1] : /^--remove-label=([\s\S]*)$/.exec(word)?.[1];
          return value !== undefined && value.split(',').some(isMarker);
        });
      }
      if (noun === 'label' && verb === 'delete') return rest.some(isMarker);
      // Recolouring or redescribing the marker leaves it on the card; renaming it does not.
      if (noun === 'label' && verb === 'edit') return rest.some(isMarker) && rest.some((word) => /^(?:-n|--name(?:=|$))/.test(word));
      if (noun === 'api') return apiClearsMarker(words.slice(2), cwd);
    }
    const script = words.findIndex((word) => /(?:^|\/)(?:owner-)?queue\.mjs$/.test(word));
    if (script === -1) return false;
    const after = words.slice(script + 1);
    if (/owner-queue\.mjs$/.test(words[script])) {
      return after.includes('show-first') && after.some((word, at) => word === '--state=off' || (word === '--state' && after[at + 1] === 'off'));
    }
    const operands = after.filter((word, at) => !word.startsWith('-') && after[at - 1] !== '--home');
    return operands[0] === 'show-first' && operands.includes('off');
  });
}

// Whether `gh api` with `args` clears the marker: a write to an issue's labels that removes it or replaces them all, an
// issue write whose labels leave it out, a delete or edit of the marker label itself, or a GraphQL label mutation. A
// body file, `query=@<file>` or `--input <file>`, is read as a bounded regular file, and one the guard cannot read or,
// for `--input`, parse as JSON counts as clearing.
function apiClearsMarker(args, cwd) {
  const fields = [];
  let method;
  let endpoint;
  let input;
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at];
    if (!word.startsWith('-')) {
      endpoint ??= word;
      continue;
    }
    const [option, glued] = word.startsWith('--') ? word.split(/=([\s\S]*)/) : [word.slice(0, 2), word.slice(2) || undefined];
    const value = glued ?? (API_VALUE_OPTIONS.includes(option) ? args[(at += 1)] : undefined);
    if (option === '-X' || option === '--method') method = value?.toUpperCase();
    else if (option === '--input') input = value ?? '';
    else if (['-f', '--raw-field', '-F', '--field'].includes(option) && value !== undefined) {
      const [key, text = ''] = value.split(/=([\s\S]*)/);
      fields.push({ key, text, file: (option === '-F' || option === '--field') && text.startsWith('@') });
    }
  }
  method ??= fields.length || input !== undefined ? 'POST' : 'GET';
  // The text of body file `file`, or undefined where the guard cannot read it.
  const read = (file) => {
    if (!cwd) return undefined;
    try {
      return boundedBytes(resolvePath(cwd, file)).toString('utf8');
    } catch {
      return undefined;
    }
  };
  // The `--input` body parsed as JSON, or undefined where it cannot be read or parsed.
  const inputBody = () => {
    try {
      return JSON.parse(read(input) ?? '');
    } catch {
      return undefined;
    }
  };
  // Whether a label named in the path, percent-encoded or not, is the marker; a malformed encoding counts as it.
  const namesMarker = (name) => {
    try {
      return isMarker(decodeURIComponent(name));
    } catch {
      return true;
    }
  };
  const path = (endpoint ?? '').replace(/[?#][\s\S]*$/, '');
  const issueLabel = /(?:^|\/)issues\/\d+\/labels(?:\/([^/]+))?$/.exec(path);
  if (issueLabel) return ['PUT', 'PATCH', 'DELETE'].includes(method) && (issueLabel[1] === undefined || namesMarker(issueLabel[1]));
  const repoLabel = /(?:^|\/)repos\/[^/]+\/[^/]+\/labels\/([^/]+)$/.exec(path);
  if (repoLabel) return ['PATCH', 'DELETE'].includes(method) && namesMarker(repoLabel[1]);
  if (/(?:^|\/)issues\/\d+$/.test(path)) {
    if (!['PATCH', 'POST'].includes(method)) return false;
    if (fields.some(({ key }) => /^labels(?:\[|$)/.test(key))) return true;
    if (input === undefined) return false;
    const body = inputBody();
    if (body === null || typeof body !== 'object') return true;
    if (!Object.hasOwn(body, 'labels')) return false;
    const name = (label) => (typeof label === 'string' ? label : label?.name);
    return !(Array.isArray(body.labels) && body.labels.some((label) => typeof name(label) === 'string' && isMarker(name(label))));
  }
  if (path !== 'graphql') return false;
  const queries = fields.filter(({ key }) => key === 'query').map(({ text, file }) => (file ? read(text.slice(1)) : text));
  if (input !== undefined) {
    const body = inputBody();
    queries.push(typeof body?.query === 'string' ? body.query : undefined);
  }
  return queries.some((query) => query === undefined || LABEL_MUTATION.test(query) || (/\bupdateIssue\b/.test(query) && /\blabelIds\b/.test(query)));
}

// Returns a reason string when `cmd` should be blocked, or "" when it's allowed. `checkout` is the
// hook's working-directory context, `{ cwd, isRootCheckout(dir), platform }`, whose platform picks the
// path rules the walk resolves with; without it the root-checkout rule is not judged, and every other
// rule is unchanged. `preApproved`, `{ start, tracker, boundCard, coordinated }`
// plus the optional `appJob`, `codexHerdr` and runner injections publishCheck takes, identifies a pre-approved run.
// `coordinated` marks a Claude Herdr job and `codexHerdr` carries the verified Codex job binding. `verifyJobPin({ drift })`,
// which the Claude guard supplies to a coordinated Claude job, throws when the job's workflow version does not verify.
// `appRun` marks an enrolled native session; `runUnavailable` is a refusal used for publication when
// native classification failed. Either protects the reserved metadata name.
// `runMarkUnreadable` is the cause where a desktop app session's first message, which may hold a run mark, cannot
// be read: that session publishes nothing. `herdrTerminal` marks a Codex Herdr job terminal whose binding could not be
// read: it publishes nothing, as `runUnavailable` says, and still never clears the show-me-first marker.
export function blockReason(cmd, checkout, { preApproved = null, appRun = false, runUnavailable = '', runMarkUnreadable = '', herdrTerminal = false } = {}) {
  cmd = cmd ?? "";
  const codexHerdr = preApproved?.codexHerdr;
  const herdrJob = codexHerdr || preApproved?.coordinated;
  const verifyJobPin = preApproved?.verifyJobPin;
  // The verified workflow version `{ commit, root }`, or the cause `verifyJobPin` throws.
  const pinCheck = (drift) => {
    try {
      return { pin: verifyJobPin({ drift }), cause: '' };
    } catch (error) {
      return { cause: error.message };
    }
  };
  const codexHerdrUnavailable = runUnavailable.startsWith(CODEX_HERDR_UNAVAILABLE);
  const recognizesWrappedPush = codexHerdr || codexHerdrUnavailable;
  // Check submitted text, including quoted paths, without importing the Git-spawning checkout module.
  if ((appRun || runUnavailable) && cmd.includes('fabraik-app-run')) {
    return 'a native app run session must leave its binding metadata to the coordinator';
  }
  // Widen each letter of a name to its own class rather than using a regex `i` flag, which would
  // also loosen every option match in the same expression (`-F` for `-f`, `-D` for `-d`).
  const ci = (name) => [...name].map((ch) => (/[a-z]/.test(ch) ? `[${ch.toUpperCase()}${ch}]` : ch)).join('');
  // An odd run of backslashes before a character escapes it; an even run is literal backslashes.
  const escapedAt = (text, at) => {
    let run = 0;
    while (text[at - 1 - run] === '\\') run += 1;
    return run % 2 === 1;
  };
  // The text each `$(…)` and backtick pair in `body` runs, a `$(…)` read to the matching `)` by counting parentheses
  // alone and a backslash-escaped `$(` or backtick being text that opens or closes neither.
  const substitutions = (body) => {
    const texts = [];
    for (let index = 0; index < body.length; index += 1) {
      const backtick = body[index] === '`';
      if ((!backtick && !body.startsWith('$(', index)) || escapedAt(body, index)) continue;
      const start = index + (backtick ? 1 : 2);
      let end = start;
      if (backtick) {
        while (end < body.length && (body[end] !== '`' || escapedAt(body, end))) end += 1;
      } else {
        for (let depth = 1; end < body.length; end += 1) {
          if (body[end] === '(') depth += 1;
          else if (body[end] === ')' && (depth -= 1) === 0) break;
        }
      }
      texts.push(body.slice(start, end));
      index = end;
    }
    return texts;
  };
  // A `#` here would start a word, and so a comment, at the start of `text` or after an unescaped
  // blank or operator. A backslash-newline pair joins two lines, so the character before the pairs
  // decides. `text` is the scan's output, where a comment's text is already gone, so a comment line
  // ending in a backslash continues nothing.
  const startsWord = (text) => {
    let at = text.length;
    while (text[at - 1] === '\n' && escapedAt(text, at - 1)) at -= 2;
    return at === 0 || (/[\s;&|(]/.test(text[at - 1]) && !escapedAt(text, at - 1));
  };
  // deheredoc — replace each heredoc operator with `<<HEREDOC` and drop its body, nothing else.
  // A body starts after the next UNQUOTED newline (POSIX XCU 2.7.4), so words after `<<WORD` on the
  // operator line are argv and survive; a `<<WORD` inside quotes is prose and opens no pairing; `<<<`
  // is a here-string and opens none either. The scan carries shell quote state and skips body text,
  // so an apostrophe in a body cannot poison it, and it queues the operators on one line so
  // `cat <<A <<B` consumes A's body then B's. The terminator test tolerates surrounding blanks and a
  // trailing \r, because a body left visible is the false-block this pass exists to prevent.
  // A backslash outside single quotes is copied together with the character it escapes and the pair
  // is read as nothing: an escaped quote toggles no quote state, an escaped `#` starts no comment,
  // an escaped `<` opens no pairing, an escaped `(` or `)` opens or closes no arithmetic, and an
  // escaped newline does not end the operator line, so the body starts after the next unescaped
  // one. Inside single quotes a backslash is a character and the next `'` closes the span. A shell
  // comment keeps its `#` and loses its text up to the newline, and a `<<` between `((` and `))` is
  // an arithmetic shift, so neither opens a pairing or a quoted span. A `#` starts a comment only at
  // the start of a word, which `startsWord` judges on the text already copied: after a
  // backslash-escaped blank or operator it continues the word and the rest of the line stays live.
  // Not modelled, named rather than hidden: a `<<\EOF` or `<<""EOF` delimiter, which is no operator
  // here, so its body stays live text and a quote character in it can pair with a later one and hide
  // the lines between, a delimiter the pattern reads only in part (`<<E\OF`, `<<E"OF"`, `<<EOF-x`),
  // which is paired by the part it read, so the lines between the shell's terminator and a later line
  // of that part are dropped as a body and not seen, a heredoc operator straight after an escaped `<`
  // (`\<<<EOF`), and a heredoc inside "$(…)", which the shell re-parses and this scan does not
  // re-enter. The body of a heredoc whose delimiter is unquoted, where the shell runs substitutions, is kept aside for
  // the merge-watch rule; with no terminator line the shell reads that body to the end of the input, and so does the
  // scan.
  const HEREDOC_OPERATOR = /^<<-?[ \t]*(['"]?)(\w+)\1/;
  const liveHeredocBodies = [];
  const deheredoc = (() => {
    let out = '';
    let index = 0;
    let inSingle = false;
    let inDouble = false;
    let inArithmetic = false;
    let pending = [];
    while (index < cmd.length) {
      const ch = cmd[index];
      if (ch === '\\' && !inSingle) { out += cmd.slice(index, index + 2); index += 2; continue; }
      if (ch === "'" && !inDouble) { inSingle = !inSingle; out += ch; index += 1; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; out += ch; index += 1; continue; }
      const unquoted = !inSingle && !inDouble;
      if (unquoted && ch === '#' && startsWord(out)) {
        const lineEnd = cmd.indexOf('\n', index);
        out += ch;
        index = lineEnd === -1 ? cmd.length : lineEnd;
        continue;
      }
      if (unquoted && (ch === '(' || ch === ')') && cmd[index + 1] === ch) {
        inArithmetic = ch === '(';
        out += ch + ch;
        index += 2;
        continue;
      }
      if (
        ch === '<' && cmd[index + 1] === '<'
        && cmd[index + 2] !== '<' && cmd[index - 1] !== '<'
        && unquoted && !inArithmetic
      ) {
        const operator = HEREDOC_OPERATOR.exec(cmd.slice(index));
        if (operator) {
          pending.push({ word: operator[2], live: operator[1] === '' });
          out += '<<HEREDOC';
          index += operator[0].length;
          continue;
        }
      }
      out += ch;
      index += 1;
      if (ch === '\n' && !inSingle && !inDouble && pending.length) {
        for (const { word, live } of pending) {
          const hit = new RegExp('^[ \\t]*' + word + '[ \\t]*\\r?$', 'm').exec(cmd.slice(index));
          if (!hit) {
            if (live) liveHeredocBodies.push(cmd.slice(index));
            break;
          }
          if (live) liveHeredocBodies.push(cmd.slice(index, index + hit.index));
          index += hit.index + hit[0].length;
        }
        pending = [];
      }
    }
    return out;
  })();
  // Every rule anchors on the git or gh invocation, path-qualified or bare, after any leading
  // variable assignments (`GIT_AUTHOR_NAME=x git commit`, `GH_TOKEN=x gh pr merge`); a git
  // invocation may also follow one plain `env` prefix (`env FOO=1 git push`).
  const EXEC_PATH = String.raw`(?:\S*\/)?`;
  // -R/--repo is inherited by `gh pr`, so it is valid before `pr` or before the subcommand.
  const GH_REPO_OPT = String.raw`(?:-R\S+|--repo=\S+|(?:-R|--repo)\s+\S+)\s+`;
  const GH_EXEC = String.raw`${EXEC_PATH}${ci('gh')}`;
  // Merge and ready are detected anywhere in the segment before assignment stripping (after a wrapper,
  // glued to a lone `&`, inside an unquoted `$(` or backticks, or captured by an assignment such as
  // `out=$(gh pr merge ...)`), then the whole segment, before assignment stripping, must be the delivery form.
  const GH_PR_MERGE = new RegExp(String.raw`(?:^|[\s(\`&])${GH_EXEC}\s+(?:${GH_REPO_OPT})*pr\s+(?:${GH_REPO_OPT})*merge\b`);
  const GH_PR_READY = new RegExp(String.raw`(?:^|[\s(\`&])${GH_EXEC}\s+(?:${GH_REPO_OPT})*pr\s+(?:${GH_REPO_OPT})*ready\b`);
  const REASON_MERGE = herdrJob
    ? 'gh pr merge: a Herdr job merges only with `gh pr merge --squash --delete-branch --match-head-commit <head> <number>` as a plain command on its own, so GitHub checks the pinned head'
    : "gh pr merge: only the delivery form `gh pr merge --auto --squash --delete-branch <number>`, alone in its command segment, is allowed; --auto lets GitHub merge once the required test check is green, and because the allow list runs that prefix unprompted anything else in the segment (--admin, a reordered or missing flag, a quoted, substituted or variable word, a wrapper) is refused";
  const REASON_READY = "gh pr ready: only `gh pr ready <number>` and `gh pr ready <number> --undo`, alone in their command segment, are allowed; the allow list runs that prefix unprompted, so anything else in the segment (a quoted, substituted or variable word, a redirection, a wrapper) is refused";
  // Git reads a configuration key in any letter case. A quoted span keeps the hooks-path key where
  // a carrier puts it, so the hooks-path rule reads the usual quoted spellings; a value stays
  // blanked. The key alone, or the key and its value (`-c "core.hooksPath=/dev/null"`,
  // `GIT_CONFIG_KEY_0="core.hooksPath"`), is kept unquoted. A whole environment assignment
  // (`"GIT_CONFIG_KEY_0=core.hooksPath"`) is kept in its quotes, because it is live only as an
  // argument of `export`, `declare`, `typeset` or `env`. A payload straight after
  // `GIT_CONFIG_PARAMETERS=` that holds the key as an entry's complete key is kept as the key. The
  // value word is first joined across its pieces by a read of its own, where the name counts only
  // where the environment rule counts it (the start of the text or after a blank, `(`, a backtick,
  // `&`, `;` or `|`); that read runs before the command-word unquote, because the unquote leaves a
  // blank the command never held, which would end the word early. Git takes the payload as
  // blank-separated single-quoted entries (`'key=value'`, `'key'` or `'key'='value'`), so the key
  // is an entry's complete key only between a single quote that opens the payload or follows a
  // blank and a `=` or a single quote; a quote after `=` opens a value. `HOOKS_PATH_ENTRY` reads a
  // payload from its first character. Git for Windows reads an environment variable name in any
  // letter case, so both names are widened.
  const HOOKS_PATH_KEY = String.raw`${ci('core')}\.${ci('hookspath')}`;
  const HOOKS_PATH_ENTRY = String.raw`(?:[\s\S]*\s)?'${HOOKS_PATH_KEY}['=]`;
  const CONFIG_KEY_NAME = String.raw`${ci('git_config_key_')}\d+`;
  const CONFIG_PARAMETERS_NAME = ci('git_config_parameters');
  const HOLDS_HOOKS_PATH_ENTRY = new RegExp(String.raw`^${HOOKS_PATH_ENTRY}`);
  const ASSIGNS_CONFIG_PARAMETERS = new RegExp(String.raw`${CONFIG_PARAMETERS_NAME}=$`);
  const QUOTED_HOOKS_PATH_KEY = new RegExp(String.raw`^${HOOKS_PATH_KEY}(?:(=)[\s\S]*)?$`);
  const QUOTED_HOOKS_PATH_ASSIGNMENT = new RegExp(String.raw`^(${CONFIG_KEY_NAME}(?==${HOOKS_PATH_KEY}$)|${CONFIG_PARAMETERS_NAME}(?==${HOOKS_PATH_ENTRY}))`);
  // Blank every quoted span ONCE, before any splitting or matching. A quoted mention is data (`git
  // commit -m "mentions --no-verify"`, a PR body citing `--draft`), and blanking a quoted newline
  // keeps a multi-line body from stranding a later `--draft` in its own segment. Both span patterns
  // match newlines, so a multi-line span is blanked whole. A backslash outside single quotes is
  // matched together with the character it escapes and returned as written, in the command-word
  // unquote and in the blanker alike, so an escaped quote opens and closes no span and both agree
  // with the scan above. The value-word read takes escaped pairs and quoted spans with the
  // blanker's own two patterns, so the two cannot disagree about where a span ends. A quoted path
  // after `cd` or `-C` is a relocation the root-checkout walk below must follow, and this
  // checkout's own directory carries a space, so it is blanked to a whitespace-free ␀<n>␀
  // placeholder instead of `""` and kept aside for relocate(). Planted inside the one pass so quote
  // pairing stays the blanker's own: a separate scan once paired an apostrophe inside a
  // double-quoted span with a later single quote and swallowed live argv (pinned by test).
  // Two readings serve the merge and ready rules, and the second the worktree rules too. Quote
  // removal makes `"merge"` the word `merge`, so a quoted span that is exactly one of their four
  // command words is unquoted first, and left followed by a space the command never held: the rules
  // see the invocation, and its segment can never be the exact delivery text, so it is refused. No
  // other quoted word is unquoted, because a quoted `--draft` or `--force` is data. And a
  // double-quoted span runs only what its `$(…)`, read to the matching `)`, or its backtick pair
  // holds, a backslash-escaped `$(` or backtick being text that opens or closes neither, so a merge,
  // ready or worktree invocation in that substituted text is live and is judged at the end of the
  // segment walk. That text is judged whole, with no split at separators and no reading of its quotes
  // or comments, so a separator, a quote or a comment in it is read as a word. This fails closed: a
  // safe command beside a worktree invocation in it can be refused, and is then written plainly. The
  // rest of the span stays data; a span carrying a heredoc operator is a message body and is left as
  // data. The substitution is read to its matching `)` by counting parentheses alone, so a `)` inside
  // a quoted span or a comment within it ends the substitution early, and what follows stays data.
  let substitutedReason = '';
  const substitutedTexts = [];
  const quotedPaths = [];
  const ESCAPED = String.raw`\\[\s\S]`;
  const QUOTED_SPAN = String.raw`'[^']*'|"(?:[^"\\]|\\[\s\S])*"`;
  const WORD_PIECE = String.raw`${ESCAPED}|${QUOTED_SPAN}|[^\s;&|<>()]`;
  // A word as the shell hands it on: each escaped character, quoted span and bare character of it, unquoted and joined.
  const unquoteWord = (word) => word.replace(new RegExp(WORD_PIECE, 'g'), (piece) => (piece.length === 1 ? piece : piece[0] === '\\' ? piece[1] : piece.slice(1, -1)));
  // A Herdr job's command is read as segments of such words, split at each unquoted separator, with the assignments
  // that lead a segment left out.
  if (herdrJob || herdrTerminal) {
    const segments = [[]];
    for (const [, word] of deheredoc.matchAll(new RegExp(String.raw`((?:${WORD_PIECE})+)|[;&|()\n]`, 'g'))) {
      if (word === undefined) segments.push([]);
      else if (segments.at(-1).length || !/^\w+=/.test(word)) segments.at(-1).push(unquoteWord(word));
    }
    if (clearsMarker(segments, checkout?.cwd)) return NEVER_CLEARS_MARKER;
  }
  const payloadKeyed = deheredoc.replace(new RegExp(String.raw`${ESCAPED}|(?<=^|[\s(\`&;|])(${CONFIG_PARAMETERS_NAME}=)((?:${WORD_PIECE})*)|${QUOTED_SPAN}`, 'g'), (match, name, value) => {
    if (name === undefined) return match;
    const payload = unquoteWord(value);
    return HOLDS_HOOKS_PATH_ENTRY.test(payload) ? `${name}core.hooksPath` : match;
  });
  const wordsUnquoted = payloadKeyed.replace(/\\[\s\S]|(['"])(gh|pr|merge|ready)\1/g, (match, quote, word) => (word ? `${word} ` : match));
  const sanitized = wordsUnquoted.replace(new RegExp(String.raw`${ESCAPED}|${QUOTED_SPAN}`, 'g'), (span, offset, whole) => {
    if (span[0] === '\\') return span;
    if (span[0] === '"' && !span.includes('<<')) {
      for (const text of substitutions(span.slice(1, -1))) {
        substitutedReason ||= (GH_PR_MERGE.test(text) && REASON_MERGE) || (GH_PR_READY.test(text) && REASON_READY) || '';
        substitutedTexts.push(text);
      }
    }
    if (/(?:^|[\s;&|(])(?:cd|-C)[ \t]+$/.test(whole.slice(0, offset)) && /^(?:[\s;&|)]|$)/.test(whole.slice(offset + span.length))) {
      return `␀${quotedPaths.push(span.slice(1, -1)) - 1}␀`;
    }
    const content = span.slice(1, -1);
    const key = QUOTED_HOOKS_PATH_KEY.exec(content);
    if (key) return `core.hooksPath${key[1] ? '=""' : ''}`;
    const assignment = QUOTED_HOOKS_PATH_ASSIGNMENT.exec(content);
    if (assignment) return `"${assignment[1]}=core.hooksPath"`;
    return HOLDS_HOOKS_PATH_ENTRY.test(content) && ASSIGNS_CONFIG_PARAMETERS.test(whole.slice(0, offset)) ? 'core.hooksPath' : '""';
  });
  const GIT_OPT_WITH_ARG = String.raw`(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env)\s+\S+\s+`;
  const GIT_EXEC = String.raw`${EXEC_PATH}${ci('git')}`;
  const ENV_PREFIX = String.raw`${EXEC_PATH}${ci('env')}\s+(?:(?:-i|-|--ignore-environment|--|-u\s*\w+|--unset(?:=|\s+)\w+)\s+)*(?:\w+=\S*\s+)*`;
  const GIT_START = String.raw`^(?:${ENV_PREFIX})?${GIT_EXEC}`;
  const GIT_INVOCATION_PREFIX = String.raw`${GIT_START}\s+(?:${GIT_OPT_WITH_ARG}|-\S+\s+)*`;
  const GIT_COMMIT = new RegExp(String.raw`${GIT_INVOCATION_PREFIX}commit\b`);
  const GIT_PUSH = new RegExp(String.raw`${GIT_INVOCATION_PREFIX}push\b`);
  const GIT_WRAPPED_PUSH = new RegExp(String.raw`(?:^|[\s(\`&])${GIT_EXEC}\s+(?:${GIT_OPT_WITH_ARG}|-\S+\s+)*push\b`);
  const isPush = (text) => GIT_PUSH.test(text) || (recognizesWrappedPush && GIT_WRAPPED_PUSH.test(text));
  const GIT_FILTER_BRANCH = new RegExp(String.raw`${GIT_INVOCATION_PREFIX}filter-branch\b`);
  // The worktree rules find every invocation anywhere in a segment, after a blank, `(`, a backtick or
  // `&`, as the merge and ready rules do, so a wrapper, a lone `&`, a subshell or an earlier harmless
  // invocation in front of it hides nothing. Git bundles short options (`-qf`) and takes a value glued
  // on (`-Bmain`), and only `-b` and `-B` take one, so a short word forces when its `f` comes before
  // any `b` or `B` and resets a branch when `B` is the first of them; git also takes a unique prefix
  // of a long option (`--fo`). A redirection never reaches git's arguments, so between `git`, its
  // options, `worktree` and the subcommand any redirection, whatever its target and a process
  // substitution included, is passed over in finding the invocation; the body of a process
  // substitution passed over is judged on its own, so passing over too much only finds more
  // invocations to judge. Among the words after the subcommand it is set aside only when it is
  // certain: after a blank or glued straight onto the subcommand, an operator whose target is a
  // descriptor copy, a plain word or a quoted span the blanker left as `""`, ending at a blank or an
  // operator. Any other operator or target stays a word, so an escaped `\>`, a `>` glued to any other
  // word (as `../git>` inside a `${x:-...}` default), a target holding a backslash or a `$`, and a `>`
  // inside the raw text of a substitution hide nothing. The subcommand may be followed by an operator.
  const WORKTREE_REDIRECT = String.raw`\d*(?:[<>]{1,2}|&>>?)&?[ \t]*(?:[<>]\([^()]*\)|[^\s;&|()<>\`]*)`;
  const WORKTREE_PROCESS_SUBSTITUTION = /[<>]\(([^()]*)\)/g;
  const WORKTREE_GAP = String.raw`(?:\s|${WORKTREE_REDIRECT})+`;
  const GIT_WORKTREE = new RegExp(String.raw`(?:^|[\s(\`&])${GIT_EXEC}${WORKTREE_GAP}(?:(?:${GIT_OPT_WITH_ARG}|-\S+\s+)(?:${WORKTREE_REDIRECT}\s*)*)*worktree${WORKTREE_GAP}(add|remove)(?=[\s;&|<>()\`]|$)`, 'g');
  const WORKTREE_FORCE = /^(?:--f(?:o(?:r(?:ce?)?)?)?$|-[^-bB]*f)/;
  const WORKTREE_RESET = /^-[^-bB]*B/;
  const WORKTREE_REDIRECTION = /(?<=^|\s)\d*(?:[<>]{1,2}|&>>?)(?:&\d+|[ \t]*(?:[\w./:@+,-]+|""))(?=[\s;&|<>()`]|$)/g;
  const UNDER_WORKTREES = /\.claude\/worktrees\/([\s\S]*)/;
  const CLIMBS_OUT = /(?:^|\/)\.\.(?:\/|$)/;
  const PLAIN_WORD = /^[\w./:@+,-]+$/;
  const GH_PR_CREATE = new RegExp(String.raw`^${GH_EXEC}\s+(?:${GH_REPO_OPT})*pr\s+(?:${GH_REPO_OPT})*(?:create|new)\b`);
  const DELIVERY_CREATE = /^gh pr create --draft --title (?:[A-Za-z0-9][A-Za-z0-9._:/-]*|'[^'\r\n]+'|"[^"$`\\!\r\n]+") --body-file [A-Za-z0-9._/][A-Za-z0-9._/-]*$/;
  const DELIVERY_MERGE = /^gh pr merge --auto --squash --delete-branch \d+$/;
  const DELIVERY_READY = /^gh pr ready (?:\d+(?: --undo)?|--undo \d+)$/;
  const NO_VERIFY = /(?:^|\s)--no-verify(?:\s|=|$)/;
  // The option carriers sit among git's own options, so they anchor as every git rule does. The
  // environment words are read on the unstripped segment, because an `export` or `env` prefix
  // carries them; a whole quoted assignment, which the blanker kept in its quotes, counts only
  // after a word that takes an assignment as its argument. A `<` or `>` ends the key word as a blank
  // does, because a redirection glued to it is not part of the value. After
  // `GIT_CONFIG_PARAMETERS=` the key counts as the bare key the blanker kept or as an entry's
  // complete key in a payload written outside quotes, where a backslash may precede each single
  // quote and the `=` and a backslash-escaped blank separates the entries: the key's quote opens
  // the payload or follows such a blank.
  const GIT_HOOKS_PATH_OPTION = new RegExp(String.raw`${GIT_INVOCATION_PREFIX}(?:-c\s+|--config-env(?:=|\s+))${HOOKS_PATH_KEY}=`);
  const HOOKS_PATH_ENVIRONMENT = new RegExp(String.raw`(?:^|[\s(\`&])(?:${CONFIG_KEY_NAME}=${HOOKS_PATH_KEY}(?:[\s)\`&<>]|$)|${CONFIG_PARAMETERS_NAME}=(?:${HOOKS_PATH_KEY}\b|(?:(?:\S|\\\s)*\\\s)?\\?'${HOOKS_PATH_KEY}\\?['=]))`);
  const QUOTED_HOOKS_PATH_ENVIRONMENT = new RegExp(String.raw`(?:^|[\s(\`&])${EXEC_PATH}(?:export|declare|typeset|${ci('env')})\s(?:.*\s)?"(?:${CONFIG_KEY_NAME}|${CONFIG_PARAMETERS_NAME})=${HOOKS_PATH_KEY}"`);
  const GIT_CONFIG = new RegExp(String.raw`${GIT_INVOCATION_PREFIX}config(?=\s)(.*)$`);
  const HOOKS_PATH_WORD = new RegExp(String.raw`^${HOOKS_PATH_KEY}$`);
  const REDIRECTION = /\s(?:\d*[<>]{1,2}|&>>?)(?:&\d+|\s*\S+)/g;
  // An operator ends the word before it with or without a blank, and takes its target with it. A
  // file-descriptor digit run is the operator's only after a blank; glued digits are the word's.
  // Only the config rule reads the glued form: widening `REDIRECTION` would let through a
  // `git switch main>/dev/null` the root-checkout rule refuses today. A backslash takes the next
  // character into the word, a blank included, so a target or a value that holds an escaped blank
  // stays one word and a `#` after that blank starts no comment.
  const CONFIG_WORD = String.raw`(?:\\.|\S)+`;
  const CONFIG_REDIRECTION = new RegExp(String.raw`(?:\s\d+)?(?:[<>]{1,2}|&>>?)\s*${CONFIG_WORD}`, 'g');
  const CONFIG_PLAIN = String.raw`(?!-)[\w./:@+,-]+`;
  const CONFIG_OPTION = String.raw`--(?:global|system|local|worktree|get|get-all|add|replace-all|unset|unset-all|all|fixed-value)|--(?:file|type|default|value)=[\w./:@+,-]*|(?:-f|--file|--type|--default|--value)[ \t]+${CONFIG_PLAIN}`;
  // Reads the command's own key when the whole text after `config` is plain words, listed options
  // and trailing plain redirections. An unread command is judged by the older rule, never exempted.
  const CONFIG_KEY_READ = new RegExp(String.raw`^[ \t]+(?:(?:set|unset|get)[ \t]+)?(?:(?:${CONFIG_OPTION})[ \t]+)*((?!-)[\w-]+\.[\w.-]+)(?:[ \t]+${CONFIG_PLAIN})*(?:(?:[ \t]+\d)?[ \t]*(?:>>?|<)[ \t]*${CONFIG_PLAIN})*(?:[ \t]+#)?[ \t]*$`);
  // The segment walk trims every white-space character, and the shell takes only a space, a tab and
  // a newline as blanks, so a command holding any other one is not read.
  const ODD_BLANK = /[^\S \t\n]/;
  const rewritesHooksPath = (args) => {
    const written = args.replace(CONFIG_REDIRECTION, ' ').match(new RegExp(CONFIG_WORD, 'g')) ?? [];
    const comment = written.findIndex((word) => word.startsWith('#'));
    const words = comment === -1 ? written : written.slice(0, comment);
    const at = words.findIndex((word) => HOOKS_PATH_WORD.test(word));
    if (at === -1) return false;
    // Git takes a unique prefix of a long option; anything shorter than `--unset` is ambiguous.
    const unset = words.some((word) => word === 'unset' || (word.startsWith('--unset') && '--unset-all'.startsWith(word)));
    const key = wordsUnquoted === payloadKeyed && !ODD_BLANK.test(cmd) ? CONFIG_KEY_READ.exec(args)?.[1] : undefined;
    return (unset || (at + 1 < words.length && words[at + 1] !== '.githooks')) && (key === undefined || HOOKS_PATH_WORD.test(key));
  };
  // Any `..` step after the folder is refused, since the text cannot show where it lands. The shell
  // splits words on spaces and tabs only, so any other blank stays inside its word, and it ends a
  // word at an operator character, so each of those is read as a word of its own and an option glued
  // to one (`--force&`, `--force)`) is still seen. A comment's `#` is the last word, because the scan
  // above drops a comment's text; a `#` anywhere else is no comment.
  const worktreeInvocationReason = (subcommand, args) => {
    const split = args.split(/[ \t]+|(?=[;&|<>()`\n])|(?<=[;&|<>()`\n])/).filter(Boolean);
    const words = split.at(-1) === '#' ? split.slice(0, -1) : split;
    const forced = words.some((word) => WORKTREE_FORCE.test(word));
    if (subcommand === 'remove') {
      return forced ? "git worktree remove --force deletes the worktree's uncommitted and untracked changes, and given twice a locked worktree: commit what it holds or discard it on purpose, unlock it if it is locked, then remove it without --force" : '';
    }
    if (words.some((word) => WORKTREE_RESET.test(word))) {
      return "git worktree add -B resets the branch to the start point when it already exists, dropping the commits only it held: create a new branch with -b instead";
    }
    if (forced) {
      return "git worktree add --force overrides git's refusal to check out a branch another worktree holds or to reuse the path of a missing or locked worktree: free the branch or the path first (git worktree list, git worktree prune), or choose a new one";
    }
    const paths = words.flatMap((word) => UNDER_WORKTREES.exec(word)?.slice(1) ?? []);
    if (paths.some((rest) => CLIMBS_OUT.test(rest))) {
      return "git worktree add: a path under .claude/worktrees/ that holds `..` can climb back out of that folder: write it as .claude/worktrees/<name> with no `..`";
    }
    if (paths.length && !words.every((word) => PLAIN_WORD.test(word))) {
      return "git worktree add under .claude/worktrees/: a word that is not plain (letters, digits and `_ . / : @ + , -`), such as a quoted, escaped, variable or substituted word, can hide `..`, -B or --force from this guard: write every word plainly";
    }
    return '';
  };
  // Each invocation is judged on its own words, up to the next invocation.
  const worktreeReason = (text) => {
    const invocations = [...text.matchAll(GIT_WORKTREE)];
    const reasons = invocations.map((invocation, at) => {
      const args = text.slice(invocation.index + invocation[0].length, invocations[at + 1]?.index).replace(WORKTREE_REDIRECTION, ' ');
      return worktreeInvocationReason(invocation[1], args);
    });
    const passedOver = [...text.matchAll(WORKTREE_PROCESS_SUBSTITUTION)].map((substitution) => worktreeReason(substitution[1]));
    return [...reasons, ...passedOver].find(Boolean) ?? '';
  };
  // A pre-approved run session publishes only a plain delivery form, as the whole command, from its own working
  // directory. These refusals read nothing; publishCheck then reads the branch, origin, the setting, the card and, for
  // a ready or merge, the saved write-up at HEAD and any saved card an owner answer on the card names.
  const boundedReason = (s, raw) => {
    const refuse = (why) => `a pre-approved run session ${why}`;
    const kind = isPush(s) ? 'push' : GH_PR_CREATE.test(s) ? 'create' : GH_PR_READY.test(raw) ? 'ready' : 'merge';
    // Git for Windows reads an environment variable name in any letter case.
    const named = /\b(?:GH_REPO|GH_HOST|GIT_DIR|GIT_WORK_TREE)\b/i.exec(cmd)?.[0];
    if (named) return refuse(`publishes nothing from a command naming ${named}, which can point git or gh away from origin`);
    // A segment before or after it could repoint the remote, the branch, the directory or the
    // environment the publish runs with, so the whole command must be the publish alone.
    if (sanitized.trim() !== raw) return refuse('publishes only as a command on its own, with nothing before or after it');
    if (raw !== s) return refuse('publishes only a plain command, with no assignment before it');
    if (!checkout?.cwd) return refuse('publishes nothing without its working directory');
    // The whole raw command must be the one form, so quoting or a heredoc cannot hide code the checks never read.
    if (kind === 'create' && !DELIVERY_CREATE.test(cmd)) {
      return refuse(`opens a pull request only as \`gh pr create --draft --title <title> --body-file <path>\`, the title a letter or digit then letters, digits and . _ : / -, single-quoted with no ' or newline, or double-quoted with no ", $, backtick, backslash, ! or newline`);
    }
    // The lone-command refusal above already keeps any `cd` from preceding it.
    if (/(?:^|\s)(?:-C|--git-dir|--work-tree)/.test(s)) return refuse('publishes nothing from a command holding -C, --git-dir or --work-tree, which can move it out of its own working directory');
    if (kind === 'ready' && !DELIVERY_READY.test(raw)) return refuse('marks ready only with `gh pr ready <number>`, with or without --undo');
    let pinnedMerge;
    if (kind === 'merge') {
      if (herdrJob) {
        const pin = cmd === raw && PINNED_MERGE.exec(cmd);
        if (!pin || !Number.isSafeInteger(Number(pin[2]))) return REASON_MERGE;
        pinnedMerge = { head: pin[1], number: pin[2] };
      } else if (!DELIVERY_MERGE.test(raw)) {
        return refuse('merges only with `gh pr merge --auto --squash --delete-branch <number>`');
      }
    }
    const pinnedSource = kind === 'push' && codexHerdr && cmd === raw ? PINNED_PUSH.exec(cmd)?.[1] : undefined;
    // Only taking its own pull request back to draft stays open while a shared contract has moved on.
    const { pin: workflowPin, cause: unpinned } = verifyJobPin ? pinCheck(!(kind === 'ready' && /--undo/.test(raw))) : { cause: '' };
    if (unpinned) return refuse(`publishes nothing without its job's verified workflow version: ${unpinned}`);
    return publishCheck(kind, raw, { ...preApproved, pinnedMerge, pinnedSource, workflowPin, cwd: checkout.cwd });
  };
  const ruleReason = (s, raw) => {
    const publishes = isPush(s) || GH_PR_CREATE.test(s) || GH_PR_MERGE.test(raw) || GH_PR_READY.test(raw);
    if (runMarkUnreadable && publishes) {
      return `a desktop app session whose run mark cannot be read publishes nothing: ${runMarkUnreadable}`;
    }
    // An admitted publish still meets every rule below.
    const boundedRefusal = preApproved && publishes ? boundedReason(s, raw) : '';
    if (boundedRefusal) return boundedRefusal;
    if (GIT_COMMIT.test(s) && NO_VERIFY.test(s)) {
      return "git commit --no-verify skips the pre-commit gates";
    }
    if (GIT_PUSH.test(s) && NO_VERIFY.test(s)) {
      return "git push --no-verify skips the lint pre-push gate";
    }
    if (GIT_HOOKS_PATH_OPTION.test(s) || HOOKS_PATH_ENVIRONMENT.test(raw) || QUOTED_HOOKS_PATH_ENVIRONMENT.test(raw)) {
      return "a core.hooksPath override skips the pre-commit and pre-push gates";
    }
    const config = GIT_CONFIG.exec(s);
    if (config && rewritesHooksPath(config[1])) {
      return "git config core.hooksPath: only the arming step `git config core.hooksPath .githooks` and a read that ends at the key are allowed; another value or an unset skips the pre-commit and pre-push gates, and git can store a word after the key as the value even when it looks like an option, so put options before the key";
    }
    if (GIT_PUSH.test(s) && /(?:^|\s)(?:--force(?!-with-lease)|-f)(?:\s|$)/.test(s)) {
      return "git push --force is unsafe (use --force-with-lease for a rebase)";
    }
    if (GIT_FILTER_BRANCH.test(s)) {
      return "git filter-branch rewrites history";
    }
    if (GH_PR_CREATE.test(s) && !/(?:^|\s)(?:--draft|-d)(?:\s|$)/.test(s)) {
      return "gh pr create without --draft skips the draft stage: open it as a draft (--draft/-d) so it is settled before CI runs";
    }
    // Auto-merge is GitHub's own wait-for-green: the agent's owner-authorised merge is queued, never
    // forced. The allow list runs these two prefixes unprompted, so only the exact forms pass. A Herdr
    // job's pinned merge form is judged in boundedReason.
    if (GH_PR_MERGE.test(raw) && !herdrJob && !DELIVERY_MERGE.test(raw)) {
      return REASON_MERGE;
    }
    if (GH_PR_READY.test(raw) && !DELIVERY_READY.test(raw)) {
      return REASON_READY;
    }
    return worktreeReason(s) || (publishes ? runUnavailable : '');
  };
  // Integration-checkout rule. The root checkout (the main working tree, never a linked worktree)
  // stays on main and nothing is branched, switched, or committed there: two sessions sharing it
  // collided twice while prose alone said so. Where a command runs is a fact only the hook can ask
  // git for, so it passes `checkout` and any caller passing nothing is not judged. The walk carries a
  // SET of candidate directories across segments, and refuses branch work if any of them is the
  // root: a `cd` chained with `&&` replaces the set (a failed cd stops the chain), one chained with
  // `;`, a newline, or `||` adds to it (a failed cd leaves the shell where it was and the chain runs
  // on), and one behind `|` moves nothing (a pipeline subshell). `git -C <path>` moves one
  // invocation. So `cd <worktree> && git commit` from the root stays allowed, `cd <root> && git
  // commit` from a worktree is refused, and `cd <gone>; git commit` from the root is refused too.
  // Branch work is commit, checkout, switch, a `git branch` that names a branch without deleting
  // or listing, and the other writers of commits onto the current branch: merge (a fast-forward-only
  // merge is the pull's own shape and stays allowed), cherry-pick, revert, rebase, am. The lone
  // switch allowed is to `main`, the only branch the root may hold, which is how closeout and the
  // sweep restore it; `-q`, `--no-guess`, the other read-only switch options, and a redirection
  // around it are decoration, and any other option (`-b`, `--detach`, `--`, …) is not.
  // Fail-OPEN residuals, named: a target the guard cannot resolve (`cd` alone, `cd -`, `~`, a
  // variable, a blanked span) is an unknown candidate the walk cannot judge, though the known ones
  // beside it still are, and --git-dir/--work-tree on the invocation makes the invocation unknown;
  // `pushd` and a backslash-escaped space in a path are not modelled. On Windows a path is read as Git
  // Bash reads it, the shell Claude Code's Bash tool runs there: `/c/...` is drive C:, and any other
  // single-slash rooted path is an unresolved target, since Git Bash maps it to a folder the walk
  // cannot name (its install folder, or the user's temp folder for `/tmp`). PowerShell reads a rooted
  // path against the current drive instead; no PowerShell command reaches the guard yet, and the Codex
  // hook would hand one the same win32 context, so #1471 and #1480 own reading it as PowerShell does.
  // Fail-CLOSED residuals: a parenthesised `(cd x && …)` never relocates, because nothing would
  // restore the directory when the subshell closes, so the whole command is judged where it started;
  // `cd x || exit 1; git commit` keeps the old directory as a candidate although the exit would have
  // taken it, and so does `cd <root>; cd <worktree>; git commit`, because a `;`-chained cd is never
  // known to have succeeded. All are visible and recoverable: chain with `&&`.
  const CD_SEGMENT = /^cd(?:\s+(\S+))?(?:\s|$)/;
  const GIT_BRANCH_WORK = new RegExp(String.raw`${GIT_START}\s+((?:${GIT_OPT_WITH_ARG}|-\S+\s+)*)(commit|checkout|switch|branch|merge|cherry-pick|revert|rebase|am)(?=\s|$)(.*)$`);
  const onWindows = checkout?.platform === 'win32';
  const { isAbsolute, resolve } = onWindows ? win32 : posix;
  const relocate = (from, target) => {
    if (target === undefined) return null;
    const planted = /^␀(\d+)␀$/.exec(target);
    let path = planted ? quotedPaths[Number(planted[1])] : target;
    if (onWindows) {
      const drive = /^\/([A-Za-z])(?=\/|$)/.exec(path);
      if (drive) path = `${drive[1].toUpperCase()}:\\${path.slice(2)}`;
      else if (/^\/(?!\/)/.test(path)) return null;
    }
    if (/^[-~]|[$`]/.test(path) || (from === null && !isAbsolute(path))) return null;
    return resolve(from ?? '', path);
  };
  const isBranchWork = (subcommand, args) => {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    if (subcommand === 'branch') {
      // A revision-taking listing option (`--merged main`, `--contains <sha>`, `--list 'job/*'`) is
      // a read; only a bare branch name with none of those, and no delete flag, creates or renames.
      return tokens.some((token) => !token.startsWith('-'))
        && !tokens.some((token) => /^(?:-[A-Za-z]*[dD][A-Za-z]*|--delete|-l|--list|--merged|--no-merged|--contains|--no-contains|--points-at)$/.test(token));
    }
    // Backing out of a merge state (`--abort`/`--quit`) is recovery, not branch work, and the
    // allowed `git pull` is how the root gets into one.
    if (tokens.some((token) => token === '--abort' || token === '--quit')) return false;
    if (subcommand === 'merge') return !tokens.includes('--ff-only');
    if (subcommand !== 'checkout' && subcommand !== 'switch') return true;
    const words = args.replace(REDIRECTION, '').trim().split(/\s+/).filter(Boolean);
    const positional = words.filter((token) => !token.startsWith('-'));
    const options = words.filter((token) => token.startsWith('-'));
    return positional.join(' ') !== 'main'
      || !options.every((token) => /^(?:-q|--quiet|--guess|--no-guess|--progress|--no-progress|--ignore-other-worktrees|--no-ignore-other-worktrees|--recurse-submodules|--no-recurse-submodules)$/.test(token));
  };
  let dirs = [checkout?.cwd ?? null];
  const rootCheckoutReason = (s) => {
    const invocation = checkout ? GIT_BRANCH_WORK.exec(s) : null;
    if (!invocation) return '';
    const [, options, subcommand, args] = invocation;
    if (/(?:^|\s)--(?:git-dir|work-tree)(?:=|\s)/.test(options) || !isBranchWork(subcommand, args)) return '';
    const hops = [...options.matchAll(/(?:^|\s)-C\s+(\S+)/g)].map((hop) => hop[1]);
    const at = dirs.map((dir) => hops.reduce(relocate, dir));
    if (!at.some((dir) => dir !== null && checkout.isRootCheckout(dir))) return '';
    return `git ${subcommand} in the integration checkout: the root stays on main and nothing is branched, switched, or committed there — open a job checkout with git worktree add and run it from there`;
  };
  // A coordinated Claude job runs the merge watch only from its verified workflow version, so the delivery code that
  // runs is the version the job started on; only the one-argument cleanup stays open while a shared contract has moved on.
  // Runs and quoted spans are read on the text the quote reader reads, where a heredoc body is gone and a comment ends
  // at its newline, with a `$'...'` string read as one span through its backslash escapes. A run whose `node` sits
  // inside a quoted span holding a blank is that span's text, an argument of another command, unless a substitution in
  // a double-quoted span or in the body of a heredoc with an unquoted delimiter runs it; a quoted word alone, such as
  // `"node"`, is still the command. The scan above reads a `$'...'` string as a plain single-quoted one, so after one
  // that holds an escaped quote its comment and heredoc reading can be wrong, as for every other rule.
  const runsWatch = () => {
    const textSpans = [...deheredoc.matchAll(new RegExp(String.raw`${ESCAPED}|\$'(?:[^'\\]|\\[\s\S])*'|${QUOTED_SPAN}`, 'g'))]
      .filter((span) => span[0][0] !== '\\' && /\s/.test(span[0]));
    const inText = (at) => textSpans.some((span) => span.index < at && at < span.index + span[0].length);
    if (SYNTAX_CHECK.test(cmd.trim())) return false;
    return [...deheredoc.matchAll(MERGE_WATCH_RUN)].some((run) => !inText(run.index))
      || [...substitutedTexts, ...liveHeredocBodies.flatMap(substitutions)].some((text) => text.search(MERGE_WATCH_RUN) !== -1);
  };
  if (verifyJobPin && runsWatch()) {
    const pinned = PINNED_WATCH_RUN.exec(cmd);
    if (!pinned) return `a coordinated job runs the merge watch only as ${PINNED_WATCH}, the whole command, with plain arguments`;
    const { cause: unpinned } = pinCheck(!watchDriftAllowed(pinned[1].split(' ').slice(1)));
    if (unpinned) return `a coordinated job runs no merge watch without its verified workflow version: ${unpinned}`;
  }
  // The separator AFTER each segment is kept: the integration-checkout walk needs to know whether a
  // `cd` that fails would stop the chain (`&&`) or let it run on where it was (`;`, a newline, `||`),
  // or ran in a pipeline subshell that moved nothing (`|`). First match wins.
  const parts = sanitized.split(/(\|\||&&|[;\n|])/);
  for (let index = 0; index < parts.length; index += 2) {
    const raw = parts[index].trim();
    const s = raw.replace(/^(?:\w+=\S*\s+)+/, '');
    const after = parts[index + 1] ?? '';
    const relocation = CD_SEGMENT.exec(s);
    if (relocation && after !== '|') {
      const moved = dirs.map((dir) => relocate(dir, relocation[1]));
      dirs = [...new Set(after === '&&' ? moved : [...dirs, ...moved])];
    }
    const hit = rootCheckoutReason(s) || ruleReason(s, raw);
    if (hit) return hit;
  }
  if (recognizesWrappedPush && substitutedTexts.some(isPush)) {
    return codexHerdrUnavailable ? runUnavailable
      : 'a pre-approved run session pushes only as a plain command on its own, so the checked destination stays bound';
  }
  return substitutedReason || substitutedTexts.map(worktreeReason).find(Boolean) || '';
}

// Cleanup-specific automatic permission recognizes raw literal syntax only. Unsupported shell
// forms receive no grant; a direct job-local call is refused before any editable helper loads.
export function cleanupPermission(command, trustedCheckout) {
  if (typeof command !== 'string' || !/^[ \t]*node[ \t]+scripts\/closeout-cleanup\.mjs(?=[ \t]|$)/.test(command)) return undefined;
  if (trustedCheckout !== true) return 'deny';
  if (/^[ \t]*node[ \t]+scripts\/closeout-cleanup\.mjs(?:[ \t]+[A-Za-z0-9_./:@,+%=-]+)*[ \t]*$/.test(command)) return 'allow';
  return undefined;
}
