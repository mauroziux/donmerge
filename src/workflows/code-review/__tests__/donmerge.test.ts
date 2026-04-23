/**
 * Tests for donmerge.ts
 *
 * Covers: validateDonmergeConfig, shouldExcludeFile, globMatch,
 * getSeverityOverride, fetchDonmergeConfig, resolveDonmergeSkills.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateDonmergeConfig,
  shouldExcludeFile,
  globMatch,
  getSeverityOverride,
  fetchDonmergeConfig,
  resolveDonmergeSkills,
} from '../donmerge';
import type { DonmergeConfig, DonmergeResolved } from '../types';

// ─── validateDonmergeConfig ──────────────────────────────────────────

describe('validateDonmergeConfig', () => {
  it('should return {} for null input', () => {
    expect(validateDonmergeConfig(null)).toEqual({});
  });

  it('should return {} for undefined input', () => {
    expect(validateDonmergeConfig(undefined)).toEqual({});
  });

  it('should return {} for non-object input', () => {
    expect(validateDonmergeConfig('string')).toEqual({});
    expect(validateDonmergeConfig(42)).toEqual({});
  });

  it('should return {} for empty object', () => {
    expect(validateDonmergeConfig({})).toEqual({});
  });

  it('should preserve all valid fields in a full config', () => {
    const raw = {
      version: '1',
      exclude: ['*.generated.ts', 'dist/**'],
      include: ['dist/index.ts'],
      skills: [
        { path: 'DESIGN.md', description: 'System design' },
        { path: 'docs/API.md', description: 'API conventions' },
      ],
      instructions: 'Focus on security',
      severity: {
        'src/auth/**': 'critical',
        'src/legacy/**': 'low',
      },
    };

    const config = validateDonmergeConfig(raw);
    expect(config.version).toBe('1');
    expect(config.exclude).toEqual(['*.generated.ts', 'dist/**']);
    expect(config.include).toEqual(['dist/index.ts']);
    expect(config.skills).toEqual([
      { path: 'DESIGN.md', description: 'System design' },
      { path: 'docs/API.md', description: 'API conventions' },
    ]);
    expect(config.instructions).toBe('Focus on security');
    expect(config.severity).toEqual({
      'src/auth/**': 'critical',
      'src/legacy/**': 'low',
    });
  });

  it('should handle partial config (only exclude)', () => {
    const config = validateDonmergeConfig({ exclude: ['*.log'] });
    expect(config.exclude).toEqual(['*.log']);
    expect(config.include).toBeUndefined();
    expect(config.skills).toBeUndefined();
    expect(config.instructions).toBeUndefined();
    expect(config.severity).toBeUndefined();
  });

  it('should handle partial config (only skills)', () => {
    const config = validateDonmergeConfig({
      skills: [{ path: 'README.md', description: 'Project readme' }],
    });
    expect(config.skills).toEqual([{ path: 'README.md', description: 'Project readme' }]);
    expect(config.exclude).toBeUndefined();
  });

  it('should ignore invalid exclude (not an array)', () => {
    const config = validateDonmergeConfig({ exclude: '*.ts' });
    expect(config.exclude).toBeUndefined();
  });

  it('should filter non-string entries from exclude array', () => {
    const config = validateDonmergeConfig({ exclude: ['*.ts', 42, null, 'dist/**'] });
    expect(config.exclude).toEqual(['*.ts', 'dist/**']);
  });

  it('should filter non-string entries from include array', () => {
    const config = validateDonmergeConfig({ include: ['src/keep.ts', true, ''] });
    expect(config.include).toEqual(['src/keep.ts', '']);
  });

  it('should ignore skills if not an array', () => {
    const config = validateDonmergeConfig({ skills: 'not-an-array' });
    expect(config.skills).toBeUndefined();
  });

  it('should ignore skills entries without path', () => {
    const config = validateDonmergeConfig({
      skills: [
        { description: 'No path' },
        { path: 'VALID.md', description: 'Valid' },
        'string-entry',
        null,
      ],
    });
    expect(config.skills).toEqual([{ path: 'VALID.md', description: 'Valid' }]);
  });

  it('should default skill description to path when missing', () => {
    const config = validateDonmergeConfig({
      skills: [{ path: 'CONTRIBUTING.md' }],
    });
    expect(config.skills).toEqual([{ path: 'CONTRIBUTING.md', description: 'CONTRIBUTING.md' }]);
  });

  it('should truncate skills to max 10', () => {
    const skills = Array.from({ length: 12 }, (_, i) => ({
      path: `skill${i}.md`,
      description: `Skill ${i}`,
    }));
    const config = validateDonmergeConfig({ skills });
    expect(config.skills).toHaveLength(10);
  });

  it('should ignore unknown keys', () => {
    const config = validateDonmergeConfig({
      unknownKey: 'value',
      exclude: ['*.log'],
      anotherUnknown: 42,
    });
    expect(config.exclude).toEqual(['*.log']);
    expect((config as any).unknownKey).toBeUndefined();
    expect((config as any).anotherUnknown).toBeUndefined();
  });

  it('should log warning for version "2" but still parse config', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = validateDonmergeConfig({ version: '2', exclude: ['*.log'] });
    expect(config.version).toBe('2');
    expect(config.exclude).toEqual(['*.log']);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown version "2"')
    );
    warnSpy.mockRestore();
  });

  it('should ignore invalid severity values', () => {
    const config = validateDonmergeConfig({
      severity: {
        'src/auth/**': 'critical',
        'src/ok/**': 'invalid-severity',
        'src/low/**': 'low',
        'src/num/**': 42,
      },
    });
    expect(config.severity).toEqual({
      'src/auth/**': 'critical',
      'src/low/**': 'low',
    });
  });

  it('should ignore severity if not an object', () => {
    const config = validateDonmergeConfig({ severity: 'critical' });
    expect(config.severity).toBeUndefined();
  });

  it('should ignore severity if an array', () => {
    const config = validateDonmergeConfig({ severity: ['critical'] });
    expect(config.severity).toBeUndefined();
  });

  it('should not set severity when all entries are invalid', () => {
    const config = validateDonmergeConfig({
      severity: { 'src/**': 'invalid' },
    });
    expect(config.severity).toBeUndefined();
  });

  it('should preserve valid severity overrides including suggestion', () => {
    const config = validateDonmergeConfig({
      severity: {
        'src/auth/**': 'critical',
        'src/legacy/**': 'low',
        'src/style/**': 'suggestion',
      },
    });
    expect(config.severity).toEqual({
      'src/auth/**': 'critical',
      'src/legacy/**': 'low',
      'src/style/**': 'suggestion',
    });
  });

  it('should ignore instructions if not a string', () => {
    const config = validateDonmergeConfig({ instructions: 42 });
    expect(config.instructions).toBeUndefined();
  });

  it('should ignore version if not a string', () => {
    const config = validateDonmergeConfig({ version: 1 });
    expect(config.version).toBeUndefined();
  });
});

// ─── globMatch ───────────────────────────────────────────────────────

describe('globMatch', () => {
  it('*.ts matches foo.ts', () => {
    expect(globMatch('foo.ts', '*.ts')).toBe(true);
  });

  it('*.ts does not match src/foo.ts', () => {
    expect(globMatch('src/foo.ts', '*.ts')).toBe(false);
  });

  it('*.ts does not match foo.tsx', () => {
    expect(globMatch('foo.tsx', '*.ts')).toBe(false);
  });

  it('**/*.ts matches src/foo.ts', () => {
    expect(globMatch('src/foo.ts', '**/*.ts')).toBe(true);
  });

  it('**/*.ts matches foo.ts (zero path segments)', () => {
    expect(globMatch('foo.ts', '**/*.ts')).toBe(true);
  });

  it('**/*.ts matches a/b/c/foo.ts', () => {
    expect(globMatch('a/b/c/foo.ts', '**/*.ts')).toBe(true);
  });

  it('dist/** matches dist/foo.js', () => {
    expect(globMatch('dist/foo.js', 'dist/**')).toBe(true);
  });

  it('dist/** matches dist/a/b/c.js', () => {
    expect(globMatch('dist/a/b/c.js', 'dist/**')).toBe(true);
  });

  it('dist/** does not match src/dist/foo.js', () => {
    expect(globMatch('src/dist/foo.js', 'dist/**')).toBe(false);
  });

  it('src/legacy/** matches src/legacy/old.ts', () => {
    expect(globMatch('src/legacy/old.ts', 'src/legacy/**')).toBe(true);
  });

  it('src/legacy/** matches src/legacy/sub/deep.ts', () => {
    expect(globMatch('src/legacy/sub/deep.ts', 'src/legacy/**')).toBe(true);
  });

  it('*.generated.ts matches foo.generated.ts', () => {
    expect(globMatch('foo.generated.ts', '*.generated.ts')).toBe(true);
  });

  it('*.generated.ts does not match foo.ts', () => {
    expect(globMatch('foo.ts', '*.generated.ts')).toBe(false);
  });

  it('exact path src/auth/login.ts matches itself', () => {
    expect(globMatch('src/auth/login.ts', 'src/auth/login.ts')).toBe(true);
  });

  it('exact path does not match different file', () => {
    expect(globMatch('src/auth/other.ts', 'src/auth/login.ts')).toBe(false);
  });

  it('? matches single character: file?.ts matches file1.ts', () => {
    expect(globMatch('file1.ts', 'file?.ts')).toBe(true);
  });

  it('? does not match multiple characters: file?.ts does not match file12.ts', () => {
    expect(globMatch('file12.ts', 'file?.ts')).toBe(false);
  });

  it('? does not match zero characters', () => {
    expect(globMatch('file.ts', 'file?.ts')).toBe(false);
  });

  it('**/*.min.js matches vendor/lib.min.js', () => {
    expect(globMatch('vendor/lib.min.js', '**/*.min.js')).toBe(true);
  });

  it('**/*.min.js matches a/b/c/lib.min.js', () => {
    expect(globMatch('a/b/c/lib.min.js', '**/*.min.js')).toBe(true);
  });

  it('escapes regex special characters in pattern', () => {
    expect(globMatch('file.name.ts', 'file.name.ts')).toBe(true);
    expect(globMatch('fileXname.ts', 'file.name.ts')).toBe(false);
  });

  it('**/ matches zero or more path segments', () => {
    expect(globMatch('foo.ts', '**/foo.ts')).toBe(true);
    expect(globMatch('src/foo.ts', '**/foo.ts')).toBe(true);
    expect(globMatch('a/b/foo.ts', '**/foo.ts')).toBe(true);
  });
});

