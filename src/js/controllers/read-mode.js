/**
 * Read mode: paste arbitrary text, have the active TTS provider read it aloud.
 * Chunking + playback ordering live in Reader; this owns the panel UI.
 */
import { settingsManager } from '../settings.js';
import { readAudioPlayer } from '../audio-player.js';
import { Reader } from '../reader.js';
import { showToast } from '../util/toast.js';

// Conservative per-provider chunk caps (chars). Local is offline (no endpoint cap);
// cloud providers use safe values; google-free/tiktok stay well under their real caps
// (TikTok's Rust command hard-caps at 280). Raise only after measuring a live call.
const READ_MAX_LEN = { local: 400, edge: 200, microsoft: 200, google: 200, 'google-free': 120, tiktok: 120 };

function setEl(id, display) {
    const el = document.getElementById(id);
    if (el) el.style.display = display;
}

export class ReadModeController {
    constructor(app) {
        this.app = app;
        // 'live' = capture->translate->speak; 'read' = paste text -> read aloud.
        this.mode = 'live';
        // Built lazily on Play.
        this.reader = null;
    }

    bindEvents() {
        // Read quick-pick: save the active provider's voice key + re-check capability
        document.getElementById('read-voice-quick')?.addEventListener('change', (e) => {
            const key = e.target.dataset.key;
            if (!key) return;
            settingsManager.save({ [key]: e.target.value });
            this.showCapabilityHint();
        });
        // "More…" deep-links to Settings → TTS detail
        document.getElementById('btn-read-tts-settings')?.addEventListener('click', () => {
            this.app.showView('settings');
            this.app.settingsForm.showScreen('tab-tts');
        });

        document.getElementById('btn-read-play')?.addEventListener('click', () => {
            // Play doubles as Resume when paused — do NOT rebuild the reader.
            if (this.reader && this.reader.state === 'paused') this.reader.play();
            else this.start();
        });
        document.getElementById('btn-read-pause')?.addEventListener('click', () => {
            this.reader?.pause();
        });
        document.getElementById('btn-read-stop')?.addEventListener('click', () => this.stop());
    }

    async enter() {
        // Stop any running Live session AND drain the shared provider's queue so an in-flight
        // Live synth cannot fire onAudioChunk into the Live context after the switch.
        // Panel visibility is owned by ui-shell; here we only hide the Live-only
        // toolbar controls (shared toolbar until the phase-2 consolidation).
        if (this.app.isRunning) await this.app.live.pause();
        try { this.app.tts.active().disconnect(); } catch { /* provider may be idle */ }

        this.mode = 'read'; // legacy alias for getActivity()==='read' checks
        // Live controls now live inside the Live panel, which ui-shell hides —
        // no per-element toggling needed anymore.
        this.resetUI();
        this.populateQuickPick();
        this.showCapabilityHint();
    }

    /**
     * Voice quick-pick in the Read panel — mirrors the active provider's voice
     * options from its Settings select (DRY: one source of options, two views).
     * Local voices come from the installed catalog instead.
     */
    async populateQuickPick() {
        const sel = document.getElementById('read-voice-quick');
        if (!sel) return;
        const s = settingsManager.get();
        const provider = s.tts_provider || 'edge';
        const map = {
            edge: { src: 'select-edge-voice', key: 'edge_tts_voice' },
            microsoft: { src: 'select-microsoft-voice', key: 'microsoft_v2_voice' },
            'google-free': { src: 'select-google-free-voice', key: 'google_free_voice' },
            tiktok: { src: 'select-tiktok-voice', key: 'tiktok_voice' },
            google: { src: 'select-google-voice', key: 'google_tts_voice' },
            elevenlabs: { src: 'select-tts-voice', key: 'tts_voice_id' },
        };
        sel.innerHTML = '';
        if (provider === 'local') {
            await this.app.localVoices.refresh();
            const installed = (this.app.localVoices.voices || []).filter(v => v.installed);
            installed.forEach(v => sel.add(new Option(v.display, v.id)));
            sel.dataset.key = 'local_tts_voice';
            if (s.local_tts_voice) sel.value = s.local_tts_voice;
            sel.disabled = installed.length === 0;
        } else {
            const m = map[provider] || map.edge; // legacy/unknown provider → safe fallback
            const src = document.getElementById(m.src);
            if (src) [...src.options].forEach(o => sel.add(new Option(o.textContent, o.value)));
            sel.dataset.key = m.key;
            const cur = s[m.key];
            if (cur) sel.value = cur;
            sel.disabled = sel.options.length === 0;
        }
    }

    exit() {
        this.stop();
        this.mode = 'live';
    }

    /** Capability = usability, not method existence. Returns {ok, reason, provider}. */
    async capability() {
        const settings = settingsManager.get();
        const provider = settings.tts_provider || 'edge';
        const tts = this.app.tts.active();
        if (typeof tts.synthesize !== 'function') {
            return { ok: false, reason: 'This TTS provider does not support Read mode. Pick Edge, Local, Microsoft, Google or TikTok.' };
        }
        if (provider === 'google' && !settings.google_tts_api_key) {
            return { ok: false, reason: 'Missing Google Cloud API key (Settings → TTS → Google).' };
        }
        if (provider === 'tiktok' && !settings.tiktok_session_id) {
            return { ok: false, reason: 'Missing TikTok sessionid (Settings → TTS → TikTok).' };
        }
        if (provider === 'local') {
            const installed = await this.app.localVoices.isInstalled(settings.local_tts_voice);
            if (!installed) return { ok: false, reason: 'No local voice model downloaded yet (Settings → TTS → Local).' };
        }
        return { ok: true, provider };
    }

