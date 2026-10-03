/**
 * Meeting mode.
 *
 * A meeting IS a live session — same engines, same capture, same store. What
 * differs is presentation (a clock instead of a floating overlay, no line
 * trimming, no auto-hiding chrome), one decision (translate while recording, or
 * just take the transcript down), and what can happen after it: the transcript
 * can be summarised, and the summary is saved into the same session file.
 * Ending and summarising are separate actions — plenty of meetings only need
 * the transcript.
 *
 * The transcript element is MOVED between the Live panel and this one rather
 * than duplicated. One DOM node means one TranscriptUI, which means there is no
 * second copy of the transcript that could drift — and the subtitle overlay,
 * which subscribes to that same TranscriptUI, keeps working across the move.
 */

import { settingsManager } from '../settings.js';
import { SessionStore, sessionStore } from '../session-store.js';
import { showToast } from '../util/toast.js';
import { esc, renderSummaryMarkdown } from '../util/html.js';

const { invoke } = window.__TAURI__.core;

/** Engines that can run without translating. See `transcribeOnly` below. */
const TRANSCRIBE_ONLY_ENGINES = new Set(['soniox']);

const ENGINE_NAMES = {
    soniox: 'Soniox',
    openai: 'OpenAI Realtime',
    qwen: 'Qwen LiveTranslate',
    local: 'Local MLX',
};

/** Where each summary provider's API key lives in settings. */
const SUMMARY_KEYS = {
    openai: 'openai_api_key',
    qwen: 'qwen_api_key',
    gemini: 'gemini_api_key',
};

/** Fallback model when the user has not named one. Provider line-ups change
 *  faster than this app ships, so the field is editable in Settings. */
const SUMMARY_MODELS = {
    openai: 'gpt-4.1-mini',
    qwen: 'qwen-plus',
    gemini: 'gemini-2.5-flash',
};

const SUMMARY_PROVIDER_NAMES = {
    openai: 'OpenAI',
    qwen: 'Qwen',
    gemini: 'Gemini',
};

export class MeetingController {
    constructor(app) {
        this.app = app;
        this.translateLive = true;
        this.startedAt = null;   // wall-clock start of the current stretch
        this.elapsedMs = 0;      // accumulated across pauses
        this.ticker = null;
        this.view = 'transcript';
        this.summarizing = false;
        this.lastRun = null;     // provider/model/timing of the last summary
        this.summary = '';       // the summary on screen, for Copy
        // The meeting last ended with End. stopSession() resets sessionStore for
        // the next recording, so without this Copy and Summarise would have
        // nothing to work on the moment the meeting was over.
        this.ended = null;       // { id, text }
    }

    bindEvents() {
        document.getElementById('btn-meeting-start')?.addEventListener('click', () => this.toggleRecording());
        document.getElementById('btn-meeting-pause')?.addEventListener('click', () => this.pause());
        document.getElementById('btn-meeting-copy')?.addEventListener('click', () => this.copy());
        document.getElementById('btn-meeting-summarize')?.addEventListener('click', () => this.summarize());
        document.getElementById('btn-meeting-clear')?.addEventListener('click', () => this.clear());
        document.getElementById('btn-meeting-open-dir')?.addEventListener('click', async () => {
            try {
                await invoke('open_transcript_dir');
            } catch (err) {
                showToast(`Could not open the folder: ${err}`, 'error');
            }
        });

        document.getElementById('check-meeting-translate')?.addEventListener('change', (e) => {
            this.setTranslateLive(e.target.checked);
        });

        document.getElementById('select-meeting-source')?.addEventListener('change', (e) => {
            this.app.live.setSource(e.target.value);
        });

        document.querySelectorAll('.meeting-view-tab').forEach((btn) => {
            btn.addEventListener('click', () => this.setView(btn.dataset.view));
        });

        document.getElementById('btn-meeting-resummarize')?.addEventListener('click', () => {
            this.summarize({ force: true });
        });

        document.getElementById('btn-meeting-copy-summary')?.addEventListener('click', async () => {
            if (!this.summary) {
                showToast('No summary yet', 'info');
                return;
            }
            await navigator.clipboard.writeText(this.summary);
            showToast('Summary copied', 'success');
        });
    }