// ─── shouldExcludeFile ───────────────────────────────────────────────

describe('shouldExcludeFile', () => {
  it('should not exclude when no patterns provided', () => {
    expect(shouldExcludeFile('src/foo.ts', [], [])).toBe(false);
  });

  it('should exclude file matching exclude pattern', () => {
    expect(shouldExcludeFile('dist/bundle.js', ['dist/**'], [])).toBe(true);
  });

  it('should NOT exclude when file matches both exclude AND include', () => {
    expect(shouldExcludeFile('dist/index.ts', ['dist/**'], ['dist/index.ts'])).toBe(false);
  });

  it('include overrides exclude with glob patterns', () => {
    expect(
      shouldExcludeFile('dist/important.js', ['dist/**'], ['dist/important.*'])
    ).toBe(false);
  });

  it('should exclude when matching one of multiple exclude patterns', () => {
    expect(
      shouldExcludeFile('output.log', ['*.ts', '*.log', 'dist/**'], [])
    ).toBe(true);
  });

  it('should not exclude when no exclude pattern matches', () => {
    expect(
      shouldExcludeFile('src/app.ts', ['*.log', 'dist/**'], [])
    ).toBe(false);
  });

  it('should not exclude when include matches but exclude does not', () => {
    // If nothing is excluded, include patterns are irrelevant
    expect(
      shouldExcludeFile('src/app.ts', ['dist/**'], ['src/**'])
    ).toBe(false);
  });
});

