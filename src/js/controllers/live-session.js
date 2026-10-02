/**
 * The live translate session: start / pause / stop, audio source, status.
 * Engine-specific work is delegated to the per-engine session objects.
 */
import { settingsManager } from '../settings.js';
import { sessionStore } from '../session-store.js';
import { elevenLabsTTS } from '../elevenlabs-tts.js';
import { edgeTTSRust } from '../edge-tts.js';
import { audioPlayer } from '../audio-player.js';
import { showToast } from '../util/toast.js';
import { setLiveBadge, startAutoHideWatch, stopAutoHideWatch } from '../ui-shell.js';
import { SonioxSession } from '../engines/soniox-session.js';
import { OpenAiSession } from '../engines/openai-session.js';
import { QwenSession } from '../engines/qwen-session.js';
import { LocalSession } from '../engines/local-session.js';

const { invoke } = window.__TAURI__.core;

export class LiveSessionController {
    constructor(app) {
        this.app = app;
        this.engines = {
            soniox: new SonioxSession(app),
            openai: new OpenAiSession(app),
            qwen: new QwenSession(app),
            local: new LocalSession(app),
        };
    }

    /** Engine for the active translation mode; Soniox is the default. */
    get engine() {
        return this.engines[this.app.translationMode] || this.engines.soniox;
    }

    bindEvents() {
        // Start/Stop button
        document.getElementById('btn-start').addEventListener('click', async () => {
            if (this.app.isStarting) return; // Prevent re-entry
            try {
                if (!this.app.isRunning) {
                    // Pressing Start in the Live tab means a live session, even if
                    // the previous one was a meeting.
                    this.app.sessionKind = 'live';
                    this.app.transcribeOnly = false;
                    sessionStore.kind = 'live';
                }
                if (this.app.isRunning) {
                    await this.stopSession();
                } else {
                    this.app.isStarting = true;
                    await this.start();
                }
            } catch (err) {
                console.error('[App] Start/Stop error:', err);
                showToast(`Error: ${err}`, 'error');
                this.app.isRunning = false;
                this.updateStartButton();
                this.updateStatus('error');
                this.app.transcriptUI.clear();
                this.app.transcriptUI.showPlaceholder();
            } finally {
                this.app.isStarting = false;
            }
        });

        // Pause button — stop capture + persist, but keep the same session file.
        // Only reachable while running (disabled otherwise); next Start appends a
        // new chunk to the same file rather than starting a fresh one.
        document.getElementById('btn-pause')?.addEventListener('click', async () => {
            if (this.app.isStarting || !this.app.isRunning) return;
            try {
                await this.pause();
            } catch (err) {
                console.error('[App] Pause error:', err);
                showToast(`Error: ${err}`, 'error');
            }
        });

        // Source buttons
        // Audio source dropdown (⌘1/2/3 still switch via setSource)
        document.getElementById('select-audio-source')?.addEventListener('change', (e) => {
            this.setSource(e.target.value);
        });

        // Clear button — clears display only (auto-save happens on stop)
        document.getElementById('btn-clear').addEventListener('click', async () => {
            this.app.transcriptUI.clear();
            this.app.transcriptUI.showPlaceholder();
            this.app.recordingStartTime = null;
        });

        // Copy transcript button
        document.getElementById('btn-copy').addEventListener('click', async () => {
            const text = this.app.transcriptUI.getPlainText();
            if (text) {
                await navigator.clipboard.writeText(text);
                showToast('Copied to clipboard', 'success');
            } else {
                showToast('Nothing to copy', 'info');
            }
        });

        // Open saved transcripts folder (kept for Finder access)
        document.getElementById('btn-open-transcripts').addEventListener('click', async () => {
            try {
                await invoke('open_transcript_dir');
            } catch (err) {
                showToast('Failed to open folder: ' + err, 'error');
            }
        });
    }