    /* ── Entering / leaving the tab ───────────────────────── */

    enter() {
        const slot = document.getElementById('meeting-stream');
        const node = document.getElementById('transcript-content');
        if (slot && node && node.parentElement !== slot) slot.appendChild(node);

        // The Live overlay trims to the last few lines because it is a glance
        // surface. A meeting is read by scrolling back, so nothing is trimmed
        // here. This governs only what stays on SCREEN — the saved file and the
        // summary both come from sessionStore, which is never trimmed.
        this.app.transcriptUI.setUnbounded(true);

        this.syncEngineRow();
        this.updateButtons();
        this.renderClock();
    }

    exit() {
        // Hand the transcript back to the Live panel so that tab is not empty.
        // It must go back BEFORE the action row: appending would make it the
        // last child, leaving the Start/Pause/⋯ row stranded above the
        // transcript — and the ⋯ menu, which opens upward from a bottom row,
        // clipped off the top of the window.
        const home = document.getElementById('transcript-container');
        const node = document.getElementById('transcript-content');
        if (home && node && node.parentElement !== home) {
            // insertBefore(node, null) appends, so a missing action row is safe.
            home.insertBefore(node, home.querySelector('.live-action-row'));
        }

        // Leaving the tab is not the same as ending the meeting. While one is
        // still open — including while paused — the transcript stays whole, or
        // glancing at Library mid-meeting would destroy the scrollback the
        // meeting view exists to provide. sessionKind is 'meeting' from start()
        // until stopSession(), which is exactly that window; isRunning is not,
        // because pause() clears it.
        if (this.app.sessionKind !== 'meeting') {
            this.app.transcriptUI.setUnbounded(false);
        }
    }

    /* ── The live-translate switch ────────────────────────── */

    setTranslateLive(on) {
        const engine = settingsManager.get().translation_mode || 'soniox';

        if (!on && !TRANSCRIBE_ONLY_ENGINES.has(engine)) {
            // Refusing silently would be worse than refusing loudly: the user
            // would think recording is cheaper than it is.
            document.getElementById('check-meeting-translate').checked = true;
            this.translateLive = true;
            showToast(
                `${ENGINE_NAMES[engine] || engine} has no transcribe-only mode. Switch to Soniox in Settings to turn translation off.`,
                'info',
            );
            this.syncEngineRow();
            return;
        }

        this.translateLive = on;
        this.app.transcribeOnly = !on;
        this.syncEngineRow();

        if (this.app.isRunning) {
            showToast('Applies from the next start', 'info');
        }
    }

    /** Engine label + the hint explaining a locked switch. */
    syncEngineRow() {
        const engine = settingsManager.get().translation_mode || 'soniox';
        const label = document.getElementById('meeting-engine');
        if (label) label.textContent = ENGINE_NAMES[engine] || engine;

        const canTranscribeOnly = TRANSCRIBE_ONLY_ENGINES.has(engine);
        const toggle = document.getElementById('check-meeting-translate');
        if (toggle) {
            toggle.disabled = !canTranscribeOnly;
            if (!canTranscribeOnly) {
                toggle.checked = true;
                this.translateLive = true;
                this.app.transcribeOnly = false;
            }
        }

        const hint = document.getElementById('meeting-hint');
        if (hint) {
            hint.textContent = canTranscribeOnly ? '' : '· this engine always translates';
        }

        const src = document.getElementById('select-meeting-source');
        if (src) src.value = this.app.currentSource;
    }

    /* ── Recording ────────────────────────────────────────── */

    async toggleRecording() {
        if (this.app.isStarting) return;
        if (this.app.isRunning) {
            await this.endMeeting();
        } else {
            await this.start();
        }
    }

