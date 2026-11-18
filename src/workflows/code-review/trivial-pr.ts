/**
 * Trivial-change detection (cost control).
 *
 * A PR whose every changed file is documentation, metadata or a lockfile gets
 * no LLM review: the run completes with a neutral check run instead. An
 * explicit human request (`@donmerge` comment, focus files, Push API call)
 * always overrides the skip.
 *
 * The predicate is deterministic and conservative:
 *   - every file must match a trivial path pattern
 *   - the deterministic risk assessment (review-risk) must not be `high`
 *     — e.g. a `.github/webhook-*.yml` touch looks trivial by path but moves
 *     async delivery machinery, so it is reviewed as usual.
 */

import { assessPrRisk } from './review-risk';

/**
 * Trivial path patterns (anchored at any segment). Order is irrelevant; the
 * list is intentionally conservative — when in doubt, a path is NOT trivial.
 */
const TRIVIAL_PATH_PATTERNS: RegExp[] = [
  /(^|\/)docs\//,
  /(^|\/)[^/]*\.(md|mdx|rst|adoc|txt)$/i,
  /(^|\/)changelog/i,
  /(^|\/)license(\..*)?$/i,
  /(^|\/)notice(\..*)?$/i,
  /(^|\/)\.github\//,
  /(^|\/)\.gitignore$/,
  /(^|\/)\.gitattributes$/,
  /(^|\/)\.editorconfig$/,
  /(^|\/)\.nvmrc$/,
  /(^|\/)\.prettierignore$/,
  /(^|\/)\.eslintignore$/,
  /(^|\/)codeowners$/i,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)bun\.lockb$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)gemfile\.lock$/i,
  /(^|\/)[^/]*\.(png|jpe?g|gif|svg|ico|webp|avif)$/i,
  /(^|\/)[^/]*\.(woff2?|ttf|eot|otf)$/i,
];

export function isTrivialPath(filename: string): boolean {
  return TRIVIAL_PATH_PATTERNS.some((pattern) => pattern.test(filename));
}

export interface TrivialChangeInput {
  /** Full discovered file list of the PR (all pages). */
  files: Array<{ filename: string; patch?: string }>;
}

/**
 * True when the whole change set is trivial and safe to skip:
 * every file matches a trivial pattern and no high-risk signal fires.
 */
export function isTrivialChangeSet(input: TrivialChangeInput): boolean {
  const { files } = input;
  if (files.length === 0) return false;
  if (!files.every((file) => isTrivialPath(file.filename))) return false;
  const risk = assessPrRisk(files);
  return risk.level !== 'high';
}
