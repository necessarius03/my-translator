/**
 * TTS narration: which provider is active, how it is configured, the overlay
 * toggle, and the provider panels in Settings.
 */
import { settingsManager } from '../settings.js';
import { elevenLabsTTS } from '../elevenlabs-tts.js';
import { googleTTS } from '../google-tts.js';
import { edgeTTSRust } from '../edge-tts.js';
import { microsoftTTS } from '../microsoft-tts.js';
import { googleFreeTTS } from '../google-free-tts.js';
import { tiktokTTS } from '../tiktok-tts.js';
import { localTTS } from '../local-tts.js';
import { audioPlayer } from '../audio-player.js';
import { showToast } from '../util/toast.js';

export class TtsController {
    constructor(app) {
        this.app = app;
        // Always OFF at startup — the user opts in per session.
        this.enabled = false;
        this.all = [elevenLabsTTS, edgeTTSRust, googleTTS, microsoftTTS, googleFreeTTS, tiktokTTS, localTTS];
    }

    /**
     * Wire audio + error callbacks for every provider. Single source of
     * registration so a new provider can never be silently left unwired.
     */
    initProviders() {
        for (const tts of this.all) {
            tts.onAudioChunk = (base64Audio, isFinal) => {
                audioPlayer.enqueue(base64Audio);
            };
            tts.onError = (error) => {
                console.error('[TTS]', error);
                showToast(error, 'error');
            };
        }
    }

    bindEvents() {
        // Toggle ElevenLabs API key visibility
        document.getElementById('btn-toggle-elevenlabs-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-elevenlabs-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        document.getElementById('btn-toggle-google-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-google-tts-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        document.getElementById('btn-toggle-google-free-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-google-free-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        // TTS enable/disable toggle in settings — show/hide detail
        document.getElementById('check-tts-enabled')?.addEventListener('change', (e) => {
            const detail = document.getElementById('tts-settings-detail');
            if (detail) detail.style.display = e.target.checked ? '' : 'none';
        });

        // TTS provider toggle — show/hide relevant settings panels
        document.getElementById('select-tts-provider')?.addEventListener('change', (e) => {
            this.updateProviderUI(e.target.value);
        });

        // TTS speed slider — show value
        document.getElementById('range-tts-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('tts-speed-value');
            if (label) label.textContent = e.target.value + 'x';
        });

        // Edge TTS speed slider
        document.getElementById('range-edge-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('edge-speed-value');
            const v = parseInt(e.target.value);
            if (label) label.textContent = (v >= 0 ? '+' : '') + v + '%';
        });

        document.getElementById('range-google-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('google-speed-value');
            if (label) label.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
        });

