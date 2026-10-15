// The direct route admits only selected documentation records and media.
// CLI: no arguments, newline-separated Git paths on stdin; refusals exit 1.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXTENSIONS = new Set(['md', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp']);

const INSTRUCTIONS = new Set([
  'agents.md', 'claude.md', 'skill.md', 'coding-standards.md', 'testing-strategy.md',
  'design-system.md', 'issue-tracker.md', 'doc-sweep.md', 'sweep-triage.md', 'weekly-retro.md',
]);

function refusalReason(path, sharedFiles) {
  const components = path.split('/');
  // Git-quoted or malformed names are refused rather than decoded or normalized.
  // eslint-disable-next-line no-control-regex -- Git paths containing control bytes cannot be safely line-listed.
  if (/[\\\x00-\x1f\x7f-\x9f]/.test(path) || components.some((part) => !part || part.startsWith('.'))) return 'a hidden or malformed path';
  if (path !== 'docs/README.md' && !path.startsWith('docs/research/')) return 'outside the documentation locations';
  const extension = path.match(/\.([^./]+)$/)?.[1].toLowerCase();
  if (!EXTENSIONS.has(extension)) return 'not a documentation or media file type';
  const basename = components.at(-1).toLowerCase();
  if (INSTRUCTIONS.has(basename) || /^ai-workflow(?:-.*)?\.md$/.test(basename)) return 'an instruction document';
  if (sharedFiles.has(path)) return 'a shared factory file';
  return null;
}

/** The refused paths, each with its first failed rule; an empty array admits them all. */
export function docsRouteRefusals(paths, manifestPaths) {
  const sharedFiles = new Set(manifestPaths);
  return paths.flatMap((path) => {
    const reason = refusalReason(path, sharedFiles);
    return reason ? [{ path, reason }] : [];
  });
}

const MANIFEST_PATH = '.agents/factory-manifest.json';
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) {
    console.error('docs-route: expected no arguments; use the pull request route.');
    process.exit(1);
  }
  let manifestPaths;
  // A missing or invalid manifest cannot become permission to publish shared files.
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL(`../../${MANIFEST_PATH}`, import.meta.url)), 'utf8'));
    if (!Array.isArray(manifest.entries) || manifest.entries.some((entry) => typeof entry?.path !== 'string' || entry.path === '')) {
      throw new Error('its entries are not a list of paths');
    }
    manifestPaths = manifest.entries.map((entry) => entry.path);
  } catch (error) {
    console.error(`docs-route: cannot read ${MANIFEST_PATH} (${error.message}); use the pull request route.`);
    process.exit(1);
  }
  const paths = readFileSync(0, 'utf8').split('\n').filter(Boolean);
  const refusals = docsRouteRefusals(paths, manifestPaths);
  if (paths.length === 0) console.error('docs-route: no changed paths to admit.');
  for (const { path, reason } of refusals) console.error(`docs-route: refused ${path}: ${reason}.`);
  if (paths.length === 0 || refusals.length > 0) {
    console.error('docs-route: only qualifying documentation and media reach main directly; use the pull request route.');
    process.exit(1);
  }
}
