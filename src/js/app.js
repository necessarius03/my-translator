/**
 * App — root controller.
 *
 * Owns cross-cutting session state and wires the feature controllers
 * together. Each controller holds a back-reference as `this.app`, so any
 * controller can reach another through the root.
 */

import { settingsManager } from './settings.js';
import { TranscriptUI } from './ui.js';
import { audioPlayer } from './audio-player.js';
import { sessionStore } from './session-store.js';
import { initWindowModes, getActivity } from './ui-shell.js';
import { detectPlatform } from './util/platform.js';
import { bindKeyboardShortcuts } from './controllers/keyboard.js';
import { WindowChromeController } from './controllers/window-chrome.js';
import { TtsController } from './controllers/tts.js';
import { MicrosoftVoicePicker } from './controllers/microsoft-voices.js';
import { LocalVoiceManager } from './controllers/local-voices.js';
import { EngineUiController } from './controllers/engine-ui.js';
import { SettingsFormController } from './controllers/settings-form.js';
import { ReadModeController } from './controllers/read-mode.js';
import { SessionLibraryController } from './controllers/session-library.js';
import { UpdateController } from './controllers/update.js';
import { LiveSessionController } from './controllers/live-session.js';
import { SubtitleController } from './controllers/subtitle.js';
import { MeetingController } from './controllers/meeting-session.js';
import { sleep } from './util/format.js';

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

class App {
    constructor() {
        this.isRunning = false;
        this.isStarting = false; // Guard against re-entry
        this.currentSource = 'system'; // 'system' | 'microphone' | 'both'
        this.translationMode = 'soniox'; // 'soniox' | 'local' | 'openai' | 'qwen'
        this.transcriptUI = null;
        this.appWindow = getCurrentWindow();
        this.recordingStartTime = null;
        this.sessionStartTime = null;  // Session start timestamp (new Date())
        this.sessionSourceLang = 'auto';
        this.sessionTargetLang = 'vi';
        this.sessionMode = 'one_way';
        this.sessionKind = 'live';   // 'live' | 'meeting' — set when a session starts
        this.transcribeOnly = false; // meeting mode with live translation switched off
        this.closing = false;    // Guard so the exit flush runs exactly once
        this.platform = { os: 'macos', isAppleSilicon: false };
    }

    async init() {
        await settingsManager.load();

        this.transcriptUI = new TranscriptUI(document.getElementById('transcript-content'));

        // One session file lives across many Start/Pause cycles; it autosaves
        // while recording and finalizes on Stop or app close.
        const initSettings = settingsManager.get();
        sessionStore.init({
            engine: initSettings.translation_mode || 'soniox',
            sourceLang: initSettings.source_language || 'auto',
            targetLang: initSettings.target_language || 'vi',
        });

        // Platform gate for Local MLX — must run before any controller reads it.
        this.platform = await detectPlatform();

        // Controllers are all constructed first so cross-references resolve
        // regardless of binding order below.
        this.chrome = new WindowChromeController(this);
        this.tts = new TtsController(this);
        this.msVoices = new MicrosoftVoicePicker();
        this.localVoices = new LocalVoiceManager();
        this.engineUi = new EngineUiController(this);
        this.settingsForm = new SettingsFormController(this);
        this.read = new ReadModeController(this);
        this.library = new SessionLibraryController(this);
        this.update = new UpdateController(this);
        this.live = new LiveSessionController(this);
        this.subtitle = new SubtitleController(this);
        this.meeting = new MeetingController(this);

        this.applySettings(settingsManager.get());

        this.bindEvents();
        this.chrome.bindEvents();
        this.live.bindEvents();
        this.library.bindEvents();
        this.settingsForm.bindEvents();
        this.engineUi.bindEvents();
        this.tts.bindEvents();
        this.subtitle.bindEvents();
        this.meeting.bindEvents();

        // Flush the session on every close route (window x, Cmd+Q, Dock quit).
        await this.bindCloseHooks();
        bindKeyboardShortcuts(this);

        settingsManager.onChange((settings) => this.applySettings(settings));

        audioPlayer.init();

        // Activity shell owns panel visibility; side effects land here.
        this.chrome.initShell();
        document.addEventListener('activity-changed', (e) => this.onActivityChanged(e.detail));
        this.read.bindEvents();

        this.tts.initProviders();

        // Window modes: overlay <-> expanded, restores last mode + sizes
        initWindowModes(this.appWindow);

        this.update.bindAboutTab();
        this.update.checkOnStartup();

        // Reopen the subtitle overlay if the user left it on last session.
        this.subtitle.restoreOnStartup();

        this.engineUi.maybeShowPicker();

        console.log('🌐 My Translator initialized');
    }

