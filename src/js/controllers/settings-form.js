/**
 * The Settings wizard: screen navigation, home-card summaries, and the
 * form <-> settings-object mapping in both directions.
 */
import { settingsManager } from '../settings.js';
import { showToast } from '../util/toast.js';
import { esc, escAttr } from '../util/html.js';
import { refreshKeyStatus, testConnection } from '../settings/key-validation.js';

/** The "key missing" fragment for a home-card subtitle. Static markup, so it
 *  never carries anything that needs escaping. */
const WARN_NO_KEY =
    '<span class="sub-warn"><svg class="ic ic-sm" viewBox="0 0 24 24">'
    + '<use href="#i-warn" /></svg>no API key yet</span>';

export class SettingsFormController {
    constructor(app) {
        this.app = app;
    }

    bindEvents() {
        // Toggle API key visibility
        document.getElementById('btn-toggle-key').addEventListener('click', () => {
            const input = document.getElementById('input-api-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        document.getElementById('btn-toggle-openai-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-openai-key');
            if (input) input.type = input.type === 'password' ? 'text' : 'password';
        });

        document.getElementById('link-openai')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://platform.openai.com/api-keys');
        });

        // Inline key format validation + engine-option enable/disable
        const sonioxInput = document.getElementById('input-api-key');
        const openaiInput = document.getElementById('input-openai-key');
        sonioxInput?.addEventListener('input', () => refreshKeyStatus());
        openaiInput?.addEventListener('input', () => refreshKeyStatus());

        // Test-connection buttons
        document.getElementById('btn-test-soniox')?.addEventListener('click', () => testConnection('soniox'));
        document.getElementById('btn-test-openai')?.addEventListener('click', () => testConnection('openai'));

