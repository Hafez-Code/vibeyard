import * as path from 'path';
import { homedir } from 'os';
import { readFileSafe, readDirSafe } from './fs-utils';
import { parseFrontmatter } from './frontmatter';
import { dedupeByName } from './provider-config-utils';
import type { Agent, McpServer, ProviderConfig } from '../shared/types';

/**
 * Read `.md` agent files from a directory. OpenCode names agents by filename
 * slug (frontmatter `name` is optional), so fall back to the file stem when
 * frontmatter has no `name` field. Files without `.md` are skipped.
 */
function readOpencodeAgentsFromDir(dirPath: string, scope: 'user' | 'project'): Agent[] {
  const agents: Agent[] = [];
  for (const file of readDirSafe(dirPath)) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(dirPath, file);
    const fm = parseFrontmatter(filePath);
    const name = fm.name || file.replace(/\.md$/i, '');
    agents.push({ name, model: fm.model || '', category: 'plugin', scope, filePath });
  }
  return agents;
}

/**
 * Parse opencode JSONC (comments + trailing commas allowed) into a value,
 * returning null when the file is missing or unparseable.
 */
function parseOpencodeJsonc(filePath: string): Record<string, unknown> | null {
  const raw = readFileSafe(filePath);
  if (!raw) return null;
  const cleaned = raw
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(cleaned) as Record<string, unknown>; } catch { return null; }
}

/**
 * Read MCP servers out of an opencode.json / opencode.jsonc config file.
 *
 * OpenCode nests servers under a top-level `mcp` object (not `mcpServers`),
 * where each entry is keyed by name and may be `{ type: "remote", url }` or
 * `{ type: "local", command, args, env }`. We surface whatever `url` or
 * `command` string we can find so the UI can display it.
 */
function readMcpServersFromOpencodeJson(filePath: string, scope: 'user' | 'project'): McpServer[] {
  const json = parseOpencodeJsonc(filePath);
  const mcp = json?.mcp;
  if (!mcp || typeof mcp !== 'object') return [];

  const servers: McpServer[] = [];
  for (const [name, config] of Object.entries(mcp as Record<string, Record<string, unknown>>)) {
    const url = (config?.url as string) || (config?.command as string) || '';
    if (url) servers.push({ name, url, status: 'configured', scope, filePath });
  }
  return servers;
}

export async function getOpencodeConfig(projectPath: string): Promise<ProviderConfig> {
  const globalDir = path.join(homedir(), '.config', 'opencode');
  const projectDir = path.join(projectPath, '.opencode');

  const userMcp = readMcpServersFromOpencodeJson(path.join(globalDir, 'opencode.json'), 'user');
  const projectMcp = readMcpServersFromOpencodeJson(path.join(projectPath, 'opencode.json'), 'project');

  const serverMap = new Map<string, McpServer>();
  for (const server of userMcp) serverMap.set(server.name, server);
  for (const server of projectMcp) serverMap.set(server.name, server);

  const agents = dedupeByName(
    readOpencodeAgentsFromDir(path.join(globalDir, 'agents'), 'user'),
    readOpencodeAgentsFromDir(path.join(projectDir, 'agents'), 'project'),
  );

  return {
    mcpServers: Array.from(serverMap.values()),
    agents,
    skills: [],
    commands: [],
  };
}