    async start() {
        this.app.isStarting = true;
        try {
            // Stamps the session record so the library can tell a meeting from a
            // glance-at-a-video session, and so the summary knows what it is.
            this.app.sessionKind = 'meeting';
            this.app.transcribeOnly = !this.translateLive;
            sessionStore.kind = 'meeting';

            // A new meeting starts from a clean sheet: the previous transcript
            // and summary belong to the previous session file, not this one.
            // (Resuming from Pause is the same meeting — nothing was ended.)
            if (this.ended) this.clearScreen();
            this.lastRun = null;
            this.summary = '';
            const tabs = document.getElementById('meeting-views');
            if (tabs) tabs.hidden = true;
            this.setView('transcript');

            // The clock starts itself once capture is running (syncClock).
            await this.app.live.start();
        } catch (err) {
            console.error('[Meeting] start failed:', err);
            showToast(`Error: ${err}`, 'error');
        } finally {
            this.app.isStarting = false;
            this.updateButtons();
        }
    }

    async pause() {
        if (!this.app.isRunning) return;
        this.stopTicker();
        await this.app.live.pause();
        this.updateButtons();
    }

    /**
     * Stop capture and finalise the session file. Summarising is a separate
     * button; the transcript stays on screen so it can still be copied.
     */
    async endMeeting() {
        this.stopTicker();
        await this.app.live.pause();
        this.updateButtons();

        // Remember the meeting before stopSession() resets the store for the
        // next recording. If the save fails the store is left as it is, and
        // record() keeps reading from it instead.
        const ended = sessionStore.isEmpty()
            ? null
            : { id: sessionStore.id, text: sessionStore.getPlainText() };

        await this.app.live.stopSession();
        if (ended) this.ended = ended;
        this.startedAt = null;
        this.elapsedMs = 0;
        this.renderClock();
        this.updateButtons();
    }

    /**
     * Wipe the screen and start over. A meeting still open (paused) is ended
     * first, so Clear never throws a transcript away — it is in the Library.
     */
    async clear() {
        if (this.app.isRunning || this.app.isStarting || this.summarizing) return;
        if (!sessionStore.isEmpty()) {
            await this.endMeeting();
            // Save failed: keep everything on screen so nothing looks lost.
            if (!sessionStore.isEmpty()) return;
        }
        this.clearScreen();
        this.updateButtons();
    }

    clearScreen() {
        this.app.transcriptUI.clear();
        this.app.transcriptUI.showPlaceholder();
        this.app.recordingStartTime = null;
        this.ended = null;
        this.summary = '';
        this.lastRun = null;
        const tabs = document.getElementById('meeting-views');
        if (tabs) tabs.hidden = true;
        this.setView('transcript');
        const body = document.getElementById('meeting-summary-body');
        if (body) body.innerHTML = '';
        this.startedAt = null;
        this.elapsedMs = 0;
        this.renderClock();
    }

    /** Copy and Summarise act on the open meeting, else the one last ended. */
    hasRecord() {
        return !sessionStore.isEmpty() || !!this.ended;
    }

    async record() {
        if (!sessionStore.isEmpty()) return sessionStore;
        if (this.ended) return SessionStore.resume(this.ended.id);
        return null;
    }

    async copy() {
        // From the record, not the screen: the on-screen buffer is a window.
        const text = sessionStore.isEmpty()
            ? (this.ended?.text || '')
            : sessionStore.getPlainText();
        if (!text) {
            showToast('Nothing to copy yet', 'info');
            return;
        }
        await navigator.clipboard.writeText(text);
        showToast('Transcript copied', 'success');
    }

    /* ── Summary ──────────────────────────────────────────── */

    setView(view) {
        this.view = view;
        document.querySelectorAll('.meeting-view-tab').forEach((b) => {
            b.classList.toggle('active', b.dataset.view === view);
        });
        const stream = document.getElementById('meeting-stream');
        const summary = document.getElementById('meeting-summary');
        if (stream) stream.hidden = view !== 'transcript';
        if (summary) summary.hidden = view !== 'summary';
    }

