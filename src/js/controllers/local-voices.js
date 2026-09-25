/**
 * Local offline (Piper) voice manager: catalogue, install state, download,
 * delete, and the model-folder setting. Backed by the local_tts_* commands.
 */
import { settingsManager } from '../settings.js';
import { showToast } from '../util/toast.js';
import { esc } from '../util/html.js';

const { invoke, Channel } = window.__TAURI__.core;

export class LocalVoiceManager {
    constructor() {
        this.voices = null;
        this.installed = new Set();
    }

    /** Fetch the catalog + install state once per open, then render the list. */
    async populate() {
        const langSel = document.getElementById('select-local-lang');
        const saved = settingsManager.get().local_tts_voice || 'vi_VN-vais1000-medium';
        if (langSel && !langSel.dataset.init) {
            langSel.value = saved.startsWith('en') ? 'en' : 'vi';
            langSel.dataset.init = 'true';
        }
        // Show the real resolved models folder (per-OS absolute path) so the user can
        // find the files themselves. Falls back to the raw setting if the query fails.
        const dirInput = document.getElementById('input-local-models-dir');
        if (dirInput) {
            try {
                dirInput.value = await invoke('local_tts_models_dir_path');
            } catch {
                dirInput.value = settingsManager.get().local_tts_models_dir || 'Default app location';
            }
        }
        // Speed slider from saved setting.
        const speedSlider = document.getElementById('range-local-speed');
        const speedLabel = document.getElementById('local-speed-value');
        const speed = settingsManager.get().local_tts_speed || 1.0;
        if (speedSlider) speedSlider.value = speed;
        if (speedLabel) speedLabel.textContent = parseFloat(speed).toFixed(1) + 'x';
        await this.refresh();
        this.fill(langSel ? langSel.value : 'vi');
    }

    /** (Re)load the catalog + install state from the backend into a cache. */
    async refresh() {
        try {
            const list = await invoke('local_tts_list_models');
            this.voices = Array.isArray(list) ? list : [];
        } catch (err) {
            console.warn('[Local TTS] list failed:', err);
            this.voices = [];
        }
        this.installed = new Set(
            (this.voices || []).filter(v => v.installed).map(v => v.id)
        );
    }

    /** True if `id` is currently installed (fresh backend check). */
    async isInstalled(id) {
        if (!id) return false;
        await this.refresh();
        return this.installed.has(id);
    }

    /** Render the voice rows for `lang` ("vi"|"en") with download/delete controls. */
    fill(lang) {
        const container = document.getElementById('local-voice-list');
        if (!container) return;
        const saved = settingsManager.get().local_tts_voice;
        const all = this.voices || [];
        // Catalog voices filter by the selected language; imported (local) voices are shown
        // regardless of language (their language is unknown).
        const catalogList = all.filter(v => !v.imported && v.lang === lang);
        const importedList = all.filter(v => v.imported);
        container.innerHTML = '';
        if (!catalogList.length && !importedList.length) {
            container.innerHTML = '<p class="hint">No voices for this language.</p>';
            return;
        }

        const addRow = (v) => {
            const row = document.createElement('div');
            row.className = 'local-voice-row';
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;';
            const sizeMb = (v.approxSizeBytes / 1e6).toFixed(0);
            if (v.installed) {
                const checked = saved === v.id ? 'checked' : '';
                row.innerHTML =
                    `<label style="flex:1;display:flex;align-items:center;gap:6px;cursor:pointer;">` +
                    `<input type="radio" name="local-voice" value="${v.id}" ${checked} />` +
                    `<span>${esc(v.display)}</span></label>` +
                    `<button type="button" class="icon-btn small btn-local-delete" data-id="${v.id}" title="Delete">🗑️</button>`;
            } else {
                row.innerHTML =
                    `<span style="flex:1;color:var(--text-muted,#888);">${esc(v.display)} · ${sizeMb} MB</span>` +
                    `<span class="local-progress" data-id="${v.id}" style="min-width:64px;text-align:right;"></span>` +
                    `<button type="button" class="icon-btn small btn-local-download" data-id="${v.id}" title="Download">⬇️</button>`;
            }
            container.appendChild(row);
        };

        catalogList.forEach(addRow);
        if (importedList.length) {
            const hdr = document.createElement('p');
            hdr.className = 'hint';
            hdr.style.cssText = 'margin:8px 0 2px;font-weight:600;';
            hdr.textContent = `Imported (local) — ${importedList.length}`;
            container.appendChild(hdr);
            importedList.forEach(addRow);
        }

        container.querySelectorAll('.btn-local-download').forEach(btn =>
            btn.addEventListener('click', () => this.download(btn.dataset.id))
        );
        container.querySelectorAll('.btn-local-delete').forEach(btn =>
            btn.addEventListener('click', () => this.remove(btn.dataset.id))
        );
        container.querySelectorAll('input[name="local-voice"]').forEach(radio =>
            radio.addEventListener('change', () => {
                if (radio.checked) settingsManager.save({ local_tts_voice: radio.value });
            })
        );
    }

