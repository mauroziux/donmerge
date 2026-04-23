/**
 * .donmerge configuration file handling.
 *
 * Fetches, parses, validates, and resolves a `.donmerge` YAML config
 * from a repository. Provides glob matching for exclude/include/severity rules.
 */

import { parse as parseYaml } from 'yaml';
import type { DonmergeConfig, DonmergeSkill, DonmergeResolved } from './types';

// Constants
const MAX_SKILLS = 10;
const MAX_SKILL_SIZE_BYTES = 20 * 1024; // 20KB per skill
const MAX_TOTAL_SKILLS_BYTES = 50 * 1024; // 50KB total

/**
 * Fetch and parse .donmerge config from a repo.
 * Returns null if the file doesn't exist or is invalid.
 */
export async function fetchDonmergeConfig(
  owner: string,
  repo: string,
  token: string,
  fetchFile: (owner: string, repo: string, path: string, token: string) => Promise<string | null>
): Promise<DonmergeConfig | null> {
  try {
    const content = await fetchFile(owner, repo, '.donmerge', token);
    if (!content) return null;

    const parsed = parseYaml(content);
    if (!parsed || typeof parsed !== 'object') return null;

    const validated = validateDonmergeConfig(parsed);
    return validated;
  } catch (error) {
    console.warn('[donmerge] Failed to fetch/parse .donmerge:', error);
    return null;
  }
}

/**
 * Validate a parsed .donmerge config object.
 * Lenient — unknown keys are ignored, missing fields default to empty.
 */
export function validateDonmergeConfig(raw: unknown): DonmergeConfig {
  if (!raw || typeof raw !== 'object') return {};

  const obj = raw as Record<string, unknown>;
  const config: DonmergeConfig = {};

  // Version
  if (typeof obj.version === 'string') {
    config.version = obj.version;
    if (obj.version !== '1') {
      console.warn(`[donmerge] Unknown version "${obj.version}", attempting to parse anyway`);
    }
  }

  // Exclude patterns
  if (Array.isArray(obj.exclude)) {
    config.exclude = obj.exclude.filter((p: unknown) => typeof p === 'string').map(String);
  }

  // Include patterns
  if (Array.isArray(obj.include)) {
    config.include = obj.include.filter((p: unknown) => typeof p === 'string').map(String);
  }

  // Skills
  if (Array.isArray(obj.skills)) {
    const validSkills: DonmergeSkill[] = [];
    for (const skill of obj.skills) {
      if (skill && typeof skill === 'object' && typeof skill.path === 'string') {
        validSkills.push({
          path: skill.path,
          description: typeof skill.description === 'string' ? skill.description : skill.path,
        });
        if (validSkills.length >= MAX_SKILLS) break;
      }
    }
    config.skills = validSkills;
  }

  // Instructions
  if (typeof obj.instructions === 'string') {
    config.instructions = obj.instructions;
  }

  // Severity overrides
  if (obj.severity && typeof obj.severity === 'object' && !Array.isArray(obj.severity)) {
    const severity: Record<string, 'critical' | 'suggestion' | 'low'> = {};
    const validLevels = ['critical', 'suggestion', 'low'] as const;
    for (const [pattern, level] of Object.entries(obj.severity as Record<string, unknown>)) {
      if (typeof pattern === 'string' && validLevels.includes(level as any)) {
        severity[pattern] = level as 'critical' | 'suggestion' | 'low';
      }
    }
    if (Object.keys(severity).length > 0) {
      config.severity = severity;
    }
  }

  return config;
}

/**
 * Resolve skills: fetch all skill files from the repo in parallel.
 * Tolerates individual failures.
 */
export async function resolveDonmergeSkills(
  config: DonmergeConfig,
  owner: string,
  repo: string,
  token: string,
  fetchFile: (owner: string, repo: string, path: string, token: string) => Promise<string | null>
): Promise<DonmergeResolved> {
  const skillsContent = new Map<string, string>();
  const skillsErrors = new Map<string, string>();

  if (!config.skills || config.skills.length === 0) {
    return { config, skillsContent, skillsErrors };
  }

  // Fetch all skill files in parallel
  const results = await Promise.allSettled(
    config.skills.map(async (skill) => {
      const content = await fetchFile(owner, repo, skill.path, token);
      return { skill, content };
    })
  );

  let totalBytes = 0;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const skill = config.skills[i];

    if (result.status === 'fulfilled' && result.value.content !== null) {
      const { content } = result.value;

      // Enforce size limits
      const bytes = new TextEncoder().encode(content).length;
      if (bytes > MAX_SKILL_SIZE_BYTES) {
        skillsErrors.set(skill.path, `File too large (${bytes} bytes, max ${MAX_SKILL_SIZE_BYTES})`);
        continue;
      }
      if (totalBytes + bytes > MAX_TOTAL_SKILLS_BYTES) {
        skillsErrors.set(skill.path, 'Total skills content size limit reached');
        continue;
      }

      skillsContent.set(skill.path, content);
      totalBytes += bytes;
    } else if (result.status === 'fulfilled' && result.value.content === null) {
      skillsErrors.set(skill.path, 'File not found');
    } else {
      skillsErrors.set(
        skill.path,
        result.status === 'rejected' ? String(result.reason) : 'Unknown error'
      );
    }
  }

  // Log warnings for failed skills
  for (const [path, error] of skillsErrors) {
    console.warn(`[donmerge] Skill "${path}" failed: ${error}`);
  }

  return { config, skillsContent, skillsErrors };
}

/**
 * Determine if a file should be excluded from review.
 * A file is excluded if it matches ANY exclude pattern
 * AND does not match ANY include pattern (include overrides exclude).
 */
export function shouldExcludeFile(
  filePath: string,
  excludePatterns: string[],
  includePatterns: string[]
): boolean {
  const isExcluded = excludePatterns.some(pattern => globMatch(filePath, pattern));
  if (!isExcluded) return false;

  // Include patterns override exclude
  const isIncluded = includePatterns.some(pattern => globMatch(filePath, pattern));
  return !isIncluded;
}

/**
 * Get the severity override for a file path, if any.
 * Returns null if no override applies.
 */
export function getSeverityOverride(
  filePath: string,
  severityMap?: Record<string, 'critical' | 'suggestion' | 'low'>
): 'critical' | 'suggestion' | 'low' | null {
  if (!severityMap) return null;

  for (const [pattern, severity] of Object.entries(severityMap)) {
    if (globMatch(filePath, pattern)) {
      return severity;
    }
  }
  return null;
}

/**
 * Minimal glob-to-regex matcher.
 * Supports: * (non-separator), ** (any path), ? (single non-separator).
 */
export function globMatch(filePath: string, pattern: string): boolean {
  const regexStr = globToRegex(pattern);
  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(filePath);
}

/**
 * Convert a glob pattern to a regex string.
 */
function globToRegex(pattern: string): string {
  let result = '';
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === '*') {
      // Check for **
      if (i + 1 < pattern.length && pattern[i + 1] === '*') {
        // **/ or ** at end
        if (i + 2 < pattern.length && pattern[i + 2] === '/') {
          result += '(?:.+/)?'; // **/ matches zero or more path segments
          i += 3;
        } else {
          result += '.*'; // ** at end matches everything
          i += 2;
        }
      } else {
        result += '[^/]*'; // * matches non-separator
        i += 1;
      }
    } else if (ch === '?') {
      result += '[^/]';
      i += 1;
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      result += '\\' + ch;
      i += 1;
    } else {
      result += ch;
      i += 1;
    }
  }

  return result;
}