    /** Resolve provider config, or throw with exactly what is missing. */
    summaryConfig() {
        const s = settingsManager.get();
        const provider = s.summary_provider || 'openai';
        const apiKey = (s[SUMMARY_KEYS[provider]] || '').trim();
        if (!apiKey) {
            const where = provider === 'gemini'
                ? 'Settings → Meeting summary'
                : 'Settings → Translation engine';
            throw new Error(`No ${SUMMARY_PROVIDER_NAMES[provider]} API key yet. Add one in ${where}.`);
        }
        return {
            provider,
            apiKey,
            model: (s.summary_model || '').trim() || SUMMARY_MODELS[provider],
            language: (s.summary_language || '').trim() || 'English',
            instructions: s.summary_prompt || '',
        };
    }

    /**
     * Send the transcript off to be summarised. `force` re-runs even when a
     * summary already exists — that is the "Summarise again" button.
     */
    async summarize({ force = false } = {}) {
        if (this.summarizing) return;

        // After End the session lives on disk only, so it is read back from
        // there — the summary has to land in that same file.
        let record;
        try {
            record = await this.record();
        } catch (err) {
            this.showSummaryError(`Could not open the saved meeting: ${err}`);
            return;
        }
        if (!record) {
            showToast('No transcript to summarise', 'info');
            return;
        }

        if (record.summary && !force) {
            this.summary = record.summary;
            this.renderSummary();
            return;
        }

        // Must be the full record. Reading the on-screen buffer here meant any
        // settings save during a long meeting silently shortened the transcript
        // the summary was built from, with nothing on screen to say so.
        const transcript = record.getPlainText();
        const id = record.id;
        if (!transcript.trim()) {
            showToast('No transcript to summarise', 'info');
            return;
        }

        let cfg;
        try {
            cfg = this.summaryConfig();
        } catch (err) {
            this.showSummaryError(err.message);
            showToast(err.message, 'error');
            return;
        }

        this.summarizing = true;
        this.updateButtons();
        this.showSummaryPending(cfg);

        try {
            const res = await invoke('summarize_text', {
                req: {
                    provider: cfg.provider,
                    api_key: cfg.apiKey,
                    model: cfg.model,
                    language: cfg.language,
                    instructions: cfg.instructions,
                    transcript,
                },
            });

            // End may have been pressed while this was in flight, which resets
            // the shared store under us; the meeting is on disk by then.
            if (record === sessionStore && sessionStore.id !== id) {
                record = await SessionStore.resume(id);
            }
            record.summary = res.text;
            // The summary belongs to the session record, so it has to reach disk
            // in the same file as the transcript it describes.
            record.markDirty();
            const saved = await record.persist();

            this.summary = res.text;
            this.lastRun = res;
            this.renderSummary();
            if (saved === 'failed') {
                showToast('Summary ready, but saving it failed — copy it to keep it', 'error');
            } else {
                showToast('Summary ready', 'success');
            }
        } catch (err) {
            this.showSummaryError(String(err));
        } finally {
            this.summarizing = false;
            this.updateButtons();
        }
    }

    revealSummaryTabs() {
        const tabs = document.getElementById('meeting-views');
        if (tabs) tabs.hidden = false;
    }

    showSummaryPending(cfg) {
        this.revealSummaryTabs();
        this.setView('summary');
        const body = document.getElementById('meeting-summary-body');
        if (body) {
            const who = esc(SUMMARY_PROVIDER_NAMES[cfg.provider] || cfg.provider);
            body.innerHTML = '<div class="meeting-summary-pending">'
                + `<div>Summarising with ${who} · ${esc(cfg.model)}…</div>`
                + '<div>The longer the meeting, the longer this takes.</div></div>';
        }
        const meta = document.getElementById('meeting-summary-meta');
        if (meta) meta.textContent = '';
    }

    showSummaryError(message) {
        this.revealSummaryTabs();
        this.setView('summary');
        const body = document.getElementById('meeting-summary-body');
        if (body) {
            body.innerHTML = `<p class="meeting-summary-error">${esc(message)}</p>`
                + '<p>The transcript is saved and intact. Fix Settings, then press <strong>Summarise again</strong>.</p>';
        }
        const meta = document.getElementById('meeting-summary-meta');
        if (meta) meta.textContent = '';
    }

