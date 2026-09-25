/** Soniox cloud STT+translation. The WebSocket itself lives in soniox.js. */
import { sonioxClient } from '../soniox.js';
import { sessionStore } from '../session-store.js';
import { showToast } from '../util/toast.js';

const { invoke } = window.__TAURI__.core;

export class SonioxSession {
    constructor(app) {
        this.app = app;
        // Soniox emits original + translation as separate finals; we FIFO-pair
        // them into the session store so each saved segment has both texts.
        this.originalQueue = [];
        this.wireCallbacks();
    }

    wireCallbacks() {
        sonioxClient.onOriginal = (text, speaker, language) => {
            this.app.transcriptUI.addOriginal(text, speaker, language);
            this.originalQueue.push(text);
        };

        sonioxClient.onTranslation = (text) => {
            this.app.transcriptUI.addTranslation(text);
            const src = this.originalQueue.shift() || '';
            sessionStore.addSegment(src, text);
            this.app.tts.speakIfEnabled(text);
        };

        sonioxClient.onProvisional = (text, speaker, language) => {
            if (text) {
                this.app.transcriptUI.setProvisional(text, speaker, language);
            } else {
                this.app.transcriptUI.clearProvisional();
            }
        };

        sonioxClient.onStatusChange = (status) => {
            this.app.live.updateStatus(status);
        };

        sonioxClient.onError = (error) => {
            showToast(error, 'error');
        };

        sonioxClient.onConfidence = (avgConfidence) => {
            this.app.transcriptUI.setConfidence(avgConfidence);
        };
    }

    async start(settings) {
        // Connect to Soniox
        console.log('[App] Connecting to Soniox...');
        this.app.transcriptUI.provider = 'soniox';
        this.app.live.updateStatus('connecting');
        // Meeting mode can ask for a transcript with no translation. Soniox
        // does that by simply omitting the translation block, so the flag
        // travels as an empty target language rather than a new code path.
        const transcribeOnly = !!this.app.transcribeOnly;

        sonioxClient.connect({
            apiKey: settings.soniox_api_key,
            sourceLanguage: settings.source_language,
            targetLanguage: transcribeOnly ? null : settings.target_language,
            customContext: settings.custom_context,
            translationType: transcribeOnly ? 'one_way' : (settings.translation_type || 'one_way'),
            languageA: settings.language_a,
            languageB: settings.language_b,
            languageHintsStrict: settings.language_hints_strict || false,
            endpointDelay: settings.endpoint_delay || 3000,
        });

        // Start audio capture — Rust batches audio every 200ms, JS just forwards
        try {
            let audioChunkCount = 0;

            const channel = new window.__TAURI__.core.Channel();
            channel.onmessage = (pcmData) => {
                audioChunkCount++;
                if (audioChunkCount <= 3 || audioChunkCount % 50 === 0) {
                    console.log(`[Audio] Batch #${audioChunkCount}, size:`, pcmData?.length || 0);
                }
                // Forward batched audio to Soniox
                const bytes = new Uint8Array(pcmData);
                sonioxClient.sendAudio(bytes.buffer);
            };

            console.log('[App] Starting audio capture, source:', this.app.currentSource);
            await invoke('start_capture', {
                source: this.app.currentSource,
                channel: channel,
            });
            console.log('[App] Audio capture started successfully');
        } catch (err) {
            console.error('Failed to start audio capture:', err);
            showToast(`Audio error: ${err}`, 'error');
            await this.app.live.pause();
        }
    }

    async stop() {
        // Disconnect Soniox
        sonioxClient.disconnect();
    }
}