// ─── getSeverityOverride ─────────────────────────────────────────────

describe('getSeverityOverride', () => {
  it('should return null when no severity map provided', () => {
    expect(getSeverityOverride('src/auth.ts')).toBeNull();
  });

  it('should return null for undefined severity map', () => {
    expect(getSeverityOverride('src/auth.ts', undefined)).toBeNull();
  });

  it('should return null for empty severity map', () => {
    expect(getSeverityOverride('src/auth.ts', {})).toBeNull();
  });

  it('should return severity when file matches pattern', () => {
    const map = { 'src/auth/**': 'critical' as const };
    expect(getSeverityOverride('src/auth/login.ts', map)).toBe('critical');
  });

  it('should return null when no pattern matches', () => {
    const map = { 'src/auth/**': 'critical' as const };
    expect(getSeverityOverride('src/api/users.ts', map)).toBeNull();
  });

  it('should return first match when multiple patterns match', () => {
    const map = {
      'src/**': 'suggestion' as const,
      'src/auth/**': 'critical' as const,
    };
    // Object.entries order matters — first entry wins
    expect(getSeverityOverride('src/auth/login.ts', map)).toBe('suggestion');
  });

  it('src/auth/** matches src/auth/login.ts → critical', () => {
    const map = { 'src/auth/**': 'critical' as const };
    expect(getSeverityOverride('src/auth/login.ts', map)).toBe('critical');
  });

  it('src/legacy/** matches src/legacy/old.ts → low', () => {
    const map = { 'src/legacy/**': 'low' as const };
    expect(getSeverityOverride('src/legacy/old.ts', map)).toBe('low');
  });

  it('should match exact file paths', () => {
    const map = { 'src/config.ts': 'suggestion' as const };
    expect(getSeverityOverride('src/config.ts', map)).toBe('suggestion');
    expect(getSeverityOverride('src/other.ts', map)).toBeNull();
  });
});