    setSource(source) {
        const wasRunning = this.app.isRunning;
        const labels = { system: 'System Audio', microphone: 'Microphone', both: 'System + Mic' };
        const label = labels[source] || source;
        // Persist so subsequent settings notifications don't reset us back.
        settingsManager.save({ audio_source: source });

        if (wasRunning) {
            // Restarting can fail (a provider refusing the new connection, say).
            // Without this the rejection was unhandled and the app was left
            // claiming to run: isRunning stayed true, the button still read
            // "Stop" and the status row never reached `error`. Mirrors the
            // Start button's own handler, including the re-entry guard — ⌘1/2/3
            // reach this same path.
            if (this.app.isStarting) return;
            this.app.isStarting = true;
            this.pause()
                .then(async () => {
                    this.app.currentSource = source;
                    this.updateSourceButtons();
                    showToast(`Switched to ${label}`, 'success');
                    await this.start();
                })
                .catch((err) => {
                    console.error('[Live] Source switch failed:', err);
                    showToast(`Error: ${err}`, 'error');
                    this.app.isRunning = false;
                    this.updateStartButton();
                    this.updateStatus('error');
                })
                .finally(() => { this.app.isStarting = false; });
        } else {
            this.app.currentSource = source;
            this.updateSourceButtons();
            showToast(`Source: ${label}`, 'success');
        }
    }

    updateSourceButtons() {
        const sel = document.getElementById('select-audio-source');
        if (sel) sel.value = this.app.currentSource;
    }

    async start() {
        const settings = settingsManager.get();
        this.app.translationMode = settings.translation_mode || 'soniox';
        console.log('[App] start() called, translation_mode:', this.app.translationMode, 'settings:', JSON.stringify(settings));

        // Local MLX needs macOS Apple Silicon — block here (option is selectable
        // but can't actually run on other platforms) instead of crashing.
        if (this.app.translationMode === 'local' && !this.app.platform.isAppleSilicon) {
            showToast('Local MLX runs only on macOS with Apple Silicon. Pick another engine in Settings.', 'error');
            this.app.showView('settings');
            return;
        }

        // Check Soniox API key only for cloud mode
        if (this.app.translationMode === 'soniox' && !settings.soniox_api_key) {
            showToast('Soniox API key is required. Add it in Settings.', 'error');
            this.app.showView('settings');
            return;
        }

        // Check OpenAI API key for openai mode
        if (this.app.translationMode === 'openai' && !settings.openai_api_key) {
            showToast('OpenAI API key is required. Add it in Settings.', 'error');
            this.app.showView('settings');
            return;
        }

        // Check Qwen API key for qwen mode
        if (this.app.translationMode === 'qwen' && !settings.qwen_api_key) {
            showToast('Qwen (DashScope) API key is required. Add it in Settings.', 'error');
            this.app.showView('settings');
            return;
        }

        // Check ElevenLabs key only if TTS is enabled AND provider is elevenlabs
        if (this.app.tts.enabled && settings.tts_provider === 'elevenlabs' && !settings.elevenlabs_api_key) {
            showToast('TTS is ON but ElevenLabs API key is missing. Add it in Settings or disable TTS.', 'error');
            this.app.showView('settings');
            return;
        }

        this.app.isRunning = true;
        this.updateStartButton();
        this.app.engineUi.hidePicker();
        this.app.engineUi.setPillLocked(true);
        if (!this.app.recordingStartTime) this.app.recordingStartTime = Date.now();

        // Record session metadata for auto-save
        if (!this.app.sessionStartTime) {
            this.app.sessionStartTime = new Date();
            const translationType = settings.translation_type || 'one_way';
            this.app.sessionMode = translationType;
            if (translationType === 'two_way') {
                this.app.sessionSourceLang = settings.language_a || 'ja';
                this.app.sessionTargetLang = settings.language_b || 'vi';
            } else {
                this.app.sessionSourceLang = settings.source_language || 'auto';
                this.app.sessionTargetLang = settings.target_language || 'vi';
            }
        }

        // Begin a session chunk — every Start/Stop cycle becomes one chunk in
        // the persistent SessionStore. Engine/lang may have changed since
        // last chunk, so pass them in.
        sessionStore.kind = this.app.sessionKind || 'live';
        sessionStore.beginChunk({
            engine: this.app.translationMode,
            sourceLang: this.app.sessionSourceLang,
            targetLang: this.app.sessionTargetLang,
        });

        // Clear transcript only if nothing is showing
        if (!this.app.transcriptUI.hasContent()) {
            this.app.transcriptUI.showListening();
        } else {
            this.app.transcriptUI.clearProvisional();
        }

        // Hand off to the engine selected for this mode.
        await this.engine.start(settings);

        // Start TTS if enabled — skipped in realtime modes (built-in audio)
        if (this.app.tts.enabled && this.app.translationMode !== 'openai' && this.app.translationMode !== 'qwen') {
            const tts = this.app.tts.active();
            this.app.tts.configure(tts, settings);
            tts.connect();
            audioPlayer.resume();
        }
    }

