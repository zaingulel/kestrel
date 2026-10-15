// The installer and installed contract share these string-only shape checks. Inputs are read as supplied;
// carriage-return section endings and a section heading at end-of-file are refused rather than normalized.

export const MANUAL_LIMIT = 32768;

const TAIL_HEADINGS = ['Product', 'Hard constraints', 'Architecture seams', 'Surfaces'];
const SURFACE_ROWS = ['plan-first', 'owner-directed', 'sign-off', 'security review', 'hard to undo', 'wide reach'];
const PROFILE_HEADINGS = ['Product', 'Architecture seams', 'Grounding', 'Conventions'];
const PROFILE_ROWS = ['generated artifacts', 'visual verification', 'fixtures', 'documentation routines'];

const headingsOf = (text) => [...text.matchAll(/^## (.*)$/gm)].map((match) => match[1]);
const sectionOf = (text, heading) =>
  text.match(new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'))?.[1];
const tableRowNames = (sectionText) => sectionText
  .split('\n')
  .filter((line) => line.startsWith('|'))
  .slice(2)
  .map((line) => line.split('|')[1].trim());

export function productTailShapeProblem(product) {
  const headings = headingsOf(product);
  if (headings.join('\n') !== TAIL_HEADINGS.join('\n')) {
    return `after the shared section it must hold exactly the headings ${TAIL_HEADINGS.join(', ')}, in that order; it holds ${headings.join(', ') || 'none'}.`;
  }
  const surfaces = sectionOf(product, 'Surfaces');
  if (surfaces === undefined) {
    return 'The Surfaces heading must end its line with a line feed and stand above its table: the installed test reads neither carriage-return line endings nor a heading that ends the file.';
  }
  const rows = tableRowNames(surfaces);
  if (rows.join('\n') !== SURFACE_ROWS.join('\n')) {
    return `its Surfaces table must hold exactly the rows ${SURFACE_ROWS.join(', ')}, in that order; it holds ${rows.join(', ') || 'none'}.`;
  }
  return undefined;
}

export function profileShapeProblem(profile) {
  const headings = headingsOf(profile);
  if (headings.join('\n') !== PROFILE_HEADINGS.join('\n')) {
    return `The profile must hold exactly the headings ${PROFILE_HEADINGS.join(', ')}, in that order; it holds ${headings.join(', ') || 'none'}.`;
  }
  const conventions = sectionOf(profile, 'Conventions');
  if (conventions === undefined) {
    return 'The Conventions heading must end its line with a line feed and stand above its table: the installed test reads neither carriage-return line endings nor a heading that ends the file.';
  }
  const rows = tableRowNames(conventions);
  if (rows.join('\n') !== PROFILE_ROWS.join('\n')) {
    return `The Conventions table must hold exactly the rows ${PROFILE_ROWS.join(', ')}, in that order; it holds ${rows.join(', ') || 'none'}.`;
  }
  return undefined;
}
