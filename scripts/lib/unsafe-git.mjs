// unsafe-git.mjs — the pure decision logic behind .claude/hooks/block-unsafe-git.mjs and
// .codex/hooks/block-unsafe-git.mjs (the PreToolUse(Bash) guards). Extracted so the rules get unit
// test coverage; each hook stays a thin stdin/stderr/exit-code shell around blockReason().
//
// Ten plain rules, judged on the actual command segments of an agent's shell call:
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
//   gh pr create (no --draft)-> skips the draft review before the metered suite
//   gh pr merge              -> only `gh pr merge --auto --squash --delete-branch <number>`, alone
//                                in its segment, is allowed: an admin token merges regardless of
//                                checks, and --auto lets GitHub merge only once the required test
//                                check is green
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
// capitalised `gh`). They also read four shapes the other rules leave alone: an invocation glued to
// a lone `&` or `|&`, one that follows a shell comment or arithmetic holding a `<<word` or a quote
// character, one in a command substitution inside a double-quoted span, where a backslash-escaped
// `$(` or backtick is text and opens or closes nothing, and one whose `gh`, `pr`, `merge` or
// `ready` word is quoted, which is seen and refused even when the rest of the segment is the
// delivery form. Residuals, none of which matches the two `gh` allow rules: a `sh -c` or other
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
import { posix, win32 } from 'node:path';

// Returns a reason string when `cmd` should be blocked, or "" when it's allowed. `checkout` is the
// hook's working-directory context, `{ cwd, isRootCheckout(dir), platform }`, whose platform picks the
// path rules the walk resolves with; without it the root-checkout rule is not judged, and every other
// rule is unchanged.
export function blockReason(cmd, checkout) {
  cmd = cmd ?? "";
  // Widen each letter of a name to its own class rather than using a regex `i` flag, which would
  // also loosen every option match in the same expression (`-F` for `-f`, `-D` for `-d`).
  const ci = (name) => [...name].map((ch) => (/[a-z]/.test(ch) ? `[${ch.toUpperCase()}${ch}]` : ch)).join('');
  // An odd run of backslashes before a character escapes it; an even run is literal backslashes.
  const escapedAt = (text, at) => {
    let run = 0;
    while (text[at - 1 - run] === '\\') run += 1;
    return run % 2 === 1;
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
  // re-enter.
  const HEREDOC_OPERATOR = /^<<-?[ \t]*(['"]?)(\w+)\1/;
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
          pending.push(operator[2]);
          out += '<<HEREDOC';
          index += operator[0].length;
          continue;
        }
      }
      out += ch;
      index += 1;
      if (ch === '\n' && !inSingle && !inDouble && pending.length) {
        for (const word of pending) {
          const hit = new RegExp('^[ \\t]*' + word + '[ \\t]*\\r?$', 'm').exec(cmd.slice(index));
          if (!hit) break;
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
  // Merge and ready are detected anywhere in the segment (after a wrapper, glued to a lone `&`,
  // inside an unquoted `$(` or backticks), then the whole segment, before assignment stripping, must
  // be the delivery form.
  const GH_PR_MERGE = new RegExp(String.raw`(?:^|[\s(\`&])${GH_EXEC}\s+(?:${GH_REPO_OPT})*pr\s+(?:${GH_REPO_OPT})*merge\b`);
  const GH_PR_READY = new RegExp(String.raw`(?:^|[\s(\`&])${GH_EXEC}\s+(?:${GH_REPO_OPT})*pr\s+(?:${GH_REPO_OPT})*ready\b`);
  const REASON_MERGE = "gh pr merge: only the delivery form `gh pr merge --auto --squash --delete-branch <number>`, alone in its command segment, is allowed; --auto lets GitHub merge once the required test check is green, and because the allow list runs that prefix unprompted anything else in the segment (--admin, a reordered or missing flag, a quoted, substituted or variable word, a wrapper) is refused";
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
  // Two readings serve the merge and ready rules alone. Quote removal makes `"merge"` the word
  // `merge`, so a quoted span that is exactly one of their four command words is unquoted first,
  // and left followed by a space the command never held: the rules see the invocation, and its
  // segment can never be the exact delivery text, so it is refused. No other quoted word is
  // unquoted, because a quoted `--draft` or `--force` is data. And a double-quoted span
  // runs only what its `$(…)`, read to the matching `)`, or its backtick pair holds, a
  // backslash-escaped `$(` or backtick being text that opens or closes neither, so a merge or ready
  // invocation in that substituted text is live and its reason is kept for the end of the segment
  // walk, while the rest of the span stays data; a span carrying a heredoc operator is a message
  // body and is left as data.
  let substitutedReason = '';
  const quotedPaths = [];
  const ESCAPED = String.raw`\\[\s\S]`;
  const QUOTED_SPAN = String.raw`'[^']*'|"(?:[^"\\]|\\[\s\S])*"`;
  const WORD_PIECE = String.raw`${ESCAPED}|${QUOTED_SPAN}|[^\s;&|<>()]`;
  const payloadKeyed = deheredoc.replace(new RegExp(String.raw`${ESCAPED}|(?<=^|[\s(\`&;|])(${CONFIG_PARAMETERS_NAME}=)((?:${WORD_PIECE})*)|${QUOTED_SPAN}`, 'g'), (match, name, value) => {
    if (name === undefined) return match;
    const payload = value.replace(new RegExp(WORD_PIECE, 'g'), (piece) => (piece.length === 1 ? piece : piece[0] === '\\' ? piece[1] : piece.slice(1, -1)));
    return HOLDS_HOOKS_PATH_ENTRY.test(payload) ? `${name}core.hooksPath` : match;
  });
  const wordsUnquoted = payloadKeyed.replace(/\\[\s\S]|(['"])(gh|pr|merge|ready)\1/g, (match, quote, word) => (word ? `${word} ` : match));
  const sanitized = wordsUnquoted.replace(new RegExp(String.raw`${ESCAPED}|${QUOTED_SPAN}`, 'g'), (span, offset, whole) => {
    if (span[0] === '\\') return span;
    if (span[0] === '"' && !span.includes('<<')) {
      const body = span.slice(1, -1);
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
        const text = body.slice(start, end);
        substitutedReason ||= (GH_PR_MERGE.test(text) && REASON_MERGE) || (GH_PR_READY.test(text) && REASON_READY) || '';
        index = end;
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
  const GIT_FILTER_BRANCH = new RegExp(String.raw`${GIT_INVOCATION_PREFIX}filter-branch\b`);
  const GH_PR_CREATE = new RegExp(String.raw`^${GH_EXEC}\s+(?:${GH_REPO_OPT})*pr\s+(?:${GH_REPO_OPT})*create\b`);
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
  const ruleReason = (s, raw) => {
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
      return "gh pr create without --draft skips the draft review: open it as a draft (--draft/-d) so Greptile reviews it before CI runs";
    }
    // Auto-merge is GitHub's own wait-for-green: the agent's owner-authorised merge is queued, never
    // forced. The allow list runs these two prefixes unprompted, so only the exact forms pass.
    if (GH_PR_MERGE.test(s) && !DELIVERY_MERGE.test(raw)) {
      return REASON_MERGE;
    }
    if (GH_PR_READY.test(s) && !DELIVERY_READY.test(raw)) {
      return REASON_READY;
    }
    return '';
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
  return substitutedReason;
}