    bindEvents() {
        // Settings button
        document.getElementById('btn-settings').addEventListener('click', () => {
            this.showView('settings');
        });

        // Back from settings
        document.getElementById('btn-back').addEventListener('click', () => {
            this.showView('overlay');
        });

        // Manual drag for settings view
        // data-tauri-drag-region doesn't work well when parent contains buttons
        // Using Tauri's recommended appWindow.startDragging() approach instead
        document.getElementById('settings-view')?.addEventListener('mousedown', (e) => {
            const interactive = e.target.closest('button, input, select, label, a, textarea, .settings-section, .settings-actions');
            if (!interactive && e.buttons === 1) {
                e.preventDefault();
                this.appWindow.startDragging();
            }
        });
    }

    /** Side effects when the activity switcher changes space. Panel visibility
     *  itself is owned by ui-shell; this handles pause/drain/render concerns. */
    onActivityChanged({ activity, previous }) {
        if (previous === 'read' && activity !== 'read') this.read.exit();
        if (previous === 'meeting' && activity !== 'meeting') this.meeting.exit();
        if (activity === 'read') this.read.enter();
        if (activity === 'meeting') this.meeting.enter();
        if (activity === 'library') this.library.show();
    }

    showView(view) {
        document.getElementById('overlay-view').classList.toggle('active', view === 'overlay');
        document.getElementById('settings-view').classList.toggle('active', view === 'settings');

        if (view === 'settings') {
            this.settingsForm.populate();
            this.settingsForm.showScreen('settings-home'); // wizard always opens at home
        }
        // Returning to the overlay while in Read mode: a voice/provider may have
        // changed in Settings — refresh both the capability hint AND the voice
        // quick-pick (else it keeps the old provider's options + settings key).
        if (view === 'overlay' && getActivity() === 'read') {
            this.read.populateQuickPick();
            this.read.showCapabilityHint();
        }
    }

    applySettings(settings) {
        // Update overlay opacity
        const overlayView = document.getElementById('overlay-view');
        overlayView.style.opacity = settings.overlay_opacity || 1.0;

        // Live status row: language pair display
        const langEl = document.getElementById('live-lang');
        if (langEl) {
            langEl.textContent = `${settings.source_language || 'auto'} → ${settings.target_language || 'vi'}`;
        }

        // Note: saving settings turns TTS narration off (see end of this method), so the
        // active provider is re-configured on the next TTS toggle — no mid-session re-sync
        // needed here. Disconnect any non-active provider to drop stale queued audio.
        if (this.tts.all) {
            const active = this.tts.active();
            for (const tts of this.tts.all) {
                if (tts !== active && tts.isConnected) tts.disconnect();
            }
        }

        // Update transcript UI
        if (this.transcriptUI) {
            this.transcriptUI.configure({
                maxLines: settings.max_lines || 5,
                showOriginal: settings.show_original !== false,
                fontSize: settings.font_size || 16,
            });
        }

        // Update current source button states
        this.currentSource = settings.audio_source || 'system';
        this.live.updateSourceButtons();

        // Subtitle overlay reads its look from the same settings; push the
        // change straight through so the user sees it without reopening.
        this.subtitle?.applySettings();

        // Meeting mode's live-translate switch is only offered for engines that
        // can actually honour it, so an engine change in Settings has to
        // re-evaluate it — otherwise the switch keeps promising the old engine's
        // capability.
        this.meeting?.syncEngineRow();

        // TTS is always OFF on app start — user must toggle on each session
        this.tts.enabled = false;
        this.tts.updateButton();
    }

    // Persist the session on the way out. endSession() first (cheap local write
    // that finalizes the file), then best-effort engine teardown via pause().
    // Both are idempotent, so running this more than once is harmless.
    async flushOnExit() {
        try { await sessionStore.endSession(); } catch (e) { console.error('[App] exit flush (endSession) failed:', e); }
        try { await this.live.pause(); } catch (e) { console.error('[App] exit flush (pause) failed:', e); }
    }

    // Two close routes, one flush:
    //  - window x / appWindow.close() -> onCloseRequested (frontend)
    //  - Cmd+Q / Dock quit -> Rust RunEvent::ExitRequested emits 'app-exit-requested'
    // Both flush (raced against a 3s deadline so a hung engine cannot wedge the
    // app) then exit_app, which force-exits the process cleanly in Rust.
    async bindCloseHooks() {
        await this.appWindow.onCloseRequested(async (event) => {
            if (this.closing) return;
            this.closing = true;
            event.preventDefault();
            await Promise.race([this.flushOnExit(), sleep(3000)]);
            try {
                await invoke('exit_app');
            } catch {
                try { await this.appWindow.destroy(); } catch {}
            }
        });

        await this.appWindow.listen('app-exit-requested', async () => {
            if (this.closing) return;
            this.closing = true;
            await Promise.race([this.flushOnExit(), sleep(3000)]);
            try { await invoke('exit_app'); } catch {}
        });
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    // Exposed for the browser-dev UI suite and for poking at state in devtools.
    // Nothing in the app reads it back.
    window.__app = app;
    app.init();
});