        // Soniox link
        document.getElementById('link-soniox').addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://console.soniox.com/signup/');
        });

        // ElevenLabs link
        document.getElementById('link-elevenlabs')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://elevenlabs.io/app/sign-up');
        });

        // Save settings — both top and bottom buttons
        document.getElementById('btn-save-settings').addEventListener('click', () => {
            this.save();
        });
        document.getElementById('btn-save-settings-top')?.addEventListener('click', () => {
            this.save();
        });

        // Slider live updates
        document.getElementById('range-opacity').addEventListener('input', (e) => {
            document.getElementById('opacity-value').textContent = `${e.target.value}%`;
        });

        document.getElementById('range-font-size').addEventListener('input', (e) => {
            document.getElementById('font-size-value').textContent = `${e.target.value}px`;
        });

        document.getElementById('range-max-lines').addEventListener('input', (e) => {
            document.getElementById('max-lines-value').textContent = e.target.value;
        });

        document.getElementById('select-summary-provider')?.addEventListener('change', () => {
            this.syncSummarySections();
        });

        document.getElementById('btn-toggle-gemini-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-gemini-key');
            if (input) input.type = input.type === 'password' ? 'text' : 'password';
        });

        document.getElementById('range-subtitle-font')?.addEventListener('input', (e) => {
            document.getElementById('subtitle-font-value').textContent = `${e.target.value}px`;
        });

        // 0 means "leave the cue up"; anything else is a plain second count.
        document.getElementById('range-subtitle-hold')?.addEventListener('input', (e) => {
            const v = parseInt(e.target.value, 10);
            document.getElementById('subtitle-hold-value').textContent = v === 0 ? 'keep' : `${v}s`;
        });

        document.getElementById('range-endpoint-delay')?.addEventListener('input', (e) => {
            document.getElementById('endpoint-delay-value').textContent = `${(e.target.value / 1000).toFixed(1)}s`;
        });

        // Settings wizard navigation: home cards open detail screens, back rows return home
        document.querySelectorAll('.settings-card, .settings-back-row').forEach(el => {
            el.addEventListener('click', () => {
                if (el.classList.contains('disabled')) return;
                this.showScreen(el.dataset.screen);
            });
        });

        // Add translation term row
        document.getElementById('btn-add-term')?.addEventListener('click', () => {
            this.addTermRow('', '');
        });

        // Add general context row
        document.getElementById('btn-add-general')?.addEventListener('click', () => {
            this.addGeneralRow('', '');
        });
    }

    /** Wizard: show one settings screen (home or a detail) inside the settings view. */
    showScreen(id) {
        if (!id || !document.getElementById(id)) id = 'settings-home';
        document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
        document.getElementById(id).classList.add('active');
        if (id === 'settings-home') this.updateCards();
        document.querySelector('.settings-body')?.scrollTo(0, 0);
    }

    /** Wizard: refresh the home cards' status subtitles from current settings. */
    updateCards() {
        const s = settingsManager.get();
        const mode = s.translation_mode || 'soniox';
        const engineNames = { soniox: 'Soniox', local: 'Local MLX', openai: 'OpenAI Realtime', qwen: 'Qwen LiveTranslate' };
        const keyField = { soniox: 'soniox_api_key', openai: 'openai_api_key', qwen: 'qwen_api_key' };
        const hasKey = mode === 'local' || !!(s[keyField[mode]] || '').trim();
        const subT = document.getElementById('card-translation-sub');
        if (subT) {
            subT.innerHTML =
                `${esc(engineNames[mode] || mode)} · ${esc(s.source_language || 'auto')} → ${esc(s.target_language || 'vi')}` +
                (hasKey ? '' : ' · ' + WARN_NO_KEY);
        }

        // TTS card: cloud-realtime engines run text-only — reflect on the card, never hide.
        const isCloudRealtime = mode === 'openai' || mode === 'qwen';
        const provNames = {
            edge: 'Edge TTS', microsoft: 'Microsoft v2', 'google-free': 'Google TTS Free',
            tiktok: 'TikTok TTS', local: 'Local (Offline)', google: 'Google Chirp HD', elevenlabs: 'ElevenLabs',
        };
        const cardTts = document.getElementById('card-tts');
        const subTts = document.getElementById('card-tts-sub');
        if (cardTts) cardTts.classList.toggle('disabled', isCloudRealtime);
        if (subTts) {
            if (isCloudRealtime) {
                subTts.textContent = `Off — the ${engineNames[mode]} engine is text-only and cannot speak`;
            } else {
                const prov = s.tts_provider || 'edge';
                const voice = prov === 'local' && s.local_tts_voice ? ` · ${s.local_tts_voice}` : '';
                subTts.textContent = `${provNames[prov] || prov}${voice}`;
            }
        }

        // Summary card: name the model that will write it, and warn up front if
        // its key is missing — finding that out only when a meeting ends is too
        // late to be useful.
        const sumProv = s.summary_provider || 'openai';
        const sumNames = { openai: 'OpenAI', qwen: 'Qwen', gemini: 'Gemini' };
        const sumKeyField = { openai: 'openai_api_key', qwen: 'qwen_api_key', gemini: 'gemini_api_key' };
        const sumDefaults = { openai: 'gpt-4.1-mini', qwen: 'qwen-plus', gemini: 'gemini-2.5-flash' };
        const subSum = document.getElementById('card-summary-sub');
        if (subSum) {
            const hasSumKey = !!(s[sumKeyField[sumProv]] || '').trim();
            const model = (s.summary_model || '').trim() || sumDefaults[sumProv];
            subSum.innerHTML =
                `${esc(sumNames[sumProv] || sumProv)} · ${esc(model)}` +
                (hasSumKey ? '' : ' · ' + WARN_NO_KEY);
        }
    }

    /** The Gemini key field only exists for Gemini — no engine uses that key. */
    syncSummarySections() {
        const provider = document.getElementById('select-summary-provider')?.value || 'openai';
        const geminiSection = document.getElementById('section-gemini-key');
        if (geminiSection) geminiSection.style.display = provider === 'gemini' ? '' : 'none';
    }

    populate() {
        const s = settingsManager.get();

        document.getElementById('input-api-key').value = s.soniox_api_key || '';
        const openaiKeyInput = document.getElementById('input-openai-key');
        if (openaiKeyInput) openaiKeyInput.value = s.openai_api_key || '';
        const qwenKeyInput = document.getElementById('input-qwen-key');
        if (qwenKeyInput) qwenKeyInput.value = s.qwen_api_key || '';
        document.getElementById('select-source-lang').value = s.source_language || 'auto';
        document.getElementById('select-target-lang').value = s.target_language || 'vi';
        document.getElementById('select-translation-mode').value = s.translation_mode || 'soniox';
        this.app.engineUi.updateModeUI(s.translation_mode || 'soniox');
        refreshKeyStatus();

        // Translation type (one-way / two-way)
        const translationType = s.translation_type || 'one_way';
        document.getElementById('select-translation-type').value = translationType;
        this.app.engineUi.updateTranslationTypeUI(translationType);

        // Two-way language selects
        document.getElementById('select-lang-a').value = s.language_a || 'ja';
        document.getElementById('select-lang-b').value = s.language_b || 'vi';

        // Strict language detection
        document.getElementById('check-strict-lang').checked = s.language_hints_strict || false;

        // Endpoint delay
        const endpointDelay = s.endpoint_delay || 3000;
        const delaySlider = document.getElementById('range-endpoint-delay');
        if (delaySlider) delaySlider.value = endpointDelay;
        const delayValue = document.getElementById('endpoint-delay-value');
        if (delayValue) delayValue.textContent = `${(endpointDelay / 1000).toFixed(1)}s`;

        // Audio source radio
        const radioValue = s.audio_source || 'system';
        const radio = document.querySelector(`input[name="audio-source"][value="${radioValue}"]`);
        if (radio) radio.checked = true;

        // Display
        const opacityPercent = Math.round((s.overlay_opacity || 1.0) * 100);
        document.getElementById('range-opacity').value = opacityPercent;
        document.getElementById('opacity-value').textContent = `${opacityPercent}%`;

        document.getElementById('range-font-size').value = s.font_size || 16;
        document.getElementById('font-size-value').textContent = `${s.font_size || 16}px`;

        document.getElementById('range-max-lines').value = s.max_lines || 5;
        document.getElementById('max-lines-value').textContent = s.max_lines || 5;

        document.getElementById('check-show-original').checked = s.show_original !== false;

        // Subtitle overlay
        const subFont = s.subtitle_font_size ?? 30;
        const subFontEl = document.getElementById('range-subtitle-font');
        if (subFontEl) {
            subFontEl.value = subFont;
            document.getElementById('subtitle-font-value').textContent = `${subFont}px`;
        }
        const holdSec = Math.round((s.subtitle_hold_ms ?? 5000) / 1000);
        const holdEl = document.getElementById('range-subtitle-hold');
        if (holdEl) {
            holdEl.value = holdSec;
            document.getElementById('subtitle-hold-value').textContent = holdSec === 0 ? 'keep' : `${holdSec}s`;
        }
        // Summary
        const provSel = document.getElementById('select-summary-provider');
        if (provSel) provSel.value = s.summary_provider || 'openai';
        const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        setVal('input-summary-model', s.summary_model || '');
        setVal('input-gemini-key', s.gemini_api_key || '');
        setVal('input-summary-language', s.summary_language || 'English');
        setVal('input-summary-prompt', s.summary_prompt || '');
        this.syncSummarySections();

        const subOn = document.getElementById('check-subtitle-enabled');
        if (subOn) subOn.checked = !!s.subtitle_enabled;
        const subOrig = document.getElementById('check-subtitle-original');
        if (subOrig) subOrig.checked = s.subtitle_show_original !== false;
        const subBoxed = document.getElementById('check-subtitle-boxed');
        if (subBoxed) subBoxed.checked = !!s.subtitle_boxed;

        // Custom context (rich format)
        const ctx = s.custom_context;
        // General context rows
        const generalList = document.getElementById('context-general-list');
        if (generalList) {
            generalList.innerHTML = '';
            const generalPairs = ctx?.general || [];
            generalPairs.forEach(g => this.addGeneralRow(g.key, g.value));
        }
        // Transcription terms
        const termsInput = document.getElementById('input-context-terms');
        if (termsInput) {
            termsInput.value = (ctx?.terms || []).join('\n');
        }
        // Background text
        const textInput = document.getElementById('input-context-text');
        if (textInput) {
            textInput.value = ctx?.text || '';
        }
        // Load translation terms as rows
        const termsList = document.getElementById('translation-terms-list');
        if (termsList) {
            termsList.innerHTML = '';
            const terms = ctx?.translation_terms || [];
            terms.forEach(t => this.addTermRow(t.source, t.target));
        }

        // TTS settings
        document.getElementById('input-elevenlabs-key').value = s.elevenlabs_api_key || '';
        document.getElementById('select-tts-voice').value = s.tts_voice_id || '21m00Tcm4TlvDq8ikWAM';
        // Edge TTS settings
        const edgeVoiceSelect = document.getElementById('select-edge-voice');
        if (edgeVoiceSelect) edgeVoiceSelect.value = s.edge_tts_voice || 'vi-VN-HoaiMyNeural';
        const edgeSpeedSlider = document.getElementById('range-edge-speed');
        const edgeSpeedLabel = document.getElementById('edge-speed-value');
        const edgeSpeed = s.edge_tts_speed !== undefined ? s.edge_tts_speed : 20;
        if (edgeSpeedSlider) edgeSpeedSlider.value = edgeSpeed;
        if (edgeSpeedLabel) edgeSpeedLabel.textContent = (edgeSpeed >= 0 ? '+' : '') + edgeSpeed + '%';

        // Google TTS settings
        const googleKeyInput = document.getElementById('input-google-tts-key');
        if (googleKeyInput) googleKeyInput.value = s.google_tts_api_key || '';
        const googleVoiceSelect = document.getElementById('select-google-voice');
        if (googleVoiceSelect) googleVoiceSelect.value = s.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';
        const googleSpeedSlider = document.getElementById('range-google-speed');
        const googleSpeedLabel = document.getElementById('google-speed-value');
        const googleSpeed = s.google_tts_speed || 1.0;
        if (googleSpeedSlider) googleSpeedSlider.value = googleSpeed;
        if (googleSpeedLabel) googleSpeedLabel.textContent = googleSpeed + 'x';

        // Microsoft v2 settings (voice populated dynamically in _updateTTSProviderUI)
        const msVoiceSelect = document.getElementById('select-microsoft-voice');
        if (msVoiceSelect) msVoiceSelect.value = s.microsoft_v2_voice || 'vi-VN-HoaiMyNeural';
        const msSpeedSlider = document.getElementById('range-microsoft-speed');
        const msSpeedLabel = document.getElementById('microsoft-speed-value');
        const msSpeed = s.microsoft_v2_speed !== undefined ? s.microsoft_v2_speed : 20;
        if (msSpeedSlider) msSpeedSlider.value = msSpeed;
        if (msSpeedLabel) msSpeedLabel.textContent = (msSpeed >= 0 ? '+' : '') + msSpeed + '%';

        // Google Free settings
        const gfKeyInput = document.getElementById('input-google-free-key');
        if (gfKeyInput) gfKeyInput.value = s.google_free_api_key || '';
        const gfVoiceSelect = document.getElementById('select-google-free-voice');
        if (gfVoiceSelect) gfVoiceSelect.value = s.google_free_voice || 'vi-VN';
        const gfSpeed = s.google_free_speed || 1.0;
        const gfSpeedSlider = document.getElementById('range-google-free-speed');
        const gfSpeedLabel = document.getElementById('google-free-speed-value');
        if (gfSpeedSlider) gfSpeedSlider.value = gfSpeed;
        if (gfSpeedLabel) gfSpeedLabel.textContent = parseFloat(gfSpeed).toFixed(1) + 'x';

        // TikTok settings
        const ttVoiceSelect = document.getElementById('select-tiktok-voice');
        if (ttVoiceSelect) ttVoiceSelect.value = s.tiktok_voice || 'BV074_streaming';
        const ttSession = document.getElementById('input-tiktok-session');
        if (ttSession) ttSession.value = s.tiktok_session_id || '';
        const ttSpeed = s.tiktok_speed || 1.0;
        const ttSpeedSlider = document.getElementById('range-tiktok-speed');
        const ttSpeedLabel = document.getElementById('tiktok-speed-value');
        if (ttSpeedSlider) ttSpeedSlider.value = ttSpeed;
        if (ttSpeedLabel) ttSpeedLabel.textContent = parseFloat(ttSpeed).toFixed(1) + 'x';

        // TTS provider
        const providerSelect = document.getElementById('select-tts-provider');
        if (providerSelect) {
            providerSelect.value = s.tts_provider || 'edge';
            this.app.tts.updateProviderUI(providerSelect.value);
        }
    }

    async save() {
        const settings = {
            soniox_api_key: document.getElementById('input-api-key').value.trim(),
            openai_api_key: document.getElementById('input-openai-key')?.value.trim() || '',
            qwen_api_key: document.getElementById('input-qwen-key')?.value.trim() || '',
            source_language: document.getElementById('select-source-lang').value,
            target_language: document.getElementById('select-target-lang').value,
            translation_mode: document.getElementById('select-translation-mode').value,
            translation_type: document.getElementById('select-translation-type')?.value || 'one_way',
            language_a: document.getElementById('select-lang-a')?.value || 'ja',
            language_b: document.getElementById('select-lang-b')?.value || 'vi',
            language_hints_strict: document.getElementById('check-strict-lang')?.checked || false,
            endpoint_delay: parseInt(document.getElementById('range-endpoint-delay')?.value || 3000),
            audio_source: document.querySelector('input[name="audio-source"]:checked')?.value || 'system',
            overlay_opacity: parseInt(document.getElementById('range-opacity').value) / 100,
            font_size: parseInt(document.getElementById('range-font-size').value),
            max_lines: parseInt(document.getElementById('range-max-lines').value),
            show_original: document.getElementById('check-show-original').checked,
            subtitle_font_size: parseInt(document.getElementById('range-subtitle-font')?.value || 30, 10),
            subtitle_hold_ms: parseInt(document.getElementById('range-subtitle-hold')?.value || 5, 10) * 1000,
            subtitle_enabled: document.getElementById('check-subtitle-enabled')?.checked || false,
            subtitle_show_original: document.getElementById('check-subtitle-original')?.checked !== false,
            subtitle_boxed: document.getElementById('check-subtitle-boxed')?.checked || false,
            summary_provider: document.getElementById('select-summary-provider')?.value || 'openai',
            summary_model: document.getElementById('input-summary-model')?.value.trim() || '',
            gemini_api_key: document.getElementById('input-gemini-key')?.value.trim() || '',
            summary_language: document.getElementById('input-summary-language')?.value.trim() || 'English',
            summary_prompt: document.getElementById('input-summary-prompt')?.value || '',
            custom_context: null,
        };

        // Parse custom context (rich format)
        // General key-value pairs
        const generalPairs = [];
        document.querySelectorAll('#context-general-list .general-row').forEach(row => {
            const key = row.querySelector('.general-key')?.value.trim();
            const value = row.querySelector('.general-value')?.value.trim();
            if (key && value) generalPairs.push({ key, value });
        });

        // Transcription terms
        const termsRaw = document.getElementById('input-context-terms')?.value.trim() || '';
        const terms = termsRaw ? termsRaw.split('\n').map(t => t.trim()).filter(t => t) : [];

        // Background text
        const contextText = document.getElementById('input-context-text')?.value.trim() || '';

        // Translation terms
        const translationTerms = [];
        document.querySelectorAll('#translation-terms-list .term-row').forEach(row => {
            const source = row.querySelector('.term-source')?.value.trim();
            const target = row.querySelector('.term-target')?.value.trim();
            if (source && target) translationTerms.push({ source, target });
        });

        if (generalPairs.length > 0 || terms.length > 0 || contextText || translationTerms.length > 0) {
            settings.custom_context = {
                general: generalPairs,
                terms: terms,
                text: contextText || null,
                translation_terms: translationTerms,
            };
        }

        // TTS settings
        settings.tts_provider = document.getElementById('select-tts-provider')?.value || 'edge';
        settings.elevenlabs_api_key = document.getElementById('input-elevenlabs-key').value.trim();
        settings.tts_voice_id = document.getElementById('select-tts-voice').value;
        settings.edge_tts_voice = document.getElementById('select-edge-voice')?.value || 'vi-VN-HoaiMyNeural';
        settings.edge_tts_speed = parseInt(document.getElementById('range-edge-speed')?.value || 20);
        settings.tts_speed = parseFloat(document.getElementById('range-tts-speed')?.value || 1.2);
        settings.google_tts_api_key = document.getElementById('input-google-tts-key')?.value.trim() || '';
        settings.google_tts_voice = document.getElementById('select-google-voice')?.value || 'vi-VN-Chirp3-HD-Aoede';
        settings.google_tts_speed = parseFloat(document.getElementById('range-google-speed')?.value || 1.0);
        settings.microsoft_v2_voice = document.getElementById('select-microsoft-voice')?.value || 'vi-VN-HoaiMyNeural';
        settings.microsoft_v2_speed = parseInt(document.getElementById('range-microsoft-speed')?.value || 20);
        settings.google_free_api_key = document.getElementById('input-google-free-key')?.value.trim() || '';
        settings.google_free_voice = document.getElementById('select-google-free-voice')?.value || 'vi-VN';
        settings.google_free_speed = parseFloat(document.getElementById('range-google-free-speed')?.value || 1.0);
        settings.tiktok_voice = document.getElementById('select-tiktok-voice')?.value || 'BV074_streaming';
        settings.tiktok_speed = parseFloat(document.getElementById('range-tiktok-speed')?.value || 1.0);
        settings.tiktok_session_id = document.getElementById('input-tiktok-session')?.value.trim() || '';
        settings.local_tts_speed = parseFloat(document.getElementById('range-local-speed')?.value || 1.0);
        settings.tts_enabled = false;

        try {
            await settingsManager.save(settings);
            showToast('Settings saved', 'success');
            this.app.showView('overlay');
        } catch (err) {
            showToast(`Failed to save: ${err}`, 'error');
        }
    }

    addTermRow(source = '', target = '') {
        const list = document.getElementById('translation-terms-list');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'term-row';
        // Escaped, like addGeneralRow below: these come back from saved settings,
        // so a term containing a quote used to break out of the attribute and
        // corrupt the row on the next Settings open.
        row.innerHTML = `<input type="text" class="term-source" value="${escAttr(source)}" placeholder="Source" />` +
            `<input type="text" class="term-target" value="${escAttr(target)}" placeholder="Target" />` +
            `<button type="button" class="btn-remove-term" title="Remove">×</button>`;
        row.querySelector('.btn-remove-term').addEventListener('click', () => row.remove());
        list.appendChild(row);
    }

    addGeneralRow(key = '', value = '') {
        const list = document.getElementById('context-general-list');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'general-row';
        row.innerHTML = `<input type="text" class="general-key" value="${escAttr(key)}" placeholder="Key (e.g. domain)" />` +
            `<input type="text" class="general-value" value="${escAttr(value)}" placeholder="Value (e.g. Medical)" />` +
            `<button type="button" class="btn-remove-general" title="Remove">×</button>`;
        row.querySelector('.btn-remove-general').addEventListener('click', () => row.remove());
        list.appendChild(row);
    }
}
