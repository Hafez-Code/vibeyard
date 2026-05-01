import { appState } from '../../state.js';
import { addTask, addTag, getBoard } from '../../board-state.js';

// ── Types ──────────────────────────────────────────────────────────────────

type ItemType = 'issue' | 'pr';

interface GithubItem {
  type: ItemType;
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string;
  labels: string[];
}

interface DialogState {
  overlay: HTMLDivElement;
  list: HTMLDivElement;
  status: HTMLDivElement;
  searchInput: HTMLInputElement;
  tabs: { issues: HTMLButtonElement; prs: HTMLButtonElement };
  footer: HTMLDivElement;
  importBtn: HTMLButtonElement;
  selectAllBtn: HTMLButtonElement;
}

// ── State ──────────────────────────────────────────────────────────────────

let allItems: GithubItem[] = [];
let selectedUrls = new Set<string>();
let activeTab: ItemType = 'issue';
let searchQuery = '';

// ── Entry point ────────────────────────────────────────────────────────────

export async function showGithubSyncDialog(): Promise<void> {
  allItems = [];
  selectedUrls = new Set();
  activeTab = 'issue';
  searchQuery = '';

  const project = appState.activeProject;
  if (!project) return;

  const state = buildDialog();
  document.body.appendChild(state.overlay);

  setStatus(state, 'Resolving repository…');

  let remoteUrl: string | null = null;
  try {
    remoteUrl = await window.vibeyard.git.getRemoteUrl(project.path);
  } catch {
    // ignore
  }

  const repoInfo = remoteUrl ? parseGithubRepo(remoteUrl) : null;
  if (!repoInfo) {
    setStatus(state, 'No GitHub remote found for this project.');
    return;
  }

  setStatus(state, `Loading from ${repoInfo.owner}/${repoInfo.repo}…`);
  const { owner, repo } = repoInfo;

  let token: string | null = null;
  try {
    token = await window.vibeyard.git.getAuthToken();
  } catch {
    // not available — proceed unauthenticated
  }

  try {
    const [issues, prs] = await Promise.all([
      fetchItems(owner, repo, 'issues', token),
      fetchItems(owner, repo, 'pulls', token),
    ]);
    allItems = [...issues, ...prs];
    setStatus(state, '');
    renderList(state);
  } catch (err) {
    setStatus(state, `Failed to load: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── API ────────────────────────────────────────────────────────────────────

function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

async function fetchItems(
  owner: string,
  repo: string,
  endpoint: 'issues' | 'pulls',
  token: string | null,
): Promise<GithubItem[]> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const items: GithubItem[] = [];
  let page = 1;

  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/${endpoint}?state=open&per_page=100&page=${page}`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`GitHub API ${resp.status}: ${await resp.text().catch(() => '')}`);
    }
    const data = await resp.json() as Record<string, unknown>[];
    if (data.length === 0) break;

    for (const item of data) {
      // Issues endpoint also returns PRs; skip them when fetching issues
      if (endpoint === 'issues' && item['pull_request']) continue;

      items.push({
        type: endpoint === 'pulls' ? 'pr' : 'issue',
        number: item['number'] as number,
        title: item['title'] as string,
        body: (item['body'] as string | null) ?? null,
        url: item['html_url'] as string,
        state: item['state'] as string,
        labels: ((item['labels'] as { name: string }[]) ?? []).map(l => l.name),
      });
    }

    if (data.length < 100) break;
    page++;
  }

  return items;
}

// ── Dialog builder ─────────────────────────────────────────────────────────

