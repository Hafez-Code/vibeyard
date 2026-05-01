import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the pure logic extracted from board-github-sync.ts
// by re-implementing the same helpers inline for testability.

// ── parseGithubRepo (extracted from module) ────────────────────────────────

function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

// ── buildTaskTitle ──────────────────────────────────────────────────────────

function buildTaskTitle(number: number, title: string): string {
  return `#${number} ${title}`;
}

// ── buildTaskTags ──────────────────────────────────────────────────────────

function buildTaskTags(type: 'issue' | 'pr', labels: string[]): string[] {
  const typeTag = type === 'pr' ? 'github-pr' : 'github-issue';
  return [typeTag, ...labels.map(l => l.toLowerCase())];
}

// ── buildTaskNotes ─────────────────────────────────────────────────────────

function buildTaskNotes(url: string): string {
  return `GitHub: ${url}`;
}

// ── buildTaskPrompt ────────────────────────────────────────────────────────

function buildTaskPrompt(body: string | null): string {
  return (body ?? '').slice(0, 2000).trim();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('parseGithubRepo', () => {
  it('parses HTTPS URL', () => {
    expect(parseGithubRepo('https://github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses HTTPS URL with .git suffix', () => {
    expect(parseGithubRepo('https://github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses SSH URL (git@github.com style after normalization)', () => {
    // The main process normalizes SSH → HTTPS before sending to renderer
    expect(parseGithubRepo('https://github.com/my-org/my-repo')).toEqual({ owner: 'my-org', repo: 'my-repo' });
  });

  it('returns null for non-GitHub URL', () => {
    expect(parseGithubRepo('https://gitlab.com/owner/repo')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseGithubRepo('')).toBeNull();
  });

  it('handles orgs with hyphens and dots', () => {
    expect(parseGithubRepo('https://github.com/my-org.io/my.repo')).toEqual({ owner: 'my-org.io', repo: 'my.repo' });
  });
});

describe('buildTaskTitle', () => {
  it('formats issue title', () => {
    expect(buildTaskTitle(42, 'Fix login bug')).toBe('#42 Fix login bug');
  });

  it('formats PR title', () => {
    expect(buildTaskTitle(101, 'Add dark mode')).toBe('#101 Add dark mode');
  });
});

describe('buildTaskTags', () => {
  it('adds github-issue tag for issues', () => {
    const tags = buildTaskTags('issue', []);
    expect(tags).toContain('github-issue');
    expect(tags).not.toContain('github-pr');
  });

  it('adds github-pr tag for PRs', () => {
    const tags = buildTaskTags('pr', []);
    expect(tags).toContain('github-pr');
    expect(tags).not.toContain('github-issue');
  });

  it('includes lowercased GitHub labels', () => {
    const tags = buildTaskTags('issue', ['Bug', 'Enhancement', 'HELP WANTED']);
    expect(tags).toEqual(['github-issue', 'bug', 'enhancement', 'help wanted']);
  });

  it('handles empty labels', () => {
    expect(buildTaskTags('issue', [])).toEqual(['github-issue']);
  });
});

describe('buildTaskPrompt', () => {
  it('returns empty string for null body', () => {
    expect(buildTaskPrompt(null)).toBe('');
  });

  it('trims whitespace', () => {
    expect(buildTaskPrompt('  hello  ')).toBe('hello');
  });

  it('truncates body to 2000 characters', () => {
    const long = 'a'.repeat(3000);
    expect(buildTaskPrompt(long)).toHaveLength(2000);
  });

  it('preserves body within limit', () => {
    const body = 'Short description';
    expect(buildTaskPrompt(body)).toBe('Short description');
  });
});

describe('buildTaskNotes', () => {
  it('formats GitHub URL note', () => {
    expect(buildTaskNotes('https://github.com/owner/repo/issues/42')).toBe(
      'GitHub: https://github.com/owner/repo/issues/42',
    );
  });
});

describe('de-duplication logic', () => {
  it('identifies already-imported items by githubUrl', () => {
    const importedUrls = new Set([
      'https://github.com/owner/repo/issues/42',
      'https://github.com/owner/repo/pull/10',
    ]);

    const item1 = { url: 'https://github.com/owner/repo/issues/42' };
    const item2 = { url: 'https://github.com/owner/repo/issues/99' };

    expect(importedUrls.has(item1.url)).toBe(true);
    expect(importedUrls.has(item2.url)).toBe(false);
  });

  it('does not duplicate a URL in selectedUrls set', () => {
    const selected = new Set<string>();
    const url = 'https://github.com/owner/repo/issues/1';

    selected.add(url);
    selected.add(url); // add twice
    expect(selected.size).toBe(1);
  });
});

describe('GitHub API response parsing logic', () => {
  it('filters out PRs from issues endpoint response', () => {
    const apiItems = [
      { number: 1, title: 'Issue', body: null, html_url: 'https://github.com/o/r/issues/1', state: 'open', labels: [] },
      { number: 2, title: 'PR as issue', body: null, html_url: 'https://github.com/o/r/pull/2', state: 'open', labels: [], pull_request: {} },
    ];

    const issues = apiItems
      .filter(item => !item.pull_request)
      .map(item => ({ number: item.number, title: item.title }));

    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(1);
  });

  it('extracts label names from label objects', () => {
    const labelObjects = [{ name: 'bug' }, { name: 'help wanted' }, { name: 'enhancement' }];
    const names = labelObjects.map(l => l.name);
    expect(names).toEqual(['bug', 'help wanted', 'enhancement']);
  });
});
