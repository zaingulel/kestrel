// sweep-scope-evaluate.mjs — Git reads and verdict formatting for one explicitly named checkout.
// Parser and programmer exceptions propagate; only Git failures become nonzero verdicts.

import { spawnSync } from 'node:child_process';
import {
  addedNetworkTokens, hiddenDestinationShapes, markupDifference, outOfScope, parseMayEdit, renderedDestinations,
  tokenMatches, treeGrepArgs, treeGrepCandidates,
} from './sweep-scope.mjs';

class GitFailure extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function evaluateSweepScope(base, head, cwd) {
  try {
    // Every refusal line and the git failure line are written through this, with each control character
    // spelled `\uXXXX`, so no pull-request byte reaches the log as a control character whichever message
    // quotes it, and ordinary text reads exactly as written.
    // eslint-disable-next-line no-control-regex -- matching control characters is the helper's whole purpose
    const printable = (text) => text.replace(/[\x00-\x1f\x7f-\x9f]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);

    function git(...args) {
      const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8' });
      if (result.status !== 0) {
        throw new GitFailure(result.status ?? 1,
          printable(`sweep-scope: git ${args.join(' ')} failed: ${result.stderr.trim()}`));
      }
      return result.stdout;
    }

    for (const commit of [base, head]) git('rev-parse', '--verify', '--quiet', `${commit}^{commit}`);
    // Two-dot `base head` would report every commit `main` gained after the branch point as if the
    // branch had made it; the merge base isolates the branch's own changes.
    const from = git('merge-base', base, head).trim();
    const at = base.slice(0, 12);

    const mayEdit = parseMayEdit(git('show', `${base}:docs/DOC-SWEEP.md`));
    const failures = [];

    // The sweep repairs existing documents: a modification is the only change it may make. A status of
    // `M` names one path; every other status (added, deleted, renamed, copied, type-changed) is refused
    // with every path it names.
    const modified = [];
    for (const entry of git('diff', '--name-status', from, head).split('\n').filter(Boolean)) {
      const [status, ...paths] = entry.split('\t');
      if (status === 'M') modified.push(paths[0]);
      else failures.push(`${paths.join(' -> ')} is ${status.startsWith('R') ? 'renamed' : status === 'A' ? 'added' : status === 'D' ? 'deleted' : `status ${status}`}; the sweep only modifies existing documents`);
    }
    const outside = new Set(outOfScope(modified, mayEdit));
    for (const path of outside) {
      failures.push(`${path} is not in the may-edit column of docs/DOC-SWEEP.md at ${at}`);
    }

    // Whether the base tree vouches for one destination or token. A fixed-string hit is only a candidate
    // line: `tokenMatches` settles whether the tree carries it whole or merely inside a longer one.
    // `--null` separates git's `<rev>:<path>` prefix from the line itself.
    function knownInTree(text) {
      const treeLines = [];
      for (const candidate of treeGrepCandidates(text)) {
        const found = spawnSync('git', treeGrepArgs(candidate, base), { cwd, encoding: 'utf8' });
        if (found.status !== 0 && found.status !== 1) {
          throw new GitFailure(found.status ?? 1, `sweep-scope: git grep failed: ${found.stderr.trim()}`);
        }
        for (const line of found.stdout.split('\n').filter(Boolean)) treeLines.push(line.slice(line.indexOf('\0') + 1));
      }
      return tokenMatches(text, treeLines);
    }

    // `--text`: a NUL, or any byte that makes git guess binary, would otherwise hide every added line from both halves.
    const tokens = addedNetworkTokens(git('diff', '--text', from, head));
    for (const token of tokens) {
      if (!knownInTree(token)) {
        failures.push(`${token} is added by this diff and is not a whole token anywhere in the tree at ${at}`);
      }
    }

    // A refusal names the destination as the document spells it and as a browser would resolve it; one the
    // URL parser could not read has only the spelling.
    const shown = ({ text, href }) => (href === null ? text : `${text} (${href})`);
    // A slice of a page as one bounded, quoted log fragment; any control character JSON leaves raw is
    // escaped by the output step.
    const clipped = (slice) => {
      const text = JSON.stringify(slice);
      return text.length > 120 ? `${text.slice(0, 120)}…[truncated]` : text;
    };

    // What is judged per document, so every refusal names the file to open. Only a modified path is
    // judged: every other status is refused whole above, whatever its content says.
    const newlyRendered = [];
    for (const path of modified) {
      for (const { line, rule, fragment } of hiddenDestinationShapes(git('diff', '--text', from, head, '--', path))) {
        failures.push(`${path}: ${rule} refuses ${fragment} on the added line: ${clipped(line)}`);
      }
      if (outside.has(path)) continue;
      // A page a browser loads raw may change only in its free text. It is compared against the tip of
      // `main`, not the merge base, so a squash cannot bring back markup `main` changed after the branch
      // point; the cost is a refusal until the branch is rebased, which the line says.
      if (path.endsWith('.html')) {
        const difference = markupDifference(git('show', `${base}:${path}`), git('show', `${head}:${path}`));
        if (difference) {
          failures.push(`${path}: the edit changes the page's markup, not only its text; at offset ${difference.index} of its markup, ` +
            `${clipped(difference.before)} became ${clipped(difference.after)}; ` +
            'if main changed the page\'s markup since this branch was cut, rebase onto main first');
        }
        continue;
      }
      // The semantic half needs a document to render; one that is neither Markdown nor HTML cannot be
      // judged by it, so it fails closed rather than passing half-judged.
      if (!path.endsWith('.md')) {
        failures.push(`${path} is in the may-edit column but is not Markdown, so the rendered half cannot judge it`);
        continue;
      }
      // The set doubles as the record of what has been accounted for, so one destination rendered twice in
      // the after document is one report.
      const rendered = new Set(renderedDestinations(git('show', `${base}:${path}`)).map((record) => record.text));
      for (const record of renderedDestinations(git('show', `${head}:${path}`))) {
        // Nothing can vouch for a destination no reader can resolve, so it is refused however old it is.
        if (record.problem) {
          failures.push(`${path}: the rendered destination ${shown(record)} is refused (${record.problem})`);
          continue;
        }
        if (rendered.has(record.text)) continue;
        rendered.add(record.text);
        newlyRendered.push(record);
        if (!knownInTree(record.text)) {
          failures.push(`${path}: the newly rendered destination ${shown(record)} is not a whole token anywhere in the tree at ${at}`);
        }
      }
    }

    if (failures.length > 0) {
      return {
        status: 1,
        stdout: '',
        stderr: 'sweep-scope: the sweep left its scope; nothing lands until the diff is confined to it:\n' +
          failures.map((failure) => `  ${printable(failure)}\n`).join(''),
      };
    }

    return {
      status: 0,
      stdout: `sweep-scope: ${modified.length} modified path${modified.length === 1 ? '' : 's'}, all in the may-edit column; ` +
        `${tokens.length} network token${tokens.length === 1 ? '' : 's'} added, all already in the tree; ` +
        `${newlyRendered.length} newly rendered destination(s), all already in the tree\n`,
      stderr: '',
    };
  } catch (error) {
    if (!(error instanceof GitFailure)) throw error;
    return { status: error.status, stdout: '', stderr: `${error.message}\n` };
  }
}
