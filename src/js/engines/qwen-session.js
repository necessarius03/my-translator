/** Qwen LiveTranslate Flash. Translation-only (no source transcript). */
import { settingsManager } from '../settings.js';
import { sessionStore } from '../session-store.js';
import { showToast } from '../util/toast.js';
import { ReconnectPolicy } from './reconnect.js';

const { invoke } = window.__TAURI__.core;

export class QwenSession {
    constructor(app) {
        this.app = app;
        this.client = null;
        this.reconnect = new ReconnectPolicy();
    }

    async start(settings) {
        // Drop the previous client first. On a reconnect the superseded session
        // is still live on the backend, and its callbacks would keep firing.
        await this.dropClient();

        this.app.live.updateStatus('connecting');
        const { QwenRealtimeClient } = await import('../qwen-realtime-client.js');

        // Live Flash is translation-only (no source transcript). Force the
        // single-panel translation view; dual-panel would render an empty
        // source column.
        this.app.transcriptUI.provider = 'qwen';

        // Captured per attempt: every callback below ignores events from a
        // client this engine has already replaced.
        const client = new QwenRealtimeClient();
        this.client = client;

        client.onStatusChange = (state) => {
            if (this.client !== client) return;
            if (state === 'ready') {
                this.reconnect.markConnected();
                this.app.live.updateStatus('connected');
            } else if (state === 'connecting') {
                this.app.live.updateStatus('connecting');
            }
        };
        client.onProvisional = (text) => {
            if (this.client !== client) return;
            this.app.transcriptUI.setProvisional(text, null, null);
        };
        client.onSegment = (sourceText, translatedText) => {
            if (this.client !== client) return;
            this.app.transcriptUI.addTranslation(translatedText);
            sessionStore.addSegment('', translatedText || '');
            this.app.transcriptUI.clearProvisional();
        };
        client.onError = (code, msg) => {
            if (this.client !== client) return;
            console.error('[Qwen Realtime]', code, msg);
            showToast(`${code}: ${msg}`, 'error');
            this.app.live.updateStatus('error');
        };
        client.onClosed = (reason) => {
            // A replaced client must never resurrect the session — that is what
            // turned one drop into an exponential reconnect storm.
            if (this.client !== client) return;
            console.warn('[Qwen Realtime] closed:', reason);
            if (!this.app.isRunning) return;

            const delay = this.reconnect.nextDelay();
            if (delay === null) {
                showToast('Qwen keeps dropping the connection — gave up retrying', 'error');
                this.app.live.pause();
                return;
            }
            showToast(`Qwen disconnected — retrying in ${delay / 1000}s…`, 'success');
            setTimeout(() => {
                if (this.app.isRunning && this.client === client) {
                    this.start(settingsManager.get());
                }
            }, delay);
        };

        try {
            // Live Flash rejects "auto" — fall back to English. UI also
            // strips the "auto" option when engine = qwen (see
            // EngineUiController.refreshSourceLangs), so this is belt-and-suspenders.
            const sourceLang =
                settings.source_language && settings.source_language !== 'auto'
                    ? settings.source_language
                    : 'en';
            await client.connect({
                apiKey: settings.qwen_api_key,
                sourceLanguage: sourceLang,
                targetLanguage: settings.target_language,
            });
        } catch (err) {
            showToast(`Qwen connect failed: ${err}`, 'error');
            await this.app.live.pause();
            return;
        }

        try {
            let audioBatchCount = 0;
            const channel = new window.__TAURI__.core.Channel();
            channel.onmessage = (pcmData) => {
                audioBatchCount++;
                if (audioBatchCount <= 3 || audioBatchCount % 50 === 0) {
                    console.log(`[Qwen capture] batch #${audioBatchCount}, size:`, pcmData?.length || 0);
                }
                if (this.client !== client) return; // capture outlived its session
                const bytes = new Uint8Array(pcmData);
                client.sendAudio(bytes.buffer);
            };
            console.log('[Qwen] Starting audio capture, source:', this.app.currentSource);
            await invoke('start_capture', {
                source: this.app.currentSource,
                channel,
            });
            console.log('[Qwen] start_capture invoked OK');
        } catch (err) {
            console.error('Failed to start audio capture:', err);
            showToast(`Audio error: ${err}`, 'error');
            await this.app.live.pause();
        }
    }

    /** Detach and tear down the current client, if any. Safe to call twice. */
    async dropClient() {
        const prev = this.client;
        if (!prev) return;
        // Clear the reference BEFORE disconnecting so the resulting `closed`
        // event fails the `this.client !== client` guard instead of scheduling
        // another reconnect.
        this.client = null;
        try { await prev.disconnect(); } catch { /* already gone */ }
    }

    async stop() {
        this.reconnect.reset();
        await this.dropClient();
        try { await invoke('stop_capture'); } catch {}
        this.app.live.updateStatus('disconnected');
    }
}
