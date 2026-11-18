/**
 * Tests for trivial-pr.ts — docs/lockfile-only change sets skip the LLM review.
 */

import { describe, it, expect } from 'vitest';

import { isTrivialPath, isTrivialChangeSet } from '../trivial-pr';

describe('isTrivialPath', () => {
  it('matches docs, markdown and text files', () => {
    expect(isTrivialPath('README.md')).toBe(true);
    expect(isTrivialPath('docs/setup.md')).toBe(true);
    expect(isTrivialPath('docs/guide/install.mdx')).toBe(true);
    expect(isTrivialPath('NOTICE.txt')).toBe(true);
    expect(isTrivialPath('CHANGELOG')).toBe(true);
  });

  it('matches metadata and lockfiles', () => {
    expect(isTrivialPath('.github/workflows/ci.yml')).toBe(true);
    expect(isTrivialPath('.gitignore')).toBe(true);
    expect(isTrivialPath('package-lock.json')).toBe(true);
    expect(isTrivialPath('pnpm-lock.yaml')).toBe(true);
    expect(isTrivialPath('go.sum')).toBe(true);
    expect(isTrivialPath('LICENSE')).toBe(true);
  });

  it('matches assets and fonts', () => {
    expect(isTrivialPath('public/logo.svg')).toBe(true);
    expect(isTrivialPath('assets/banner.png')).toBe(true);
    expect(isTrivialPath('fonts/inter.woff2')).toBe(true);
  });

  it('does NOT match code or config files', () => {
    expect(isTrivialPath('src/index.ts')).toBe(false);
    expect(isTrivialPath('app/Http/Controllers/BookingController.php')).toBe(false);
    expect(isTrivialPath('package.json')).toBe(false);
    expect(isTrivialPath('eslint.config.js')).toBe(false);
    expect(isTrivialPath('docker-compose.yml')).toBe(false);
    expect(isTrivialPath('src/docs-generator.ts')).toBe(false);
    expect(isTrivialPath('README.md.bak')).toBe(false);
  });
});

describe('isTrivialChangeSet', () => {
  it('is true when every file is trivial and no high-risk signal fires', () => {
    expect(
      isTrivialChangeSet({
        files: [
          { filename: 'README.md', patch: '+ hello' },
          { filename: 'docs/architecture.md', patch: '+ diagram' },
          { filename: 'package-lock.json', patch: '+ "dep": "1.0.0"' },
        ],
      })
    ).toBe(true);
  });

  it('is false when any code file is present', () => {
    expect(
      isTrivialChangeSet({
        files: [
          { filename: 'README.md', patch: '+ hello' },
          { filename: 'src/index.ts', patch: '+ export const x = 1;' },
        ],
      })
    ).toBe(false);
  });

  it('is false when the risk assessment escalates despite trivial paths', () => {
    // `.github/webhook-*.yml` matches the async-delivery HIGH_RISK_PATH_PATTERN,
    // so a trivial-looking path that moves webhook machinery is still reviewed.
    expect(
      isTrivialChangeSet({
        files: [
          { filename: '.github/webhook-config.yml', patch: '+ queue: bookings' },
          { filename: 'docs/ci.md', patch: '+ notes' },
        ],
      })
    ).toBe(false);
  });

  it('is false for an empty file list', () => {
    expect(isTrivialChangeSet({ files: [] })).toBe(false);
  });

  it('ignores patch contents for the path rule (empty patches still count)', () => {
    expect(
      isTrivialChangeSet({
        files: [
          { filename: 'README.md' },
          { filename: 'assets/logo.svg' },
        ],
      })
    ).toBe(true);
  });
});