    renderSummary() {
        this.revealSummaryTabs();
        this.setView('summary');

        const body = document.getElementById('meeting-summary-body');
        if (body) body.innerHTML = renderSummaryMarkdown(this.summary);

        const meta = document.getElementById('meeting-summary-meta');
        if (meta) {
            const r = this.lastRun;
            meta.textContent = r
                ? [
                    SUMMARY_PROVIDER_NAMES[r.provider] || r.provider,
                    r.model,
                    `${(r.elapsed_ms / 1000).toFixed(1)}s`,
                    r.total_tokens ? `${r.total_tokens.toLocaleString('en-US')} tokens` : null,
                ].filter(Boolean).join(' · ')
                : 'Saved with the transcript';
        }
    }

    /* ── Clock ────────────────────────────────────────────── */

    /**
     * Run the clock exactly while capture runs. Driven from updateButtons(),
     * which every status change reaches, so the clock follows however capture
     * started or stopped — this tab's buttons, Ctrl+Enter, the Live tab, a
     * source switch, an engine error. Starting it only from start() left it
     * frozen on every other path.
     */
    syncClock() {
        // Only a meeting's time counts: a Live-tab session would otherwise
        // leave its minutes on the next meeting's clock.
        const running = this.app.isRunning && this.app.sessionKind === 'meeting';
        if (running && !this.ticker) this.startTicker();
        else if (!running && this.ticker) this.stopTicker();
    }

    startTicker() {
        this.stopTicker();
        this.startedAt = Date.now();
        this.ticker = setInterval(() => this.renderClock(), 1000);
        this.renderClock();
    }

    stopTicker() {
        if (this.ticker) {
            // Fold the running stretch into the total so a pause does not lose it.
            if (this.startedAt) this.elapsedMs += Date.now() - this.startedAt;
            this.startedAt = null;
            clearInterval(this.ticker);
            this.ticker = null;
        }
    }

    currentMs() {
        return this.elapsedMs + (this.startedAt ? Date.now() - this.startedAt : 0);
    }

    renderClock() {
        const clock = document.getElementById('meeting-clock');
        if (clock) {
            const total = Math.floor(this.currentMs() / 1000);
            const pad = (n) => String(n).padStart(2, '0');
            clock.textContent =
                `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
        }

        const meta = document.getElementById('meeting-meta');
        if (meta) {
            const n = sessionStore.totalSegmentCount?.() ?? 0;
            if (!this.app.isRunning && n === 0) {
                meta.textContent = this.ended ? 'Ended · saved to Library' : 'Not started';
            } else {
                const s = settingsManager.get();
                const src = s.source_language || 'auto';
                const tgt = s.target_language || 'vi';
                // ja→ja translates nothing; say what is actually happening.
                const pair = this.translateLive && src !== tgt
                    ? `${src}→${tgt}`
                    : 'transcript only';
                meta.textContent = `${n} segments · ${pair}`;
            }
        }

        document.getElementById('meeting-led')?.classList.toggle('recording', this.app.isRunning);
    }

    updateButtons() {
        this.syncClock();

        const label = document.getElementById('btn-meeting-label');
        if (label) {
            label.textContent = this.app.isRunning ? 'End meeting' : 'Start recording';
        }

        const start = document.getElementById('btn-meeting-start');
        if (start) start.classList.toggle('recording', this.app.isRunning);

        const pause = document.getElementById('btn-meeting-pause');
        if (pause) pause.disabled = !this.app.isRunning;

        const sum = document.getElementById('btn-meeting-summarize');
        if (sum) {
            sum.disabled = this.summarizing || !this.hasRecord();
            sum.textContent = this.summarizing ? 'Summarising…' : 'Summarise';
        }

        // Disabled while recording: clearing the screen under a live meeting
        // would leave Copy and Summarise working on text no longer shown.
        const clear = document.getElementById('btn-meeting-clear');
        if (clear) clear.disabled = this.app.isRunning || this.summarizing;

        const resum = document.getElementById('btn-meeting-resummarize');
        if (resum) {
            resum.disabled = this.summarizing;
            resum.textContent = this.summarizing ? 'Summarising…' : 'Summarise again';
        }

        this.renderClock();
    }
}
