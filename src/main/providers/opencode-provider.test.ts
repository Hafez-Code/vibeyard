import { vi } from 'vitest';
import * as path from 'path';
import { isWin } from '../platform';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(() => { throw new Error('ENOENT'); }),
}));

vi.mock('os', () => ({
  homedir: () => '/mock/home',
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../pty-manager', () => ({
  getFullPath: vi.fn(() => isWin ? '/usr/local/bin;/usr/bin' : '/usr/local/bin:/usr/bin'),
}));

vi.mock('../opencode-config', () => ({
  getOpencodeConfig: vi.fn(async () => ({ mcpServers: [], agents: [], skills: [], commands: [] })),
}));

vi.mock('../config-watcher', () => ({
  startConfigWatcher: vi.fn(),
  stopConfigWatcher: vi.fn(),
}));

vi.mock('./agent-files', () => ({
  writeAgentFile: vi.fn(async (dir: string, slug: string, _content: string) => ({
    filePath: path.join(dir, `${slug}.md`),
  })),
  deleteAgentFile: vi.fn(async () => undefined),
}));

import * as fs from 'fs';
import { execSync } from 'child_process';
import { OpencodeProvider, _resetCachedPath } from './opencode-provider';
import { getOpencodeConfig } from '../opencode-config';
import { startConfigWatcher, stopConfigWatcher } from '../config-watcher';
import { writeAgentFile, deleteAgentFile } from './agent-files';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockStatSync = vi.mocked(fs.statSync);
const mockExecSync = vi.mocked(execSync);
const fileStat = { isFile: () => true } as fs.Stats;
const mockGetOpencodeConfig = vi.mocked(getOpencodeConfig);
const mockStartConfigWatcher = vi.mocked(startConfigWatcher);
const mockStopConfigWatcher = vi.mocked(stopConfigWatcher);
const mockWriteAgentFile = vi.mocked(writeAgentFile);
const mockDeleteAgentFile = vi.mocked(deleteAgentFile);

let provider: OpencodeProvider;

beforeEach(() => {
  vi.clearAllMocks();
  mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });
  _resetCachedPath();
  provider = new OpencodeProvider();
});

describe('meta', () => {
  it('has correct id, displayName, and binaryName', () => {
    expect(provider.meta.id).toBe('opencode');
    expect(provider.meta.displayName).toBe('OpenCode');
    expect(provider.meta.binaryName).toBe('opencode');
  });

  it('has the expected capability set', () => {
    const caps = provider.meta.capabilities;
    expect(caps.sessionResume).toBe(true);
    expect(caps.costTracking).toBe(false);
    expect(caps.contextWindow).toBe(false);
    expect(caps.hookStatus).toBe(false);
    expect(caps.configReading).toBe(true);
    expect(caps.shiftEnterNewline).toBe(false);
    expect(caps.pendingPromptTrigger).toBe('startup-arg');
    expect(caps.systemPromptInjection).toBe(false);
  });

  it('has a default context window size', () => {
    expect(provider.meta.defaultContextWindowSize).toBe(200_000);
  });
});

describe('resolveBinaryPath', () => {
  const firstCandidate = isWin
    ? path.join('/mock/home', 'AppData', 'Roaming', 'npm', 'opencode.cmd')
    : '/usr/local/bin/opencode';

  it('returns candidate path when statSync finds a file', () => {
    mockStatSync.mockImplementation((p) => {
      if (p === firstCandidate) return fileStat;
      throw new Error('ENOENT');
    });
    expect(provider.resolveBinaryPath()).toBe(firstCandidate);
  });

  it(`falls back to ${isWin ? 'where' : 'which'} opencode when no candidate exists`, () => {
    mockExecSync.mockReturnValue('/some/other/path/opencode\n' as any);
    expect(provider.resolveBinaryPath()).toBe('/some/other/path/opencode');
  });

  it('falls back to bare "opencode" when both candidate and which fail', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });
    expect(provider.resolveBinaryPath()).toBe('opencode');
  });

  it('caches result on subsequent calls', () => {
    mockStatSync.mockImplementation((p) => {
      if (p === firstCandidate) return fileStat;
      throw new Error('ENOENT');
    });
    provider.resolveBinaryPath();
    mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(provider.resolveBinaryPath()).toBe(firstCandidate);
  });
});

describe('validatePrerequisites', () => {
  const validateCandidate = isWin
    ? path.join('/mock/home', 'AppData', 'Roaming', 'npm', 'opencode.cmd')
    : '/opt/homebrew/bin/opencode';

  it('returns ok when binary found via statSync', () => {
    mockStatSync.mockImplementation((p) => {
      if (p === validateCandidate) return fileStat;
      throw new Error('ENOENT');
    });
    expect(provider.validatePrerequisites()).toBe(true);
  });

  it('returns ok when binary found via which', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue('/resolved/opencode\n' as any);
    expect(provider.validatePrerequisites()).toBe(true);
  });

  it('returns not ok when binary not found anywhere', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });
    expect(provider.validatePrerequisites()).toBe(false);
  });
});

describe('buildEnv', () => {
  it('sets PATH to the augmented PATH', () => {
    const env = provider.buildEnv('sess-123', {});
    expect(env.PATH).toBe(isWin ? '/usr/local/bin;/usr/bin' : '/usr/local/bin:/usr/bin');
  });

  it('does not set OPENCODE_CONFIG_DIR when no configDir provided', () => {
    const env = provider.buildEnv('sess-123', {});
    expect(env.OPENCODE_CONFIG_DIR).toBeUndefined();
  });

  it('sets OPENCODE_CONFIG_DIR when configDir provided (profile isolation)', () => {
    const env = provider.buildEnv('sess-123', {}, { configDir: '/cfg/work' });
    expect(env.OPENCODE_CONFIG_DIR).toBe('/cfg/work');
  });

  it('preserves existing env vars', () => {
    const env = provider.buildEnv('sess-123', { ANTHROPIC_API_KEY: 'key123', OTHER: 'val' });
    expect(env.ANTHROPIC_API_KEY).toBe('key123');
    expect(env.OTHER).toBe('val');
  });
});

