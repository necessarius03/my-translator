/**
 * Subtitle overlay controller (main window side).
 *
 * Owns the on/off state of the transparent cue window and feeds it from the
 * same TranscriptUI stream the in-app transcript renders from — subscribing via
 * `transcriptUI.onCue()` rather than tapping the engines, so the overlay can
 * never show something different from the app.
 *
 * Two things are deliberately throttled/deduplicated here rather than in Rust:
 * streaming engines fire a render per delta (dozens per second), and every push
 * is an IPC round trip. Sending only changed text at ~12 fps keeps the overlay
 * smooth without flooding the channel.
 */

import { settingsManager } from '../settings.js';
import { showToast } from '../util/toast.js';

const { invoke } = window.__TAURI__.core;

const PUSH_INTERVAL_MS = 80;

export class SubtitleController {
    constructor(app) {
        this.app = app;
        this.open = false;
        this.locked = true;       // locked = click-through = the normal state
        this._unsubscribe = null;
        this._pending = null;     // newest cue not yet sent
        this._lastSent = '';      // dedupe key of the last pushed cue
        this._timer = null;
    }

    bindEvents() {
        document.getElementById('btn-subtitle')?.addEventListener('click', () => this.toggle());
        document.getElementById('btn-subtitle-lock')?.addEventListener('click', () => this.toggleLock());
        document.getElementById('btn-subtitle-reset')?.addEventListener('click', () => this.resetPosition());
    }

    /** Reopen on launch if the user left it on. Failures are non-fatal. */
    async restoreOnStartup() {
        // Same path as the Settings checkbox, so the two cannot both open it.
        await this.syncEnabled();
    }

    styleFromSettings() {
        const s = settingsManager.get();
        return {
            font_size: s.subtitle_font_size ?? 30,
            show_original: s.subtitle_show_original !== false,
            boxed: !!s.subtitle_boxed,
            hold_ms: s.subtitle_hold_ms ?? 5000,
        };
    }

    /**
     * Follow the Settings checkbox. show()/hide() save subtitle_enabled
     * themselves, which lands back here already matching — so no loop. The
     * busy flag covers the await inside show(): other saves in that window
     * would otherwise open the window twice.
     */
    async syncEnabled() {
        const want = !!settingsManager.get().subtitle_enabled;
        if (want === this.open || this._syncing) return;
        this._syncing = true;
        try {
            if (want) await this.show();
            else await this.hide();
        } catch (err) {
            console.error('[Subtitle] sync failed:', err);
            showToast(`Subtitles: ${err}`, 'error');
            // Record what actually happened, or every later save would retry.
            if (want) settingsManager.save({ subtitle_enabled: false });
        } finally {
            this._syncing = false;
        }
    }

    async toggle() {
        if (this.open) await this.hide();
        else await this.show();
    }

    async show() {
        await invoke('subtitle_open', { style: this.styleFromSettings() });
        this.open = true;
        this.locked = true;
        this._subscribe();
        this.updateButton();
        settingsManager.save({ subtitle_enabled: true });
        // The window's page boots asynchronously, so the style pushed inside
        // subtitle_open can arrive before anything is listening. Re-push once it
        // has certainly booted; the page is idempotent about it.
        setTimeout(() => this.applySettings(), 600);
        showToast('Subtitles on — the mouse passes through them', 'success');
    }

    async hide() {
        this._unsubscribeCues();
        try {
            await invoke('subtitle_close');
        } finally {
            this.open = false;
            this.updateButton();
            settingsManager.save({ subtitle_enabled: false });
        }
    }

    /** Unlock to drag/resize the strip; lock to make the mouse pass through again. */
    async toggleLock() {
        if (!this.open) {
            showToast('Turn subtitles on first', 'info');
            return;
        }
        this.locked = !this.locked;
        await invoke('subtitle_set_locked', { locked: this.locked });
        this.updateButton();
        showToast(
            this.locked ? 'Locked — the mouse passes through' : 'Unlocked — drag to reposition',
            'success',
        );
    }

    async resetPosition() {
        if (!this.open) return;
        try {
            localStorage.removeItem('subtitle_rect');
            await invoke('subtitle_reset_position');
            showToast('Subtitles moved back to the bottom of the screen', 'success');
        } catch (err) {
            showToast(`Could not reset the position: ${err}`, 'error');
        }
    }

    /** Push current look to the overlay. Called when Settings are saved. */
    applySettings() {
        if (!this.open) return;
        invoke('subtitle_set_style', { style: this.styleFromSettings() })
            .catch((err) => console.error('[Subtitle] style push failed:', err));
    }

    updateButton() {
        const btn = document.getElementById('btn-subtitle');
        if (btn) {
            btn.classList.toggle('active', this.open);
            btn.title = this.open ? 'Hide subtitles (⌘U)' : 'Show on-screen subtitles (⌘U)';
        }
        const lock = document.getElementById('btn-subtitle-lock');
        if (lock) {
            lock.textContent = this.locked ? 'Unlock to move subtitles' : 'Lock again (click-through)';
            lock.disabled = !this.open;
        }
        const reset = document.getElementById('btn-subtitle-reset');
        if (reset) reset.disabled = !this.open;
        // ⌘U and the toolbar button change this too; keep the Settings box honest.
        const check = document.getElementById('check-subtitle-enabled');
        if (check) check.checked = this.open;
    }

    /* ── Cue plumbing ────────────────────────────────────────── */

    _subscribe() {
        if (this._unsubscribe) return;
        this._unsubscribe = this.app.transcriptUI.onCue((cue) => this._queue(cue));
        this._timer = setInterval(() => this._flush(), PUSH_INTERVAL_MS);
        this._queue(this.app.transcriptUI._currentCue()); // paint whatever is already on screen
    }

    _unsubscribeCues() {
        if (this._unsubscribe) {
            this._unsubscribe();
            this._unsubscribe = null;
        }
        clearInterval(this._timer);
        this._timer = null;
        this._pending = null;
        this._lastSent = '';
    }

    _queue(cue) {
        this._pending = cue;
    }

    _flush() {
        if (!this._pending || !this.open) return;
        const cue = this._pending;
        this._pending = null;

        const key = `${cue.provisional ? 'p' : 'f'}|${cue.src}|${cue.tgt}`;
        if (key === this._lastSent) return;
        this._lastSent = key;

        invoke('subtitle_push', { line: cue })
            .catch((err) => console.error('[Subtitle] push failed:', err));
    }
}