    async showCapabilityHint() {
        const hintEl = document.getElementById('read-hint');
        const cap = await this.capability();
        const playBtn = document.getElementById('btn-read-play');
        if (this.mode !== 'read') return;
        if (hintEl) hintEl.textContent = cap.ok ? '' : cap.reason;
        if (playBtn) playBtn.disabled = !cap.ok;
    }

    async start() {
        const cap = await this.capability();
        if (!cap.ok) { this.showCapabilityHint(); return; }

        const text = (document.getElementById('read-input')?.value || '').trim();
        if (!text) { showToast('Enter some text to read', 'error'); return; }

        const settings = settingsManager.get();
        const provider = cap.provider;
        const tts = this.app.tts.active();
        this.app.tts.configure(tts, settings); // set voice/key/session + client rate

        // Client-side rate: only providers without a server rate param.
        const clientRate = provider === 'google-free' ? (settings.google_free_speed || 1.0)
            : provider === 'tiktok' ? (settings.tiktok_speed || 1.0) : 1.0;
        readAudioPlayer.setReadRate(clientRate);

        const lookahead = provider === 'local' ? 2 : 1;
        const interChunkDelayMs = (provider === 'google-free' || provider === 'tiktok') ? 250 : 0;
        const maxLen = READ_MAX_LEN[provider] || 120;

        this.reader?.stop(); // never leak a previous (e.g. paused) reader — it could race audio
        readAudioPlayer.stop();
        this.reader = new Reader({
            synthesize: (t) => tts.synthesize(t),
            player: readAudioPlayer,
            lookahead,
            interChunkDelayMs,
        });
        this.reader.onProgress = (n, total) => this.updateProgress(n, total);
        this.reader.onSentence = (i) => this.highlightChunk(i);
        this.reader.onChunkError = (i) => this.markChunkError(i);
        this.reader.onError = (msg) => showToast(msg, 'error');
        this.reader.onState = (state) => this.onState(state);

        this.reader.load(text, maxLen);
        if (this.reader.total === 0) { showToast('Nothing to read', 'error'); return; }
        this.renderChunks(this.reader.chunks);
        this.reader.play();
    }

    stop() {
        this.reader?.stop();
        this.reader = null;
        this.resetUI();
    }

    onState(state) {
        if (state === 'playing') this.updateControls('playing');
        else if (state === 'paused') this.updateControls('paused');
        else if (state === 'done' || state === 'stopped') {
            this.updateControls('idle');
        }
    }

    updateControls(mode) {
        // mode: 'idle' | 'playing' | 'paused'
        if (mode === 'idle') {
            setEl('btn-read-play', '');
            setEl('btn-read-pause', 'none');
            setEl('btn-read-stop', 'none');
            setEl('read-input', '');
            setEl('read-output', 'none');
        } else if (mode === 'playing') {
            setEl('btn-read-play', 'none');
            setEl('btn-read-pause', '');
            setEl('btn-read-stop', '');
            setEl('read-input', 'none');
            setEl('read-output', '');
        } else if (mode === 'paused') {
            setEl('btn-read-play', ''); // play acts as resume
            setEl('btn-read-pause', 'none');
            setEl('btn-read-stop', '');
        }
    }

    resetUI() {
        this.updateControls('idle');
        const out = document.getElementById('read-output');
        if (out) out.innerHTML = '';
        const prog = document.getElementById('read-progress');
        if (prog) prog.textContent = '';
        const fill = document.getElementById('read-progress-fill');
        if (fill) fill.style.width = '0%';
    }

    /** Build chunk spans with textContent (never innerHTML) — pasted text is untrusted. */
    renderChunks(chunks) {
        const out = document.getElementById('read-output');
        if (!out) return;
        out.innerHTML = '';
        chunks.forEach((c, i) => {
            const span = document.createElement('span');
            span.className = 'read-chunk';
            span.dataset.index = String(i);
            span.textContent = c + ' ';
            out.appendChild(span);
        });
    }

    highlightChunk(index) {
        const out = document.getElementById('read-output');
        if (!out) return;
        out.querySelectorAll('.read-chunk.active').forEach((el) => el.classList.remove('active'));
        const span = out.querySelector(`.read-chunk[data-index="${index}"]`);
        if (span) {
            span.classList.add('active');
            span.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }

    markChunkError(index) {
        const span = document.getElementById('read-output')
            ?.querySelector(`.read-chunk[data-index="${index}"]`);
        if (span) span.classList.add('error');
    }

    updateProgress(n, total) {
        const prog = document.getElementById('read-progress');
        if (prog) prog.textContent = `chunk ${n} of ${total}`;
        const fill = document.getElementById('read-progress-fill');
        if (fill) fill.style.width = total ? `${Math.round((n / total) * 100)}%` : '0%';
    }
}
