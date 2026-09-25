/** Microsoft v2 voice catalogue for the Settings TTS screen. */
import { settingsManager } from '../settings.js';
import { microsoftTTS } from '../microsoft-tts.js';

// Static fallback for Microsoft v2 voices when the live list endpoint is unreachable.
const MS_VOICE_FALLBACK = [
    { short_name: 'vi-VN-HoaiMyNeural', friendly_name: 'HoaiMy', gender: 'Female', locale: 'vi-VN' },
    { short_name: 'vi-VN-NamMinhNeural', friendly_name: 'NamMinh', gender: 'Male', locale: 'vi-VN' },
    { short_name: 'en-US-JennyNeural', friendly_name: 'Jenny', gender: 'Female', locale: 'en-US' },
    { short_name: 'en-US-GuyNeural', friendly_name: 'Guy', gender: 'Male', locale: 'en-US' },
];

export class MicrosoftVoicePicker {
    constructor() {
        this.voices = null;
    }

    /**
     * Fetch Microsoft's vi+en voice list once (cached), then fill the voice dropdown
     * filtered by the selected Language. The Language dropdown keeps the voice list short
     * (Microsoft has ~50 English voices). Default language follows the saved voice's locale.
     */
    async populate() {
        const langSel = document.getElementById('select-microsoft-lang');
        const saved = settingsManager.get().microsoft_v2_voice || 'vi-VN-HoaiMyNeural';
        // Initialize the Language dropdown from the saved voice's locale (once).
        if (langSel && !langSel.dataset.init) {
            langSel.value = saved.startsWith('en') ? 'en' : 'vi';
            langSel.dataset.init = 'true';
        }
        if (!this.voices) {
            try {
                const voices = await microsoftTTS.listVoices();
                this.voices = (Array.isArray(voices) && voices.length) ? voices : MS_VOICE_FALLBACK;
            } catch (err) {
                console.warn('[Microsoft v2] voice list fetch failed, using static fallback:', err);
                this.voices = MS_VOICE_FALLBACK;
            }
        }
        this.fill(langSel ? langSel.value : 'vi');
    }

    /** Fill #select-microsoft-voice with cached voices for `lang` ("vi"|"en"), restoring saved. */
    fill(lang) {
        const select = document.getElementById('select-microsoft-voice');
        if (!select) return;
        const saved = settingsManager.get().microsoft_v2_voice;
        const list = (this.voices || MS_VOICE_FALLBACK).filter(v => (v.locale || '').startsWith(lang));
        select.innerHTML = '';
        for (const v of list) {
            const opt = document.createElement('option');
            opt.value = v.short_name;
            opt.textContent = `${v.friendly_name} (${v.gender})`;
            select.appendChild(opt);
        }
        // Keep the saved voice if it belongs to this language, else pick the first.
        if (saved && list.some(v => v.short_name === saved)) select.value = saved;
        else if (select.options.length) select.selectedIndex = 0;
    }
}