describe('buildArgs', () => {
  it('returns ["--session", id] when isResume=true with cliSessionId', () => {
    const args = provider.buildArgs({ cliSessionId: 'sid-1', isResume: true, extraArgs: '' });
    expect(args).toEqual(['--session', 'sid-1']);
  });

  it('returns [] when isResume=false with cliSessionId', () => {
    const args = provider.buildArgs({ cliSessionId: 'sid-1', isResume: false, extraArgs: '' });
    expect(args).toEqual([]);
  });

  it('returns [] when cliSessionId is null', () => {
    const args = provider.buildArgs({ cliSessionId: null, isResume: false, extraArgs: '' });
    expect(args).toEqual([]);
  });

  it('appends --prompt when initialPrompt is provided', () => {
    const args = provider.buildArgs({ cliSessionId: null, isResume: false, extraArgs: '', initialPrompt: 'fix the bug' });
    expect(args).toEqual(['--prompt', 'fix the bug']);
  });

  it('does not append --prompt when initialPrompt is absent', () => {
    const args = provider.buildArgs({ cliSessionId: null, isResume: false, extraArgs: '' });
    expect(args).toEqual([]);
  });

  it('splits extraArgs on whitespace and appends', () => {
    const args = provider.buildArgs({ cliSessionId: null, isResume: false, extraArgs: '--model anthropic/claude-sonnet-4-5  --auto' });
    expect(args).toEqual(['--model', 'anthropic/claude-sonnet-4-5', '--auto']);
  });

  it('combines resume args and extra args', () => {
    const args = provider.buildArgs({ cliSessionId: 'sid-1', isResume: true, extraArgs: '--model anthropic/claude-sonnet-4-5' });
    expect(args).toEqual(['--session', 'sid-1', '--model', 'anthropic/claude-sonnet-4-5']);
  });

  it('combines resume + initialPrompt + extraArgs', () => {
    const args = provider.buildArgs({ cliSessionId: 'sid-1', isResume: true, extraArgs: '--auto', initialPrompt: 'ship it' });
    expect(args).toEqual(['--session', 'sid-1', '--prompt', 'ship it', '--auto']);
  });

  it('does not emit a system-prompt flag (OpenCode has no CLI flag for it in v1)', () => {
    const args = provider.buildArgs({ cliSessionId: null, isResume: false, extraArgs: '', systemPrompt: 'You are the CMO.' });
    expect(args).not.toContain('--system-prompt');
    expect(args).not.toContain('You are the CMO.');
  });
});

describe('getShiftEnterSequence', () => {
  it('returns null', () => {
    expect(provider.getShiftEnterSequence()).toBeNull();
  });
});

describe('settings / hooks (no-op for OpenCode)', () => {
  it('installHooks resolves without throwing', async () => {
    await expect(provider.installHooks()).resolves.toBeUndefined();
  });

  it('installStatusScripts does not throw', () => {
    expect(() => provider.installStatusScripts()).not.toThrow();
  });

  it('validateSettings returns a benign "complete" result', () => {
    expect(provider.validateSettings()).toEqual({ statusLine: 'vibeyard', hooks: 'complete', hookDetails: {} });
  });

  it('reinstallSettings does not throw', () => {
    expect(() => provider.reinstallSettings()).not.toThrow();
  });

  it('cleanup calls stopConfigWatcher', () => {
    provider.cleanup();
    expect(mockStopConfigWatcher).toHaveBeenCalled();
  });
});

describe('agents', () => {
  it('agentsDir points at ~/.config/opencode/agents', () => {
    expect(provider.agentsDir()).toBe(path.join('/mock/home', '.config', 'opencode', 'agents'));
  });

  it('installAgent delegates to writeAgentFile', async () => {
    mockWriteAgentFile.mockResolvedValueOnce({ filePath: '/mock/home/.config/opencode/agents/foo.md' });
    const res = await provider.installAgent('foo', 'body');
    expect(mockWriteAgentFile).toHaveBeenCalledWith(provider.agentsDir(), 'foo', 'body');
    expect(res.filePath).toBe('/mock/home/.config/opencode/agents/foo.md');
  });

  it('removeAgent delegates to deleteAgentFile', async () => {
    await provider.removeAgent('foo');
    expect(mockDeleteAgentFile).toHaveBeenCalledWith(provider.agentsDir(), 'foo');
  });
});

describe('other methods', () => {
  it('getConfig delegates to opencode config reader', async () => {
    const config = { mcpServers: [{ name: 'a', url: 'b', status: 'configured', scope: 'user' as const, filePath: '/x' }], agents: [], skills: [], commands: [] };
    mockGetOpencodeConfig.mockResolvedValueOnce(config);
    await expect(provider.getConfig('/some/path')).resolves.toEqual(config);
    expect(mockGetOpencodeConfig).toHaveBeenCalledWith('/some/path');
  });

  it('starts an opencode config watcher', () => {
    const win = { id: 1 } as any;
    provider.startConfigWatcher(win, '/project');
    expect(mockStartConfigWatcher).toHaveBeenCalledWith(win, '/project', 'opencode');
  });
});