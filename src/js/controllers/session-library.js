/** Saved-session browser: list, search, open, rename, export, delete. */
import { sessionStore } from '../session-store.js';
import { showToast } from '../util/toast.js';
import { esc, escAttr } from '../util/html.js';
import { formatSeconds } from '../util/format.js';

const { invoke } = window.__TAURI__.core;

export class SessionLibraryController {
    constructor(app) {
        this.app = app;
        this.currentViewed = null;
    }

    bindEvents() {
        // Back from session viewer to session list
        document.getElementById('btn-session-back-to-list').addEventListener('click', () => {
            document.getElementById('sessions-list-panel').style.display = '';
            document.getElementById('session-viewer').style.display = 'none';
        });

        // Copy session content
        document.getElementById('btn-session-copy').addEventListener('click', async () => {
            const content = document.getElementById('session-viewer-content')?.textContent || '';
            if (content) {
                await navigator.clipboard.writeText(content);
                showToast('Copied to clipboard', 'success');
            }
        });

        // Session search box (debounced)
        const searchInput = document.getElementById('input-session-search');
        if (searchInput) {
            let t;
            searchInput.addEventListener('input', (e) => {
                clearTimeout(t);
                const q = e.target.value;
                t = setTimeout(() => this.show(q), 200);
            });
        }

        // Edit session title (inline prompt)
        document.getElementById('btn-session-edit-title')?.addEventListener('click', async () => {
            const cur = this.currentViewed;
            if (!cur || cur.isLegacy) {
                showToast('Cannot rename legacy sessions', 'error');
                return;
            }
            const titleEl = document.getElementById('session-viewer-title');
            const oldTitle = titleEl?.textContent || '';
            const newTitle = prompt('Rename session:', oldTitle);
            if (newTitle == null || newTitle === oldTitle) return;
            try {
                await invoke('update_session_title', { id: cur.id, title: newTitle });
                if (titleEl) titleEl.textContent = newTitle;
                showToast('Renamed', 'success');
            } catch (err) {
                showToast(`Rename failed: ${err}`, 'error');
            }
        });

        // Export session
        document.getElementById('btn-session-export-srt')?.addEventListener('click', () => this.exportCurrent('srt'));
        document.getElementById('btn-session-export-txt')?.addEventListener('click', () => this.exportCurrent('txt'));
    }

    async show(query) {
        const listEl = document.getElementById('sessions-list');
        const listPanel = document.getElementById('sessions-list-panel');
        const viewer = document.getElementById('session-viewer');

        if (listPanel) listPanel.style.display = '';
        if (viewer) viewer.style.display = 'none';
        if (!listEl) return;

        listEl.innerHTML = '<div class="sessions-loading">Loading...</div>';

        try {
            const cmd = query && query.trim() ? 'search_sessions' : 'list_sessions';
            const args = query && query.trim() ? { query: query.trim() } : {};
            const sessions = await invoke(cmd, args);
            if (sessions.length === 0) {
                listEl.innerHTML = '<div class="sessions-empty">No saved sessions yet.</div>';
                return;
            }

            listEl.innerHTML = sessions.map(s => this.renderItem(s)).join('');

            listEl.querySelectorAll('.session-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    if (e.target.closest('.session-delete-btn')) return;
                    const id = item.dataset.id;
                    const legacy = item.dataset.legacy === '1';
                    this.open(id, legacy);
                });
            });
            listEl.querySelectorAll('.session-delete-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const id = btn.dataset.id;
                    // Block deleting the active session — the next autosave would
                    // just resurrect the file the user deleted.
                    if (id === sessionStore.id) {
                        showToast('Cannot delete the active session — Stop it first', 'error');
                        return;
                    }
                    if (!confirm('Delete this session permanently?')) return;
                    try {
                        await invoke('delete_session', { id });
                        await this.show();
                    } catch (err) {
                        showToast(`Delete failed: ${err}`, 'error');
                    }
                });
            });
        } catch (err) {
            listEl.innerHTML = `<div class="sessions-empty">Error: ${err}</div>`;
        }
    }

    renderItem(s) {
        const title = esc(s.title || 'Untitled session');
        const created = esc(s.created_at || '').slice(0, 16);
        const duration = formatSeconds(s.duration_sec || 0);
        const engine = s.engine || 'unknown';
        const engineBadge = s.has_legacy_only
            ? `<span class="session-badge badge-legacy">legacy</span>`
            : `<span class="session-badge badge-engine">${esc(engine)}</span>`;
        const langPair = s.source_lang && s.target_lang
            ? `<span class="session-badge">${esc(s.source_lang)} → ${esc(s.target_lang)}</span>`
            : '';
        // How it was recorded, and whether it has been summarised. Both read
        // from fields older session files simply don't have, hence the defaults.
        const kindBadge = s.kind === 'meeting'
            ? `<span class="session-badge badge-meeting">Meeting</span>`
            : '';
        const summaryBadge = s.has_summary
            ? `<span class="session-badge badge-summary">Summarised</span>`
            : '';
        const segCount = s.segment_count > 0 ? `<span class="session-meta-dim">${s.segment_count} segments</span>` : '';
        const chunks = s.chunk_count > 1 ? `<span class="session-meta-dim">${s.chunk_count} chunks</span>` : '';
        const delBtn = `<button class="session-delete-btn" title="Delete" data-id="${escAttr(s.id)}">×</button>`;
        return `<div class="session-item" data-id="${escAttr(s.id)}" data-legacy="${s.has_legacy_only ? '1' : '0'}">
            <div class="session-item-row1">
                <span class="session-item-title">${title}</span>
                ${delBtn}
            </div>
            <div class="session-item-row2">
                ${kindBadge}
                ${summaryBadge}
                ${engineBadge}
                ${langPair}
                <span class="session-meta-dim">${created}</span>
                ${duration ? `<span class="session-meta-dim">${duration}</span>` : ''}
                ${segCount}
                ${chunks}
            </div>
        </div>`;
    }

    async open(id, isLegacy = false) {
        const listPanel = document.getElementById('sessions-list-panel');
        const viewer = document.getElementById('session-viewer');
        const title = document.getElementById('session-viewer-title');
        const content = document.getElementById('session-viewer-content');

        if (listPanel) listPanel.style.display = 'none';
        if (viewer) viewer.style.display = '';
        if (title) title.textContent = id;
        if (content) content.textContent = 'Loading...';
        this.currentViewed = { id, isLegacy };

        try {
            if (isLegacy) {
                const text = await invoke('read_legacy_session', { id });
                if (content) content.textContent = text;
                if (title) title.textContent = id;
            } else {
                const result = await invoke('read_session', { id });
                if (content) content.textContent = result.md;
                if (title) title.textContent = result.json.title || id;
            }
        } catch (err) {
            if (content) content.textContent = `Error loading session: ${err}`;
        }
    }

    async exportCurrent(format) {
        const cur = this.currentViewed;
        if (!cur || cur.isLegacy) {
            showToast('Cannot export legacy sessions', 'error');
            return;
        }
        try {
            const cmd = format === 'srt' ? 'export_session_srt' : 'export_session_txt';
            const text = await invoke(cmd, { id: cur.id });
            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${cur.id}.${format}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast(`Exported .${format}`, 'success');
        } catch (err) {
            showToast(`Export failed: ${err}`, 'error');
        }
    }
}