// ─── fetchDonmergeConfig ─────────────────────────────────────────────

describe('fetchDonmergeConfig', () => {
  const mockFetchFile = vi.fn<
    (owner: string, repo: string, path: string, token: string) => Promise<string | null>
  >();

  beforeEach(() => {
    mockFetchFile.mockReset();
  });

  it('should return parsed config when file exists with valid YAML', async () => {
    const yaml = `
version: "1"
exclude:
  - "*.log"
skills:
  - path: DESIGN.md
    description: System design
`;
    mockFetchFile.mockResolvedValueOnce(yaml);
    const config = await fetchDonmergeConfig('owner', 'repo', 'token', mockFetchFile);
    expect(config).not.toBeNull();
    expect(config!.version).toBe('1');
    expect(config!.exclude).toEqual(['*.log']);
    expect(config!.skills).toEqual([{ path: 'DESIGN.md', description: 'System design' }]);
  });

  it('should return null when file does not exist (fetchFile returns null)', async () => {
    mockFetchFile.mockResolvedValueOnce(null);
    const config = await fetchDonmergeConfig('owner', 'repo', 'token', mockFetchFile);
    expect(config).toBeNull();
  });

  it('should return null when YAML is invalid', async () => {
    mockFetchFile.mockResolvedValueOnce('invalid: [yaml: broken');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = await fetchDonmergeConfig('owner', 'repo', 'token', mockFetchFile);
    expect(config).toBeNull();
    warnSpy.mockRestore();
  });

  it('should return null when fetchFile throws', async () => {
    mockFetchFile.mockRejectedValueOnce(new Error('Network error'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = await fetchDonmergeConfig('owner', 'repo', 'token', mockFetchFile);
    expect(config).toBeNull();
    warnSpy.mockRestore();
  });

  it('should return null when YAML parses to a non-object', async () => {
    mockFetchFile.mockResolvedValueOnce('just a string');
    const config = await fetchDonmergeConfig('owner', 'repo', 'token', mockFetchFile);
    expect(config).toBeNull();
  });

  it('should pass correct arguments to fetchFile', async () => {
    mockFetchFile.mockResolvedValueOnce('version: "1"');
    await fetchDonmergeConfig('myOwner', 'myRepo', 'myToken', mockFetchFile);
    expect(mockFetchFile).toHaveBeenCalledWith('myOwner', 'myRepo', '.donmerge', 'myToken');
  });
});

// ─── resolveDonmergeSkills ───────────────────────────────────────────

describe('resolveDonmergeSkills', () => {
  const mockFetchFile = vi.fn<
    (owner: string, repo: string, path: string, token: string) => Promise<string | null>
  >();

  beforeEach(() => {
    mockFetchFile.mockReset();
  });

  it('should return empty maps when config has no skills', async () => {
    const config: DonmergeConfig = { exclude: ['*.log'] };
    const result = await resolveDonmergeSkills(config, 'owner', 'repo', 'token', mockFetchFile);
    expect(result.skillsContent.size).toBe(0);
    expect(result.skillsErrors.size).toBe(0);
    expect(result.config).toBe(config);
  });

  it('should return empty maps when skills array is empty', async () => {
    const config: DonmergeConfig = { skills: [] };
    const result = await resolveDonmergeSkills(config, 'owner', 'repo', 'token', mockFetchFile);
    expect(result.skillsContent.size).toBe(0);
    expect(result.skillsErrors.size).toBe(0);
  });

  it('should fetch skills successfully', async () => {
    const config: DonmergeConfig = {
      skills: [
        { path: 'DESIGN.md', description: 'Design doc' },
        { path: 'API.md', description: 'API doc' },
      ],
    };
    mockFetchFile
      .mockResolvedValueOnce('# Design\nSystem architecture')
      .mockResolvedValueOnce('# API\nREST endpoints');

    const result = await resolveDonmergeSkills(config, 'owner', 'repo', 'token', mockFetchFile);

    expect(result.skillsContent.get('DESIGN.md')).toBe('# Design\nSystem architecture');
    expect(result.skillsContent.get('API.md')).toBe('# API\nREST endpoints');
    expect(result.skillsErrors.size).toBe(0);
  });

  it('should add skill to errors when file not found', async () => {
    const config: DonmergeConfig = {
      skills: [{ path: 'MISSING.md', description: 'Not found' }],
    };
    mockFetchFile.mockResolvedValueOnce(null);

    const result = await resolveDonmergeSkills(config, 'owner', 'repo', 'token', mockFetchFile);
    expect(result.skillsContent.size).toBe(0);
    expect(result.skillsErrors.get('MISSING.md')).toBe('File not found');
  });

  it('should add skill to errors when file exceeds 20KB', async () => {
    const config: DonmergeConfig = {
      skills: [{ path: 'LARGE.md', description: 'Too big' }],
    };
    // Create a string > 20KB
    const largeContent = 'x'.repeat(21 * 1024);
    mockFetchFile.mockResolvedValueOnce(largeContent);

    const result = await resolveDonmergeSkills(config, 'owner', 'repo', 'token', mockFetchFile);
    expect(result.skillsContent.size).toBe(0);
    expect(result.skillsErrors.get('LARGE.md')).toContain('too large');
  });

  it('should handle partial success (some skills fail)', async () => {
    const config: DonmergeConfig = {
      skills: [
        { path: 'GOOD.md', description: 'Good' },
        { path: 'BAD.md', description: 'Bad' },
      ],
    };
    mockFetchFile
      .mockResolvedValueOnce('Good content')
      .mockResolvedValueOnce(null); // File not found

    const result = await resolveDonmergeSkills(config, 'owner', 'repo', 'token', mockFetchFile);
    expect(result.skillsContent.get('GOOD.md')).toBe('Good content');
    expect(result.skillsErrors.get('BAD.md')).toBe('File not found');
  });

  it('should add skill to errors when total content exceeds 50KB', async () => {
    const config: DonmergeConfig = {
      skills: [
        { path: 'A.md', description: 'Big A' },
        { path: 'B.md', description: 'Big B' },
        { path: 'C.md', description: 'Big C' },
        { path: 'D.md', description: 'Big D' },
        { path: 'E.md', description: 'Big E' },
        { path: 'F.md', description: 'Should overflow' },
      ],
    };
    // Each file is ~9KB (under 20KB per-file limit), but 6 × 9KB = ~54KB total → exceeds 50KB
    const content9k = 'a'.repeat(9 * 1024);

    mockFetchFile
      .mockResolvedValueOnce(content9k)  // A: 9KB, total=9KB ✓
      .mockResolvedValueOnce(content9k)  // B: 9KB, total=18KB ✓
      .mockResolvedValueOnce(content9k)  // C: 9KB, total=27KB ✓
      .mockResolvedValueOnce(content9k)  // D: 9KB, total=36KB ✓
      .mockResolvedValueOnce(content9k)  // E: 9KB, total=45KB ✓
      .mockResolvedValueOnce(content9k); // F: 9KB, total would be 54KB > 50KB → error

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await resolveDonmergeSkills(config, 'owner', 'repo', 'token', mockFetchFile);

    // First 5 should succeed (9KB * 5 = 45KB)
    expect(result.skillsContent.has('A.md')).toBe(true);
    expect(result.skillsContent.has('B.md')).toBe(true);
    expect(result.skillsContent.has('C.md')).toBe(true);
    expect(result.skillsContent.has('D.md')).toBe(true);
    expect(result.skillsContent.has('E.md')).toBe(true);
    // Sixth should fail (45KB + 9KB = 54KB > 50KB)
    expect(result.skillsContent.has('F.md')).toBe(false);
    expect(result.skillsErrors.get('F.md')).toContain('size limit');
    warnSpy.mockRestore();
  });

  it('should handle fetch rejection gracefully', async () => {
    const config: DonmergeConfig = {
      skills: [{ path: 'ERROR.md', description: 'Will error' }],
    };
    mockFetchFile.mockRejectedValueOnce(new Error('Network failure'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await resolveDonmergeSkills(config, 'owner', 'repo', 'token', mockFetchFile);

    expect(result.skillsContent.size).toBe(0);
    expect(result.skillsErrors.get('ERROR.md')).toContain('Network failure');
    warnSpy.mockRestore();
  });
});