    // Pause: stop capture and persist the current chunk, but keep the session
    // file open. The next Start appends a new chunk to the same file. Finalizing
    // into a new file is stopSession()'s job.
    async pause() {
        this.app.isRunning = false;
        this.updateStartButton();
        this.app.engineUi.setPillLocked(false);

        // Stop audio capture
        try {
            await invoke('stop_capture');
        } catch (err) {
            console.error('Failed to stop audio capture:', err);
        }

        await this.engine.stop();

        // Keep transcript visible — don't clear
        this.app.transcriptUI.clearProvisional();

        // Stop TTS
        elevenLabsTTS.disconnect();
        edgeTTSRust.disconnect();

        audioPlayer.stop();

        // Drain any leftover Soniox originals that didn't get paired
        if (this.engines.soniox.originalQueue) this.engines.soniox.originalQueue.length = 0;

        // Close the chunk and persist the whole session (md + json sidecar).
        // Transcript stays on screen — clearSession is no longer called here
        // so user can review & continue in next chunk.
        sessionStore.endChunk();
        const result = await sessionStore.persist();
        if (result === 'saved') {
            const n = sessionStore.totalSegmentCount();
            showToast(`Saved ${n} segment${n === 1 ? '' : 's'}`, 'success');
        } else if (result === 'failed') {
            showToast('Save failed — session kept in memory', 'error');
        }
    }

    // Stop: pause (if running), finalize the current session file, then start a
    // fresh session so the next Start writes a new file pair. Keeps the
    // transcript on screen. Never wipes in-memory data on a failed save.
    async stopSession() {
        if (this.app.isRunning) await this.pause();

        if (sessionStore.isEmpty()) {
            showToast('Nothing to save', 'success');
        } else {
            const result = await sessionStore.endSession();
            if (result === 'failed') {
                // Keep the in-memory session intact so the user can retry Stop.
                showToast('Save failed — session kept in memory', 'error');
                return;
            }
            showToast('Session saved — next start creates a new one', 'success');
        }

        // Reset session identity: fresh ID + current settings so the next Start
        // writes a new file. Resetting sessionStartTime forces start() to
        // re-stamp the metadata block with the current language pair.
        this.app.sessionStartTime = null;
        this.app.sessionKind = 'live';
        const settings = settingsManager.get();
        sessionStore.init({
            engine: settings.translation_mode || 'soniox',
            sourceLang: settings.source_language || 'auto',
            targetLang: settings.target_language || 'vi',
        });
    }

    updateStartButton() {
        const btn = document.getElementById('btn-start');
        const iconPlay = document.getElementById('icon-play');
        const iconStop = document.getElementById('icon-stop');

        btn.classList.toggle('recording', this.app.isRunning);
        iconPlay.style.display = this.app.isRunning ? 'none' : 'block';
        iconStop.style.display = this.app.isRunning ? 'block' : 'none';
        const label = document.getElementById('btn-start-label');
        if (label) label.textContent = this.app.isRunning ? 'Stop' : 'Start';

        // Pause is only actionable while running. (Don't also gate on isStarting:
        // start() calls this while isStarting is still true, and the click handler
        // already guards the starting window.)
        const btnPause = document.getElementById('btn-pause');
        if (btnPause) btnPause.disabled = !this.app.isRunning;
    }

    updateStatus(status) {
        const dot = document.getElementById('status-indicator');
        const text = document.getElementById('status-text');

        dot.className = 'status-dot';

        switch (status) {
            case 'connecting':
                dot.classList.add('connecting');
                text.textContent = 'Connecting...';
                break;
            case 'connected':
                dot.classList.add('connected');
                text.textContent = 'Listening';
                break;
            case 'disconnected':
                dot.classList.add('disconnected');
                text.textContent = 'Ready';
                break;
            case 'error':
                dot.classList.add('error');
                text.textContent = 'Error';
                break;
        }
        // Live tab shows a red badge while a session runs so the user sees
        // recording state even from the Read / Library activities.
        setLiveBadge(this.app.isRunning, this.app.sessionKind);
        this.app.meeting?.updateButtons();
        // Auto-hide chrome only while translating (idle 3s → hide, hover/keys → show)
        if (this.app.isRunning) startAutoHideWatch();
        else stopAutoHideWatch();
    }
}
