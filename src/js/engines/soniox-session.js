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
        // Set per start(): this connection asked for no translation.
        this.transcribeOnly = false;
        this.wireCallbacks();
    }

    wireCallbacks() {
        // A line no translation will ever arrive for is final as it stands and
        // goes straight into the record — it must not sit in the FIFO.
        const addUntranslated = (text, speaker, language) => {
            this.app.transcriptUI.addTranscript(text, speaker, language);
            sessionStore.addSegment(text, '');
        };

        sonioxClient.onOriginal = (text, speaker, language) => {
            if (this.transcribeOnly) {
                addUntranslated(text, speaker, language);
                return;
            }
            this.app.transcriptUI.addOriginal(text, speaker, language);
            this.originalQueue.push(text);
        };

        // Speech already in the target language, or a third language in
        // two-way mode: Soniox marks it as never to be translated.
        sonioxClient.onUntranslated = addUntranslated;

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
        // Translating a language into itself (ja→ja) is the same request.
        const source = settings.source_language;
        const sameLanguage = (settings.translation_type || 'one_way') === 'one_way'
            && source && source !== 'auto' && source === settings.target_language;
        const transcribeOnly = !!this.app.transcribeOnly || sameLanguage;
        this.transcribeOnly = transcribeOnly;

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
