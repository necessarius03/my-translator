/** OpenAI Realtime translate. WS bridge runs in Rust; this drives it. */
import { settingsManager } from '../settings.js';
import { sessionStore } from '../session-store.js';
import { showToast } from '../util/toast.js';
import { ReconnectPolicy } from './reconnect.js';

const { invoke } = window.__TAURI__.core;

export class OpenAiSession {
    constructor(app) {
        this.app = app;
        this.client = null;
        this.outputQueue = null;
        this.reconnect = new ReconnectPolicy();
    }

    async start(settings) {
        // Drop the previous client first. On a reconnect the superseded session
        // is still live on the backend, and its callbacks would keep firing.
        await this.dropClient();

        this.app.live.updateStatus('connecting');
        const { OpenAiRealtimeClient } = await import('../openai-realtime-client.js');
        const { OpenAiAudioOutputQueue } = await import('../openai-audio-output-queue.js');

        // Tell the UI which provider is active so dual-panel rendering routes
        // provisional text to the correct panel (source vs target).
        this.app.transcriptUI.provider = 'openai';

        // Captured per attempt: every callback below ignores events from a
        // client this engine has already replaced.
        const outputQueue = new OpenAiAudioOutputQueue();
        const client = new OpenAiRealtimeClient();
        this.outputQueue = outputQueue;
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
        client.onSourceProvisional = (text) => {
            if (this.client !== client) return;
            // Source-side provisional: keep dual panel responsive while ASR runs.
            this.app.transcriptUI.setSourceProvisional?.(text);
        };
        client.onSegment = (sourceText, translatedText) => {
            if (this.client !== client) return;
            // Pair source + translation atomically so FIFO matching in addTranslation works.
            if (sourceText) this.app.transcriptUI.addOriginal(sourceText, null, null);
            this.app.transcriptUI.addTranslation(translatedText);
            // Atomic write to session store — bypass UI's loose FIFO since
            // OpenAI gives us both texts in one event.
            sessionStore.addSegment(sourceText || '', translatedText || '');
            this.app.transcriptUI.clearSourceProvisional?.();
            this.app.transcriptUI.clearProvisional();
        };
        client.onError = (code, msg) => {
            if (this.client !== client) return;
            console.error('[OpenAI Realtime]', code, msg);
            showToast(`${code}: ${msg}`, 'error');
            this.app.live.updateStatus('error');
        };
        client.onClosed = (reason) => {
            // A replaced client must never resurrect the session — that is what
            // turned one drop into an exponential reconnect storm.
            if (this.client !== client) return;
            console.warn('[OpenAI Realtime] closed:', reason);
            if (!this.app.isRunning) return;

            const delay = this.reconnect.nextDelay();
            if (delay === null) {
                showToast('OpenAI keeps dropping the connection — gave up retrying', 'error');
                this.app.live.pause();
                return;
            }
            showToast(`OpenAI disconnected — retrying in ${delay / 1000}s…`, 'success');
            setTimeout(() => {
                if (this.app.isRunning && this.client === client) {
                    this.start(settingsManager.get());
                }
            }, delay);
        };

        try {
            await client.connect({
                apiKey: settings.openai_api_key,
                sourceLanguage: settings.source_language || 'auto',
                targetLanguage: settings.target_language,
                audioOutput: false,
            }, outputQueue);
        } catch (err) {
            showToast(`OpenAI connect failed: ${err}`, 'error');
            await this.app.live.pause();
            return;
        }

        try {
            let audioBatchCount = 0;
            const channel = new window.__TAURI__.core.Channel();
            channel.onmessage = (pcmData) => {
                audioBatchCount++;
                if (audioBatchCount <= 3 || audioBatchCount % 50 === 0) {
                    console.log(`[OpenAI capture] batch #${audioBatchCount}, size:`, pcmData?.length || 0);
                }
                if (this.client !== client) return; // capture outlived its session
                const bytes = new Uint8Array(pcmData);
                client.sendAudio(bytes.buffer);
            };
            console.log('[OpenAI] Starting audio capture, source:', this.app.currentSource);
            await invoke('start_capture', {
                source: this.app.currentSource,
                channel,
            });
            console.log('[OpenAI] start_capture invoked OK');
        } catch (err) {
            console.error('Failed to start audio capture:', err);
            showToast(`Audio error: ${err}`, 'error');
            await this.app.live.pause();
        }
    }

    /** Detach and tear down the current client + queue. Safe to call twice. */
    async dropClient() {
        const prev = this.client;
        const prevQueue = this.outputQueue;
        // Clear the references BEFORE disconnecting so the resulting `closed`
        // event fails the `this.client !== client` guard instead of scheduling
        // another reconnect.
        this.client = null;
        this.outputQueue = null;
        if (prev) {
            try { await prev.disconnect(); } catch { /* already gone */ }
        }
        if (prevQueue) {
            try { prevQueue.close(); } catch { /* already closed */ }
        }
    }

    async stop() {
        this.reconnect.reset();
        await this.dropClient();
        this.app.live.updateStatus('disconnected');
    }
}
