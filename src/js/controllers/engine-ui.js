/**
 * Engine selection UI: the welcome picker, the toolbar pill, and every
 * Settings section whose visibility depends on the chosen engine.
 *
 * OpenAI Realtime is structurally different (text+voice fused, no two-way,
 * no custom TTS), so the choice is surfaced as a top-level decision rather
 * than buried in Settings. "Standard" represents the Soniox/Local pair —
 * they share the same UX shape (text-only, optional TTS, two-way, etc.).
 */
import { settingsManager } from '../settings.js';
import { showToast } from '../util/toast.js';
import { QWEN_LANGS } from '../qwen-langs.js';
import { audioPlayer } from '../audio-player.js';

export class EngineUiController {
    constructor(app) {
        this.app = app;
        this.pickerDismissed = false;
        // Full <option> markup, cached before an engine narrows the list.
        this.fullTargetLangHTML = null;
        this.fullSourceLangHTML = null;
    }

    bindEvents() {
        // Translation mode toggle
        document.getElementById('select-translation-mode').addEventListener('change', (e) => {
            this.updateModeUI(e.target.value);
        });

        // Welcome-screen engine cards: pick a class (standard / openai),
        // remember it, hide the picker, sync the rest of the UI.
        document.querySelectorAll('#engine-picker .engine-card').forEach(card => {
            card.addEventListener('click', () => {
                this.selectClass(card.dataset.engineClass);
                this.hidePicker();
            });
        });

        // Toolbar engine pill: same switch, available any time the session isn't
        // running. While running, the pill is locked (visual feedback only).
        document.querySelectorAll('#engine-pill .engine-pill-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (this.app.isRunning || this.app.isStarting) {
                    showToast('Pause the session before switching engine', 'error');
                    return;
                }
                this.selectClass(btn.dataset.engineClass);
            });
        });

        // Translation type toggle (one-way / two-way)
        document.getElementById('select-translation-type')?.addEventListener('change', (e) => {
            this.updateTranslationTypeUI(e.target.value);
        });
    }

    updateTranslationTypeUI(type) {
        const oneway = document.getElementById('section-oneway-langs');
        const twoway = document.getElementById('section-twoway-langs');
        const hintTwoway = document.getElementById('hint-twoway');
        const strictLang = document.getElementById('section-strict-lang');

        if (type === 'two_way') {
            if (oneway) oneway.style.display = 'none';
            if (twoway) twoway.style.display = 'flex';
            if (hintTwoway) hintTwoway.style.display = 'block';
            // Hide strict lang in two-way mode (both languages are specified)
            if (strictLang) strictLang.style.display = 'none';
            // Force-disable TTS in two-way mode to prevent audio feedback loop
            if (this.app.tts.enabled) {
                this.app.tts.enabled = false;
                this.app.tts.active().disconnect();
                audioPlayer.stop();
            }
            this.app.tts.updateButton();
        } else {
            if (oneway) oneway.style.display = 'flex';
            if (twoway) twoway.style.display = 'none';
            if (hintTwoway) hintTwoway.style.display = 'none';
            if (strictLang) strictLang.style.display = 'flex';
            this.app.tts.updateButton();
        }
    }

    classFromMode(mode) {
        if (mode === 'openai') return 'openai';
        if (mode === 'qwen') return 'qwen';
        return 'standard';
    }

    selectClass(klass) {
        const settings = settingsManager.get();
        const currentMode = settings.translation_mode || 'soniox';
        let nextMode = currentMode;
        if (klass === 'openai') {
            nextMode = 'openai';
        } else if (klass === 'qwen') {
            nextMode = 'qwen';
        } else if (klass === 'standard') {
            // Stay on whatever standard sub-engine was configured before, or
            // default to soniox if previously a cloud realtime engine.
            nextMode = (currentMode === 'soniox' || currentMode === 'local')
                ? currentMode : 'soniox';
        }

        settingsManager.save({ translation_mode: nextMode });
        const select = document.getElementById('select-translation-mode');
        if (select) select.value = nextMode;
        this.updateModeUI(nextMode);
    }

    updatePill(mode) {
        const klass = this.classFromMode(mode);
        document.querySelectorAll('#engine-pill .engine-pill-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.engineClass === klass);
        });
    }

    setPillLocked(locked) {
        const pill = document.getElementById('engine-pill');
        if (!pill) return;
        pill.dataset.locked = locked ? 'true' : 'false';
        pill.querySelectorAll('.engine-pill-btn').forEach(btn => { btn.disabled = locked; });
    }

    showPicker() {
        const picker = document.getElementById('engine-picker');
        if (picker) picker.style.display = '';
    }

    hidePicker() {
        const picker = document.getElementById('engine-picker');
        if (picker) picker.style.display = 'none';
        this.pickerDismissed = true;
    }

    maybeShowPicker() {
        // Show on each fresh launch until first dismissal (click on a card or
        // first Start). Once dismissed, the toolbar pill is the only switcher.
        if (this.pickerDismissed) return;
        if (this.app.isRunning || this.app.isStarting) return;
        if (this.app.transcriptUI && this.app.transcriptUI.hasContent()) return;
        this.showPicker();
    }

    updateModeUI(mode) {
        const isSoniox = mode === 'soniox';
        const isLocal = mode === 'local';
        const isOpenAi = mode === 'openai';
        const isQwen = mode === 'qwen';
        // Cloud-realtime engines that share the OpenAI-style audio toggle,
        // mic-only capture, and dual-panel routing. Used in place of bare
        // `isOpenAi` checks below so Qwen inherits the same UI shape.
        const isCloudRealtime = isOpenAi || isQwen;
        this.updatePill(mode);

        // Single dynamic hint line per engine (mobile parity). Only #hint-mode-soniox
        // stays visible as the live container; the other hint nodes are kept hidden
        // so existing IDs remain wired but don't clutter the panel.
        const hintSoniox = document.getElementById('hint-mode-soniox');
        const hintLocal = document.getElementById('hint-mode-local');
        const hintOpenAi = document.getElementById('hint-mode-openai');
        const hintQwen = document.getElementById('hint-mode-qwen');
        const ENGINE_HINTS = {
            soniox: 'Cloud · 70+ languages · ~$0.12/hr',
            local: 'Offline · free · ~3–4s delay',
            openai: 'Cloud · 13 languages · text-only captions',
            qwen: 'Cloud · 60+ languages · text-only · ~$7.5/1M audio tokens · pick a source language',
        };
        if (hintSoniox) {
            hintSoniox.textContent = ENGINE_HINTS[mode] || '';
            hintSoniox.style.display = '';
        }
        // Highlight a warning when the picked engine can't run yet — either
        // Local MLX on unsupported hardware, or a cloud engine missing its key.
        // The option stays selectable by request: the user needs to pick it
        // to add the key; start() blocks launch until the requirement is met.
        const s = settingsManager.get();
        const localUnsupported = isLocal && !this.app.platform.isAppleSilicon;
        const missingKey =
            (isSoniox && !(s.soniox_api_key || '').trim()) ? 'Soniox' :
            (isOpenAi && !(s.openai_api_key || '').trim()) ? 'OpenAI Realtime' :
            (isQwen && !(s.qwen_api_key || '').trim()) ? 'Qwen' : null;
        if (hintSoniox) {
            const warn = localUnsupported || !!missingKey;
            hintSoniox.classList.toggle('hint-warning', warn);
            if (localUnsupported) {
                hintSoniox.textContent = this.app.platform.os === 'macos'
                    ? 'Local MLX needs an Apple Silicon chip — this machine cannot run it, pick another engine.'
                    : 'Local MLX runs only on macOS with Apple Silicon — pick another engine on this machine.';
            } else if (missingKey) {
                hintSoniox.textContent = `${missingKey} needs an API key — enter one below before starting.`;
            }
        }
        if (hintLocal) hintLocal.style.display = 'none';
        if (hintOpenAi) hintOpenAi.style.display = 'none';
        if (hintQwen) hintQwen.style.display = 'none';

        const costWarning = document.getElementById('openai-cost-warning');
        if (costWarning) costWarning.style.display = isOpenAi ? '' : 'none';

        // Mobile-parity: show only the key section for the active engine.
        // Local hides them all (no key needed).
        const sectionApiKey = document.getElementById('section-api-key');
        const sectionOpenAiKey = document.getElementById('section-openai-key');
        const sectionQwenKey = document.getElementById('section-qwen-key');
        if (sectionApiKey) sectionApiKey.style.display = isSoniox ? '' : 'none';
        if (sectionOpenAiKey) sectionOpenAiKey.style.display = isOpenAi ? '' : 'none';
        if (sectionQwenKey) sectionQwenKey.style.display = isQwen ? '' : 'none';

        // Soniox-only features: Custom context, Strict language detection,
        // Endpoint delay. The realtime engines manage these internally.
        const sectionContext = document.getElementById('section-soniox-context');
        if (sectionContext) sectionContext.style.display = isSoniox ? '' : 'none';
        const sectionStrictLang = document.getElementById('section-strict-lang');
        if (sectionStrictLang) sectionStrictLang.style.display = isSoniox ? '' : 'none';
        const sectionEndpointDelay = document.getElementById('section-endpoint-delay');
        if (sectionEndpointDelay) sectionEndpointDelay.style.display = isSoniox ? '' : 'none';

        // Two-way mode incompatible with realtime translation engines — force
        // one-way + disable the option for any cloud-realtime mode.
        const typeSelect = document.getElementById('select-translation-type');
        if (typeSelect) {
            const twoWayOpt = typeSelect.querySelector('option[value="two_way"]');
            if (twoWayOpt) twoWayOpt.disabled = isCloudRealtime;
            if (isCloudRealtime && typeSelect.value === 'two_way') {
                typeSelect.value = 'one_way';
                this.updateTranslationTypeUI('one_way');
            }
        }

        // Custom TTS toggle: cloud realtime engines run text-only to prevent
        // the speaker → mic feedback loop on shared devices.
        const ttsCheck = document.getElementById('check-tts-enabled');
        if (ttsCheck) {
            ttsCheck.disabled = isCloudRealtime;
            if (isCloudRealtime) ttsCheck.checked = false;
            const ttsDetail = document.getElementById('tts-settings-detail');
            if (ttsDetail) ttsDetail.style.display = (isCloudRealtime || !ttsCheck.checked) ? 'none' : '';
        }
        const btnTts = document.getElementById('btn-tts');
        if (btnTts) btnTts.style.display = isCloudRealtime ? 'none' : '';

        // Wizard: TTS availability shows on the home card (disabled + reason) —
        // never hidden. If the user is inside the TTS detail when switching to a
        // cloud-realtime engine, snap back to home so the state change is visible.
        this.app.settingsForm.updateCards();
        if (isCloudRealtime && document.getElementById('tab-tts')?.classList.contains('active')) {
            this.app.settingsForm.showScreen('settings-home');
        }
        const btnOpenAiAudio = document.getElementById('btn-openai-audio');
        if (btnOpenAiAudio) btnOpenAiAudio.style.display = 'none';

        // Restrict target language list to 13 OpenAI-supported in openai mode.
        // Qwen LiveTranslate Flash has its own 60-language list (mirrors mobile
        // v0.4.3); Qwen also hides Auto on the source picker because the model
        // rejects "auto" on real mic input.
        this.refreshTargetLangs(mode);
        this.refreshSourceLangs(mode);
    }

    /**
     * Narrow the target-language list to what the engine actually supports.
     *
     * The coerced value is PERSISTED. It used to be written to the <select> only,
     * so switching engines from the toolbar pill — which saves translation_mode
     * and nothing else — left settings.target_language on a language the new
     * engine cannot produce: the UI said Vietnamese while the session was still
     * started with the old code. (The source picker does not need this; qwen's
     * session has a runtime fallback for an unsupported source.)
     */
    refreshTargetLangs(mode) {
        const select = document.getElementById('select-target-lang');
        if (!select) return;
        const OPENAI_LANGS = [
            ['en','English'], ['es','Spanish'], ['pt','Portuguese'], ['fr','French'],
            ['de','German'], ['it','Italian'], ['ru','Russian'], ['hi','Hindi'],
            ['id','Indonesian'], ['vi','Vietnamese'], ['ja','Japanese'],
            ['ko','Korean'], ['zh','Chinese'],
        ];
        const current = select.value;
        if (mode === 'openai') {
            if (!this.fullTargetLangHTML) this.fullTargetLangHTML = select.innerHTML;
            select.innerHTML = OPENAI_LANGS
                .map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
            select.value = OPENAI_LANGS.some(([c]) => c === current) ? current : 'vi';
            this._persistTargetLang(select.value);
        } else if (mode === 'qwen') {
            if (!this.fullTargetLangHTML) this.fullTargetLangHTML = select.innerHTML;
            const langs = QWEN_LANGS;
            select.innerHTML = langs
                .map((l) => `<option value="${l.code}">${l.name}</option>`).join('');
            select.value = langs.some((l) => l.code === current) ? current : 'vi';
            this._persistTargetLang(select.value);
        } else if (this.fullTargetLangHTML) {
            select.innerHTML = this.fullTargetLangHTML;
            select.value = current || 'vi';
        }
    }

    /** Only writes when the value actually moved, so reopening Settings with a
     *  supported language is not a settings mutation. */
    _persistTargetLang(code) {
        if (settingsManager.get().target_language === code) return;
        settingsManager.save({ target_language: code });
    }

    refreshSourceLangs(mode) {
        const select = document.getElementById('select-source-lang');
        if (!select) return;
        const current = select.value;
        if (mode === 'qwen') {
            if (!this.fullSourceLangHTML) this.fullSourceLangHTML = select.innerHTML;
            const langs = QWEN_LANGS;
            // No "Auto" — Live Flash stalls after one segment on real mic when
            // source isn't explicit (verified iPhone v0.4.2, 2026-05-25).
            select.innerHTML = langs
                .map((l) => `<option value="${l.code}">${l.name}</option>`).join('');
            const validCurrent = langs.some((l) => l.code === current) && current !== 'auto';
            select.value = validCurrent ? current : 'en';
        } else if (this.fullSourceLangHTML) {
            select.innerHTML = this.fullSourceLangHTML;
            select.value = current || 'auto';
        }
    }
}
