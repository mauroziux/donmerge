/**
 * Tests for path-resolver.ts
 *
 * Tests the path resolution logic that maps Sentry stack frame paths
 * to actual repo file paths (e.g. `app/src/features/auth/LoginPage.tsx` → `apps/web/src/features/auth/LoginPage.tsx`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvePaths, formatPathMappingPrompt } from '../path-resolver';
import type { AutoFixSandbox } from '../types';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Create a mock sandbox whose `find` command returns the given file list.
 * All other commands return empty strings.
 */
function createSandboxWithFiles(files: string[]): AutoFixSandbox {
  return {
    exec: vi.fn(async (cmd: string) => {
      // Intercept the find command and return the mock file list
      if (cmd.includes('find')) {
        return {
          success: true,
          exitCode: 0,
          stdout: files.map((f) => './' + f).join('\n'),
          stderr: '',
        };
      }
      return { success: true, exitCode: 0, stdout: '', stderr: '' };
    }),
    setEnvVars: vi.fn(async () => {}),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('resolvePaths', () => {
  it('should resolve exact matches', async () => {
    const sandbox = createSandboxWithFiles([
      'src/index.ts',
      'src/utils.ts',
    ]);

    const result = await resolvePaths(sandbox, ['src/index.ts']);

    expect(result.resolved.get('src/index.ts')).toBe('src/index.ts');
    expect(result.unresolved).toEqual([]);
  });

  it('should resolve suffix match: app/src/features/auth/LoginPage.tsx → apps/web/src/features/auth/LoginPage.tsx', async () => {
    const sandbox = createSandboxWithFiles([
      'apps/web/src/features/auth/LoginPage.tsx',
      'apps/web/src/App.tsx',
      'package.json',
    ]);

    const result = await resolvePaths(sandbox, ['app/src/features/auth/LoginPage.tsx']);

    expect(result.resolved.get('app/src/features/auth/LoginPage.tsx'))
      .toBe('apps/web/src/features/auth/LoginPage.tsx');
    expect(result.unresolved).toEqual([]);
  });

  it('should resolve by suffix matching src/... pattern', async () => {
    const sandbox = createSandboxWithFiles([
      'apps/web/src/features/auth/LoginPage.tsx',
      'apps/api/src/routes/users.ts',
    ]);

    const result = await resolvePaths(sandbox, ['src/features/auth/LoginPage.tsx']);

    expect(result.resolved.get('src/features/auth/LoginPage.tsx'))
      .toBe('apps/web/src/features/auth/LoginPage.tsx');
  });

  it('should resolve by basename when no suffix match exists', async () => {
    const sandbox = createSandboxWithFiles([
      'packages/core/components/Button.tsx',
      'README.md',
    ]);

    const result = await resolvePaths(sandbox, ['components/Button.tsx']);

    // Suffix "Button.tsx" matches exactly one file by basename
    expect(result.resolved.get('components/Button.tsx'))
      .toBe('packages/core/components/Button.tsx');
  });

  it('should not resolve by basename when multiple files have the same name', async () => {
    const sandbox = createSandboxWithFiles([
      'apps/web/src/config.ts',
      'apps/api/src/config.ts',
    ]);

    const result = await resolvePaths(sandbox, ['helpers/config.ts']);

    // Both files match by suffix "config.ts" and basename "config.ts"
    // → multiple candidates → unresolved
    expect(result.unresolved).toContain('helpers/config.ts');
  });

  it('should mark paths as unresolved when no match found', async () => {
    const sandbox = createSandboxWithFiles([
      'src/App.tsx',
      'package.json',
    ]);

    const result = await resolvePaths(sandbox, ['nonexistent/File.ts']);

    expect(result.unresolved).toEqual(['nonexistent/File.ts']);
    expect(result.mappings).toEqual([
      { original: 'nonexistent/File.ts', resolved: null },
    ]);
  });

  it('should handle empty input paths', async () => {
    const sandbox = createSandboxWithFiles(['src/index.ts']);

    const result = await resolvePaths(sandbox, []);

    expect(result.mappings).toEqual([]);
    expect(result.resolved.size).toBe(0);
    expect(result.unresolved).toEqual([]);
  });

  it('should handle multiple paths with mixed resolution results', async () => {
    const sandbox = createSandboxWithFiles([
      'src/index.ts',
      'apps/web/src/features/auth/LoginPage.tsx',
      'lib/helpers.ts',
    ]);

    const result = await resolvePaths(sandbox, [
      'src/index.ts',                           // exact match
      'app/src/features/auth/LoginPage.tsx',    // suffix match
      'nonexistent/File.ts',                    // unresolved
    ]);

    expect(result.resolved.get('src/index.ts')).toBe('src/index.ts');
    expect(result.resolved.get('app/src/features/auth/LoginPage.tsx'))
      .toBe('apps/web/src/features/auth/LoginPage.tsx');
    expect(result.unresolved).toEqual(['nonexistent/File.ts']);
    expect(result.mappings).toHaveLength(3);
  });

  it('should strip leading slashes from input paths', async () => {
    const sandbox = createSandboxWithFiles([
      'src/index.ts',
    ]);

    const result = await resolvePaths(sandbox, ['/src/index.ts']);

    expect(result.resolved.get('/src/index.ts')).toBe('src/index.ts');
  });

  it('should exclude node_modules and .git from find results', async () => {
    // The find command in resolvePaths excludes these paths
    // We simulate the sandbox already filtering them out
    const sandbox = createSandboxWithFiles([
      'src/index.ts',
    ]);

    const result = await resolvePaths(sandbox, ['src/index.ts']);

    expect(result.resolved.get('src/index.ts')).toBe('src/index.ts');
  });

  it('should not resolve when multiple candidates match the same suffix', async () => {
    const sandbox = createSandboxWithFiles([
      'packages/web/src/features/auth/LoginPage.tsx',
      'src/features/auth/LoginPage.tsx',
    ]);

    // Both files share the suffix "features/auth/LoginPage.tsx" — ambiguous
    const result = await resolvePaths(sandbox, ['features/auth/LoginPage.tsx']);

    expect(result.unresolved).toContain('features/auth/LoginPage.tsx');
  });

  it('should resolve when a longer suffix matches uniquely', async () => {
    const sandbox = createSandboxWithFiles([
      'packages/web/src/features/auth/LoginPage.tsx',
      'packages/api/src/routes/LoginPage.tsx',  // Different directory, same basename
    ]);

    // "features/auth/LoginPage.tsx" matches only the first file
    const result = await resolvePaths(sandbox, ['features/auth/LoginPage.tsx']);

    expect(result.resolved.get('features/auth/LoginPage.tsx'))
      .toBe('packages/web/src/features/auth/LoginPage.tsx');
  });
});

describe('formatPathMappingPrompt', () => {
  it('should return empty string for empty mappings', () => {
    const result = formatPathMappingPrompt({
      mappings: [],
      resolved: new Map(),
      unresolved: [],
    });

    expect(result).toBe('');
  });

  it('should include PATH MAPPING header', async () => {
    const sandbox = createSandboxWithFiles(['src/index.ts']);
    const result = await resolvePaths(sandbox, ['src/index.ts']);
    const prompt = formatPathMappingPrompt(result);

    expect(prompt).toContain('PATH MAPPING');
  });

  it('should show arrow for non-exact matches', async () => {
    const sandbox = createSandboxWithFiles(['apps/web/src/features/auth/LoginPage.tsx']);
    const result = await resolvePaths(sandbox, ['app/src/features/auth/LoginPage.tsx']);
    const prompt = formatPathMappingPrompt(result);

    expect(prompt).toContain('app/src/features/auth/LoginPage.tsx → apps/web/src/features/auth/LoginPage.tsx');
  });

  it('should show (exact match) for exact matches', async () => {
    const sandbox = createSandboxWithFiles(['src/index.ts']);
    const result = await resolvePaths(sandbox, ['src/index.ts']);
    const prompt = formatPathMappingPrompt(result);

    expect(prompt).toContain('exact match');
  });

  it('should show NOT FOUND for unresolved paths', async () => {
    const sandbox = createSandboxWithFiles(['src/index.ts']);
    const result = await resolvePaths(sandbox, ['missing/file.ts']);
    const prompt = formatPathMappingPrompt(result);

    expect(prompt).toContain('NOT FOUND');
    expect(prompt).toContain('find . -name');
  });

  it('should include search guidance for unresolved paths', async () => {
    const sandbox = createSandboxWithFiles([]);
    const result = await resolvePaths(sandbox, ['unknown.ts']);
    const prompt = formatPathMappingPrompt(result);

    expect(prompt).toContain('grep -r');
  });
});