function buildDialog(): DialogState {
  const overlay = document.createElement('div');
  overlay.className = 'gh-sync-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'gh-sync-dialog';

  // Header
  const header = document.createElement('div');
  header.className = 'gh-sync-header';

  const titleEl = document.createElement('div');
  titleEl.className = 'gh-sync-title';
  titleEl.textContent = 'Sync from GitHub';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'gh-sync-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close');

  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  // Search
  const searchInput = document.createElement('input');
  searchInput.className = 'gh-sync-search';
  searchInput.placeholder = '🔍 Search…';

  // Tabs
  const tabBar = document.createElement('div');
  tabBar.className = 'gh-sync-tabs';

  const issuesTab = document.createElement('button');
  issuesTab.className = 'gh-sync-tab active';
  issuesTab.dataset.tab = 'issue';
  issuesTab.textContent = 'Issues';

  const prsTab = document.createElement('button');
  prsTab.className = 'gh-sync-tab';
  prsTab.dataset.tab = 'pr';
  prsTab.textContent = 'Pull Requests';

  tabBar.appendChild(issuesTab);
  tabBar.appendChild(prsTab);

  // Status
  const status = document.createElement('div');
  status.className = 'gh-sync-status';

  // List
  const list = document.createElement('div');
  list.className = 'gh-sync-list';

  // Footer
  const footer = document.createElement('div');
  footer.className = 'gh-sync-footer';

  const selectAllBtn = document.createElement('button');
  selectAllBtn.className = 'gh-sync-select-all';
  selectAllBtn.textContent = 'Select All';

  const importBtn = document.createElement('button');
  importBtn.className = 'gh-sync-import-btn';
  importBtn.textContent = 'Import Selected';
  importBtn.disabled = true;

  footer.appendChild(selectAllBtn);
  footer.appendChild(importBtn);

  dialog.appendChild(header);
  dialog.appendChild(searchInput);
  dialog.appendChild(tabBar);
  dialog.appendChild(status);
  dialog.appendChild(list);
  dialog.appendChild(footer);
  overlay.appendChild(dialog);

  const state: DialogState = { overlay, list, status, searchInput, tabs: { issues: issuesTab, prs: prsTab }, footer, importBtn, selectAllBtn };

  // Event wiring
  const escListener = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') dispose();
  };
  const dispose = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', escListener);
  };
  closeBtn.addEventListener('click', dispose);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) dispose(); });
  document.addEventListener('keydown', escListener);

  issuesTab.addEventListener('click', () => switchTab(state, 'issue'));
  prsTab.addEventListener('click', () => switchTab(state, 'pr'));

  let debounceTimer: ReturnType<typeof setTimeout>;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      searchQuery = searchInput.value.toLowerCase();
      renderList(state);
    }, 150);
  });

  selectAllBtn.addEventListener('click', () => toggleSelectAll(state));

  importBtn.addEventListener('click', () => {
    importSelected();
    dispose();
  });

  return state;
}

// ── Rendering ──────────────────────────────────────────────────────────────

function setStatus(state: DialogState, message: string): void {
  state.status.textContent = message;
  state.status.style.display = message ? '' : 'none';
}

function switchTab(state: DialogState, tab: ItemType): void {
  activeTab = tab;
  state.tabs.issues.classList.toggle('active', tab === 'issue');
  state.tabs.prs.classList.toggle('active', tab === 'pr');
  renderList(state);
}

function getVisibleItems(): GithubItem[] {
  return allItems.filter(item => {
    if (item.type !== activeTab) return false;
    if (!searchQuery) return true;
    return (
      item.title.toLowerCase().includes(searchQuery) ||
      String(item.number).includes(searchQuery) ||
      item.labels.some(l => l.toLowerCase().includes(searchQuery))
    );
  });
}

function getImportedUrls(): Set<string> {
  const board = getBoard();
  if (!board) return new Set();
  return new Set(board.tasks.map(t => t.githubUrl).filter((u): u is string => Boolean(u)));
}

function renderList(state: DialogState): void {
  state.list.innerHTML = '';
  const visible = getVisibleItems();
  const imported = getImportedUrls();

  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'gh-sync-empty';
    empty.textContent = allItems.length === 0 ? '' : 'No results match your search.';
    state.list.appendChild(empty);
    updateFooter(state);
    return;
  }

  const pending = visible.filter(i => !imported.has(i.url));
  const alreadyImported = visible.filter(i => imported.has(i.url));

  for (const item of pending) {
    state.list.appendChild(buildItemRow(item, false, false, state));
  }

  if (alreadyImported.length > 0) {
    const divider = document.createElement('div');
    divider.className = 'gh-sync-divider';
    divider.textContent = 'Already imported';
    state.list.appendChild(divider);

    for (const item of alreadyImported) {
      state.list.appendChild(buildItemRow(item, true, false, state));
    }
  }

  updateFooter(state);
}