        // Microsoft v2 speed slider
        document.getElementById('range-microsoft-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('microsoft-speed-value');
            const v = parseInt(e.target.value);
            if (label) label.textContent = (v >= 0 ? '+' : '') + v + '%';
        });

        // Microsoft v2 language filter — re-fill the voice dropdown for the chosen language
        document.getElementById('select-microsoft-lang')?.addEventListener('change', (e) => {
            this.app.msVoices.fill(e.target.value);
        });

        // Local offline: language filter re-renders the voice list
        document.getElementById('select-local-lang')?.addEventListener('change', (e) => {
            this.app.localVoices.fill(e.target.value);
        });

        // Local offline: speed slider (0.5x–2.0x)
        document.getElementById('range-local-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('local-speed-value');
            if (label) label.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
        });

        // Google-free / TikTok: client-side speed sliders (0.5x–2.0x)
        document.getElementById('range-google-free-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('google-free-speed-value');
            if (label) label.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
        });
        document.getElementById('range-tiktok-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('tiktok-speed-value');
            if (label) label.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
        });

        // Local offline: change model storage folder
        document.getElementById('btn-local-change-dir')?.addEventListener('click', () => {
            this.app.localVoices.pickModelsDir();
        });

        // Local offline: reset model folder back to the default app location
        document.getElementById('btn-local-reset-dir')?.addEventListener('click', () => {
            this.app.localVoices.resetModelsDir();
        });

        // TikTok: paste a "Copy as cURL" and auto-extract the sessionid cookie into the field
        document.getElementById('input-tiktok-curl')?.addEventListener('input', (e) => {
            const m = e.target.value.match(/sessionid=([^;"'\s\\]+)/i);
            const sidInput = document.getElementById('input-tiktok-session');
            if (m && m[1] && sidInput && sidInput.value !== m[1]) {
                sidInput.value = m[1];
                showToast('sessionid extracted from cURL', 'success');
            }
        });

        // TTS toggle button in overlay
        document.getElementById('btn-tts').addEventListener('click', () => {
            this.toggle();
        });
    }

    async toggle() {
        const settings = settingsManager.get();
        const provider = settings.tts_provider || 'edge';

        // Block TTS in two-way mode to prevent audio feedback loop
        const translationType = document.getElementById('select-translation-type')?.value;
        if (translationType === 'two_way') {
            showToast('TTS is disabled in two-way mode to prevent audio loop', 'error');
            return;
        }

        // Local provider: the selected voice must actually be downloaded (async check).
        // Only gate when turning ON (turning off never needs a model).
        if (provider === 'local' && !this.enabled) {
            const installed = await this.app.localVoices.isInstalled(settings.local_tts_voice);
            if (!installed) {
                showToast('Download a voice in Settings → TTS → Local', 'error');
                this.app.showView('settings');
                return;
            }
        }

        // Check credentials for providers that require them (free providers need none)
        if (provider === 'elevenlabs' && !settings.elevenlabs_api_key) {
            showToast('Add ElevenLabs API key in Settings → TTS', 'error');
            this.app.showView('settings');
            return;
        }
        if (provider === 'google' && !settings.google_tts_api_key) {
            showToast('Add Google TTS API key in Settings → TTS', 'error');
            this.app.showView('settings');
            return;
        }
        if (provider === 'tiktok' && !settings.tiktok_session_id) {
            showToast('Add a TikTok sessionid in Settings → TTS', 'error');
            this.app.showView('settings');
            return;
        }

        this.enabled = !this.enabled;
        this.updateButton();

        const tts = this.active();

        if (this.enabled) {
            this.configure(tts, settings);
            if (this.app.isRunning) {
                tts.connect();
                audioPlayer.resume();
            }
            const label = {
                edge: 'Edge TTS (Free)',
                microsoft: 'Microsoft v2 (Free)',
                'google-free': 'Google TTS (Free)',
                tiktok: 'TikTok TTS (Free)',
                local: 'Local Offline',
                google: 'Google Chirp 3 HD',
                elevenlabs: 'ElevenLabs',
            }[provider] || provider;
            showToast(`TTS narration on — ${label}`, 'success');
        } else {
            tts.disconnect();
            audioPlayer.stop();
            showToast('TTS narration off', 'success');
        }
    }

    /** The provider object for the saved tts_provider, Edge as the fallback. */
    active() {
        const provider = settingsManager.get().tts_provider || 'edge';
        const map = {
            edge: edgeTTSRust,
            microsoft: microsoftTTS,
            'google-free': googleFreeTTS,
            tiktok: tiktokTTS,
            local: localTTS,
            google: googleTTS,
            elevenlabs: elevenLabsTTS,
        };
        const tts = map[provider];
        if (!tts) {
            console.warn(`[TTS] Unknown provider "${provider}", falling back to Edge`);
            return edgeTTSRust;
        }
        return tts;
    }

    configure(tts, settings) {
        const provider = settings.tts_provider || 'edge';
        // Client-side playback speed ONLY for providers whose endpoint has no rate param
        // (Google-free, TikTok). Others apply speed server-side / in the engine → keep 1.0.
        const clientRate =
            provider === 'google-free' ? (settings.google_free_speed || 1.0) :
            provider === 'tiktok' ? (settings.tiktok_speed || 1.0) : 1.0;
        audioPlayer.setPlaybackRate(clientRate);
        if (provider === 'elevenlabs') {
            tts.configure({
                apiKey: settings.elevenlabs_api_key,
                voiceId: settings.tts_voice_id || '21m00Tcm4TlvDq8ikWAM',
            });
        } else if (provider === 'google') {
            const voice = settings.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';
            const langCode = voice.replace(/-Chirp3.*/, '');
            tts.configure({
                apiKey: settings.google_tts_api_key,
                voice: voice,
                languageCode: langCode,
                speakingRate: settings.google_tts_speed || 1.0,
            });
        } else if (provider === 'microsoft') {
            tts.configure({
                voice: settings.microsoft_v2_voice || 'vi-VN-HoaiMyNeural',
                speed: settings.microsoft_v2_speed !== undefined ? settings.microsoft_v2_speed : 20,
            });
        } else if (provider === 'google-free') {
            tts.configure({
                voice: settings.google_free_voice || 'vi-VN',
                apiKey: settings.google_free_api_key || '',
            });
        } else if (provider === 'tiktok') {
            tts.configure({
                voice: settings.tiktok_voice || 'BV074_streaming',
                sessionId: settings.tiktok_session_id || '',
            });
        } else if (provider === 'local') {
            tts.configure({
                voice: settings.local_tts_voice || 'vi_VN-vais1000-medium',
                speed: settings.local_tts_speed || 1.0,
            });
        } else {
            tts.configure({
                voice: settings.edge_tts_voice || 'vi-VN-HoaiMyNeural',
                speed: settings.edge_tts_speed !== undefined ? settings.edge_tts_speed : 20,
            });
        }
    }

    updateProviderUI(provider) {
        // Show only the active provider's settings panel.
        const panels = {
            edge: 'tts-edge-settings',
            microsoft: 'tts-microsoft-settings',
            'google-free': 'tts-google-free-settings',
            tiktok: 'tts-tiktok-settings',
            local: 'tts-local-settings',
            google: 'tts-google-settings',
            elevenlabs: 'tts-elevenlabs-settings',
        };
        for (const [id, elId] of Object.entries(panels)) {
            const el = document.getElementById(elId);
            if (el) el.style.display = provider === id ? '' : 'none';
        }
        // Update hint text
        const hint = document.getElementById('tts-provider-hint');
        if (hint) {
            const hints = {
                edge: 'Free, natural voices — no API key needed',
                microsoft: 'Free — full Microsoft voice list (vi + en), sent to Microsoft',
                'google-free': 'Free — experimental, may stop working anytime. Text sent to Google',
                tiktok: 'Free — needs a TikTok sessionid. Text sent to TikTok',
                local: 'Free & 100% offline — download a voice below; nothing is sent anywhere',
                google: 'Near-human quality — requires Google Cloud API key (1M chars/month free)',
                elevenlabs: 'Premium quality — requires ElevenLabs API key',
            };
            hint.textContent = hints[provider] || '';
        }
        // Microsoft v2: populate the full voice list dynamically (fallback stays in HTML).
        if (provider === 'microsoft') this.app.msVoices.populate();
        // Local: fetch catalog + install state and render the downloadable voice list.
        if (provider === 'local') this.app.localVoices.populate();
    }

    updateButton() {
        const btn = document.getElementById('btn-tts');
        const iconOff = document.getElementById('icon-tts-off');
        const iconOn = document.getElementById('icon-tts-on');
        const isTwoWay = document.getElementById('select-translation-type')?.value === 'two_way';

        if (btn) {
            btn.classList.toggle('active', this.enabled);
            btn.classList.toggle('disabled', isTwoWay);
            btn.title = isTwoWay ? 'TTS disabled in two-way mode' : 'Toggle TTS (Ctrl+T)';
        }
        if (iconOff) iconOff.style.display = this.enabled ? 'none' : 'block';
        if (iconOn) iconOn.style.display = this.enabled ? 'block' : 'none';
    }

    speakIfEnabled(text) {
        if (this.enabled && text?.trim()) {
            this.active().speak(text);
        }
    }
}