    /** Download a voice model with live progress, then re-render as installed. */
    async download(id) {
        // Download straight into the default app models folder — no folder prompt.
        // Users who want a custom location can still set it via the Model folder field.
        const progressEl = document.querySelector(`.local-progress[data-id="${id}"]`);
        const btn = document.querySelector(`.btn-local-download[data-id="${id}"]`);
        if (btn) btn.disabled = true;
        const onProgress = new Channel();
        onProgress.onmessage = (msg) => {
            if (!progressEl) return;
            if (msg.phase === 'downloading' && msg.total > 0) {
                progressEl.textContent = `${Math.floor((msg.received / msg.total) * 100)}%`;
            } else if (msg.phase === 'extracting') {
                progressEl.textContent = '…';
            }
        };
        try {
            await invoke('local_tts_download_model', { id, onProgress });
            showToast('Voice downloaded ✓', 'success');
            await this.refresh();
            this.fill(document.getElementById('select-local-lang')?.value || 'vi');
        } catch (err) {
            showToast(`Download failed: ${err}`, 'error');
            if (btn) btn.disabled = false;
            if (progressEl) progressEl.textContent = '';
        }
    }

    /** Delete an installed voice (real on-device removal), then re-render. */
    async remove(id) {
        try {
            await invoke('local_tts_delete_model', { id });
            showToast('Voice deleted', 'success');
            await this.refresh();
            this.fill(document.getElementById('select-local-lang')?.value || 'vi');
        } catch (err) {
            showToast(`Delete failed: ${err}`, 'error');
        }
    }

    /**
     * Open the folder picker; on pick, persist as models dir and refresh.
     * Returns the chosen path, or null if the user cancelled (so callers can abort),
     * or '' if the picker itself failed.
     */
    async pickModelsDir() {
        try {
            const { open } = window.__TAURI__.dialog;
            const picked = await open({ directory: true, multiple: false, title: 'Choose model folder' });
            if (picked === null || picked === undefined) return null; // cancelled
            const dir = Array.isArray(picked) ? picked[0] : picked;
            await settingsManager.save({ local_tts_models_dir: dir });
            const dirInput = document.getElementById('input-local-models-dir');
            if (dirInput) dirInput.value = dir;
            await this.refresh();
            this.fill(document.getElementById('select-local-lang')?.value || 'vi');
            return dir;
        } catch (err) {
            console.warn('[Local TTS] folder pick failed:', err);
            return '';
        }
    }

    /** Reset the model folder back to the default app location and refresh the list. */
    async resetModelsDir() {
        await settingsManager.save({ local_tts_models_dir: '' });
        const dirInput = document.getElementById('input-local-models-dir');
        if (dirInput) {
            try {
                dirInput.value = await invoke('local_tts_models_dir_path');
            } catch {
                dirInput.value = 'Default app location';
            }
        }
        await this.refresh();
        this.fill(document.getElementById('select-local-lang')?.value || 'vi');
        showToast('Model folder reset to default', 'success');
    }
}