function buildItemRow(item: GithubItem, isImported: boolean, _checked: boolean, state: DialogState): HTMLElement {
  const row = document.createElement('div');
  row.className = 'gh-sync-item' + (isImported ? ' imported' : '');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'gh-sync-checkbox';
  checkbox.checked = !isImported && selectedUrls.has(item.url);
  checkbox.disabled = isImported;

  if (!isImported) {
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        selectedUrls.add(item.url);
      } else {
        selectedUrls.delete(item.url);
      }
      updateFooter(state);
    });
  }

  const info = document.createElement('div');
  info.className = 'gh-sync-item-info';

  const titleLine = document.createElement('div');
  titleLine.className = 'gh-sync-item-title';

  const numSpan = document.createElement('span');
  numSpan.className = 'gh-sync-item-number';
  numSpan.textContent = `#${item.number}`;

  const titleText = document.createElement('span');
  titleText.textContent = item.title;

  titleLine.appendChild(numSpan);
  titleLine.appendChild(titleText);

  const metaLine = document.createElement('div');
  metaLine.className = 'gh-sync-item-meta';

  const stateBadge = document.createElement('span');
  stateBadge.className = `gh-sync-state-badge gh-sync-state-${item.state}`;
  stateBadge.textContent = item.state;
  metaLine.appendChild(stateBadge);

  for (const label of item.labels.slice(0, 4)) {
    const pill = document.createElement('span');
    pill.className = 'gh-sync-label-pill';
    pill.textContent = label;
    metaLine.appendChild(pill);
  }

  if (isImported) {
    const importedBadge = document.createElement('span');
    importedBadge.className = 'gh-sync-imported-badge';
    importedBadge.textContent = '✓ imported';
    metaLine.appendChild(importedBadge);
  }

  info.appendChild(titleLine);
  info.appendChild(metaLine);

  row.appendChild(checkbox);
  row.appendChild(info);

  if (!isImported) {
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change'));
    });
  }

  return row;
}

function updateFooter(state: DialogState): void {
  const count = selectedUrls.size;
  state.importBtn.disabled = count === 0;
  state.importBtn.textContent = count > 0 ? `Import ${count} selected` : 'Import Selected';

  const visible = getVisibleItems();
  const imported = getImportedUrls();
  const pending = visible.filter(i => !imported.has(i.url));
  const allSelected = pending.length > 0 && pending.every(i => selectedUrls.has(i.url));
  state.selectAllBtn.textContent = allSelected ? 'Deselect All' : 'Select All';
}

function toggleSelectAll(state: DialogState): void {
  const visible = getVisibleItems();
  const imported = getImportedUrls();
  const pending = visible.filter(i => !imported.has(i.url));
  const allSelected = pending.every(i => selectedUrls.has(i.url));

  if (allSelected) {
    for (const item of pending) selectedUrls.delete(item.url);
  } else {
    for (const item of pending) selectedUrls.add(item.url);
  }

  renderList(state);
}

// ── Import ─────────────────────────────────────────────────────────────────

function importSelected(): void {
  const toImport = allItems.filter(i => selectedUrls.has(i.url));

  for (const item of toImport) {
    const typeTag = item.type === 'pr' ? 'github-pr' : 'github-issue';
    const tags = [typeTag, ...item.labels.map(l => l.toLowerCase())];

    // Register tags in palette
    for (const tag of tags) addTag(tag);

    const prompt = (item.body ?? '').slice(0, 2000).trim();
    const notes = `GitHub: ${item.url}`;

    addTask({
      title: `#${item.number} ${item.title}`,
      prompt,
      notes,
      tags,
      githubUrl: item.url,
    });
  }
}
