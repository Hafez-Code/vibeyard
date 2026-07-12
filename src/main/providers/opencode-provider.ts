import * as path from 'path';
import * as os from 'os';
import type { CliProvider } from './provider';
import type { CliProviderMeta, ProviderConfig, SettingsValidationResult } from '../../shared/types';
import { getFullPath } from '../pty-manager';
import { resolveBinary, validateBinaryExists } from './resolve-binary';
import { getOpencodeConfig } from '../opencode-config';
import { startConfigWatcher as startConfigWatch, stopConfigWatcher as stopConfigWatch } from '../config-watcher';
import { writeAgentFile, deleteAgentFile } from './agent-files';
import type { BrowserWindow } from 'electron';

const binaryCache = { path: null as string | null };

/**
 * OpenCode CLI provider.
 *
 * OpenCode (https://opencode.ai) is an interactive TUI coding agent. When
 * spawned without a subcommand it launches the TUI, which is what Vibeyard
 * wraps. Resume: `--session <id>` (or `--continue` for "last"). Initial
 * prompt: `--prompt <text>`. Config dir override: `OPENCODE_CONFIG_DIR`.
 * Agents live in `~/.config/opencode/agents/` as `<slug>.md`.
 *
 * v1 scope: session resume, initial prompt, extra args, config-dir-based
 * profiles, agent install/remove, and config (MCP + agents) reading. Cost
 * tracking and on-disk transcript indexing are not yet wired — OpenCode
 * stores sessions in a SQLite DB (see `opencode db path`) which requires a
 * heavier reader than the JSONL/JSON walk the other providers use.
 */
export class OpencodeProvider implements CliProvider {
  readonly meta: CliProviderMeta = {
    id: 'opencode',
    displayName: 'OpenCode',
    binaryName: 'opencode',
    capabilities: {
      sessionResume: true,
      costTracking: false,
      contextWindow: false,
      hookStatus: false,
      configReading: true,
      shiftEnterNewline: false,
      pendingPromptTrigger: 'startup-arg',
      systemPromptInjection: false,
    },
    defaultContextWindowSize: 200_000,
  };

  resolveBinaryPath(): string {
    return resolveBinary('opencode', binaryCache);
  }

  validatePrerequisites(): boolean {
    return validateBinaryExists('opencode');
  }

  buildEnv(_sessionId: string, baseEnv: Record<string, string>, opts?: { configDir?: string }): Record<string, string> {
    const env = { ...baseEnv };
    env.PATH = getFullPath();
    // A managed profile isolates everything OpenCode reads/writes
    // (auth, opencode.json, agents, commands) into one directory.
    if (opts?.configDir) {
      env.OPENCODE_CONFIG_DIR = opts.configDir;
    }
    return env;
  }

  buildArgs(opts: { cliSessionId: string | null; isResume: boolean; extraArgs: string; initialPrompt?: string; systemPrompt?: string }): string[] {
    const args: string[] = [];
    if (opts.isResume && opts.cliSessionId) {
      args.push('--session', opts.cliSessionId);
    }
    if (opts.initialPrompt) {
      args.push('--prompt', opts.initialPrompt);
    }
    if (opts.extraArgs) {
      args.push(...opts.extraArgs.split(/\s+/).filter(Boolean));
    }
    return args;
  }

  async installHooks(): Promise<void> {
    // OpenCode has no Vibeyard-managed hook system; nothing to install.
  }

  installStatusScripts(): void {}

  cleanup(): void {
    stopConfigWatch();
  }

  startConfigWatcher(win: BrowserWindow, projectPath: string): void {
    startConfigWatch(win, projectPath, 'opencode');
  }

  stopConfigWatcher(): void {
    stopConfigWatch();
  }

  async getConfig(projectPath: string): Promise<ProviderConfig> {
    return getOpencodeConfig(projectPath);
  }

  getShiftEnterSequence(): string | null {
    return null;
  }

  validateSettings(): SettingsValidationResult {
    // hookStatus is false, so the renderer never surfaces this; report a
    // benign "everything is fine" result so any defensive callers stay quiet.
    return { statusLine: 'vibeyard', hooks: 'complete', hookDetails: {} };
  }

  reinstallSettings(): void {}

  agentsDir(): string {
    return path.join(os.homedir(), '.config', 'opencode', 'agents');
  }

  async installAgent(slug: string, content: string): Promise<{ filePath: string }> {
    return writeAgentFile(this.agentsDir(), slug, content);
  }

  async removeAgent(slug: string): Promise<void> {
    return deleteAgentFile(this.agentsDir(), slug);
  }
}

/** @internal Test-only: reset cached binary path */
export function _resetCachedPath(): void {
  binaryCache.path = null;
}