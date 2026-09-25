/** Local offline MLX pipeline (Whisper + Qwen) run as a Python sidecar. */
import { sessionStore } from '../session-store.js';
import { showToast } from '../util/toast.js';
import { runMlxSetup } from './mlx-setup.js';

const { invoke } = window.__TAURI__.core;

export class LocalSession {
    constructor(app) {
        this.app = app;
        this.channel = null;
        this.ready = false;
    }

    async start(settings) {
        console.log('[App] Starting Local mode (MLX models)...');
        this.app.transcriptUI.provider = 'soniox';
        this.app.live.updateStatus('connecting');

        // Step 0: Check audio permission FIRST (before loading models)
        try {
            await invoke('start_capture', {
                source: this.app.currentSource,
                channel: new window.__TAURI__.core.Channel(), // dummy channel for permission check
            });
            await invoke('stop_capture');
        } catch (err) {
            console.error('[App] Audio permission check failed:', err);
            showToast(`Audio permission required: ${err}`, 'error');
            this.app.isRunning = false;
            this.app.live.updateStartButton();
            this.app.live.updateStatus('error');
            this.app.transcriptUI.clear();
            this.app.transcriptUI.showPlaceholder();
            return;
        }

        // Step 1: Check if MLX setup is complete
        try {
            const checkResult = await invoke('check_mlx_setup');
            const status = JSON.parse(checkResult);
            if (!status.ready) {
                showToast('Setting up MLX models (one-time, ~5GB)...', 'success');
                this.app.transcriptUI.showStatusMessage('Downloading MLX models (one-time setup)...');
                await runMlxSetup();
            }
        } catch (err) {
            console.warn('[App] MLX check failed (proceeding anyway):', err);
        }

        console.log('[App] MLX check passed, starting pipeline...');

        // Step 1: Start pipeline FIRST (independent of audio)
        try {
            showToast('Starting local pipeline...', 'success');

            this.channel = new window.__TAURI__.core.Channel();
            this.ready = false;

            this.channel.onmessage = (msg) => {
                let data;
                try {
                    data = (typeof msg === 'string') ? JSON.parse(msg) : msg;
                } catch (e) {
                    console.warn('[Local] JSON parse failed:', typeof msg, msg);
                    return;
                }
                try {
                    this.handleResult(data);
                } catch (e) {
                    console.error('[Local] Handler error for type:', data?.type, e);
                }
            };

            const sourceLangMap = {
                'auto': 'auto', 'ja': 'Japanese', 'en': 'English',
                'zh': 'Chinese', 'ko': 'Korean', 'vi': 'Vietnamese',
            };
            const sourceLang = sourceLangMap[settings.source_language] || 'Japanese';

            await invoke('start_local_pipeline', {
                sourceLang: sourceLang,
                targetLang: settings.target_language || 'vi',
                channel: this.channel,
            });
            console.log('[App] Local pipeline spawned');
        } catch (err) {
            console.error('Failed to start pipeline:', err);
            showToast(`Pipeline error: ${err}`, 'error');
            await this.app.live.pause();
            return;
        }

        // Step 2: Start audio capture
        try {
            const audioChannel = new window.__TAURI__.core.Channel();
            let audioChunkCount = 0;

            audioChannel.onmessage = async (pcmData) => {
                audioChunkCount++;
                if (audioChunkCount <= 3 || audioChunkCount % 50 === 0) {
                    console.log(`[Local] Audio batch #${audioChunkCount}, size:`, pcmData?.length || 0);
                }
                try {
                    await invoke('send_audio_to_pipeline', { data: Array.from(new Uint8Array(pcmData)) });
                } catch (e) {
                    // Pipeline may not be ready yet
                }
            };

            await invoke('start_capture', {
                source: this.app.currentSource,
                channel: audioChannel,
            });
            console.log('[App] Audio capture started');
        } catch (err) {
            console.error('Audio capture failed (pipeline still running):', err);
            showToast(`Audio: ${err}. Pipeline still loading...`, 'error');
        }
    }

    handleResult(data) {
        switch (data.type) {
            case 'ready':
                this.ready = true;
                this.app.live.updateStatus('connected');
                this.app.transcriptUI.removeStatusMessage();
                this.app.transcriptUI.showListening();
                showToast('Local models ready!', 'success');
                break;
            case 'result':
                // Chase effect: show original first (gray), then translation (white)
                if (data.original) {
                    this.app.transcriptUI.addOriginal(data.original);
                }
                // Small delay for visual "chase" effect
                setTimeout(() => {
                if (data.translated) {
                    this.app.transcriptUI.addTranslation(data.translated);
                    this.app.tts.speakIfEnabled(data.translated);
                }
                }, 80);
                // Persist atomically — Local pipeline gives both texts in
                // one event so we don't need FIFO pairing.
                sessionStore.addSegment(data.original || '', data.translated || '');
                break;
            case 'status':
                const msg = data.message || 'Loading...';
                // Status bar: show compact message (strip [pipeline] prefix)
                const statusText = document.getElementById('status-text');
                if (statusText) {
                    const compact = msg.replace(/^\[pipeline\]\s*/, '');
                    statusText.textContent = compact;
                }
                // Transcript area: only show loading/starting messages, not debug logs
                if (!msg.startsWith('[pipeline]')) {
                    this.app.transcriptUI.showStatusMessage(msg);
                }
                break;
            case 'done':
                this.app.live.updateStatus('disconnected');
                break;
        }
    }

    async stop() {
        // Stop local pipeline
        try {
            await invoke('stop_local_pipeline');
        } catch (err) {
            console.error('Failed to stop local pipeline:', err);
        }
        this.ready = false;
        this.app.transcriptUI.removeStatusMessage();
        this.app.live.updateStatus('disconnected');
    }
}
