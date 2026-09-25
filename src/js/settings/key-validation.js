/**
 * API key checks for the Settings screen: cheap inline format validation on
 * every keystroke, plus an explicit live ping per provider.
 */

// Inline format check — runs on every keystroke. Cheap, no network.
// Updates: per-field status badge + engine dropdown option enable/disable.
export function refreshKeyStatus() {
    const sonioxKey = document.getElementById('input-api-key')?.value.trim() || '';
    const openaiKey = document.getElementById('input-openai-key')?.value.trim() || '';

    // Soniox keys are opaque hex-like strings, ~32+ chars. Be lenient.
    const sonioxOk = sonioxKey.length >= 20;
    // OpenAI keys start with sk- and are ~50+ chars.
    const openaiOk = /^sk-[A-Za-z0-9_\-]{20,}$/.test(openaiKey);

    const sonioxStatus = document.getElementById('key-status-soniox');
    if (sonioxStatus) {
        sonioxStatus.className = 'key-status ' + (sonioxKey === '' ? '' : sonioxOk ? 'ok' : 'bad');
        sonioxStatus.textContent = sonioxKey === '' ? '' : sonioxOk ? '✓ format ok' : '✗ check format';
    }
    const openaiStatus = document.getElementById('key-status-openai');
    if (openaiStatus) {
        openaiStatus.className = 'key-status ' + (openaiKey === '' ? '' : openaiOk ? 'ok' : 'bad');
        openaiStatus.textContent = openaiKey === '' ? '' : openaiOk ? '✓ format ok' : '✗ should start with sk-';
    }

    // Engines that need a key stay SELECTABLE even when it's missing —
    // otherwise the user can't pick the engine to add its key (catch-22).
    // The label hints "add key first", and start() blocks launch until the
    // key is present. (Same not-hard-disabled principle as Local MLX.)
    const select = document.getElementById('select-translation-mode');
    if (select) {
        const sonioxOpt = select.querySelector('option[value="soniox"]');
        const openaiOpt = select.querySelector('option[value="openai"]');
        if (sonioxOpt) {
            sonioxOpt.disabled = false;
            sonioxOpt.textContent = sonioxOk ? '☁️ Soniox' : '☁️ Soniox — key required';
        }
        if (openaiOpt) {
            openaiOpt.disabled = false;
            openaiOpt.textContent = openaiOk ? '⚡ OpenAI Realtime' : '⚡ OpenAI Realtime — key required';
        }
    }
}

// Live ping the provider to verify key actually works.
export async function testConnection(provider) {
    const statusEl = document.getElementById(`key-status-${provider}`);
    const btn = document.getElementById(`btn-test-${provider}`);
    if (!statusEl || !btn) return;

    const inputId = provider === 'soniox' ? 'input-api-key' : 'input-openai-key';
    const key = document.getElementById(inputId)?.value.trim() || '';
    if (!key) {
        statusEl.className = 'key-status bad';
        statusEl.textContent = '✗ empty';
        return;
    }

    btn.disabled = true;
    statusEl.className = 'key-status checking';
    statusEl.textContent = '… testing';

    try {
        const ok = provider === 'soniox'
            ? await pingSoniox(key)
            : await pingOpenAi(key);
        statusEl.className = 'key-status ' + (ok ? 'ok' : 'bad');
        statusEl.textContent = ok ? '✓ connected' : '✗ rejected';
    } catch (e) {
        statusEl.className = 'key-status bad';
        statusEl.textContent = '✗ ' + (e?.message || 'failed');
    } finally {
        btn.disabled = false;
    }
}

// Soniox: open WS, send config, wait for first response, close.
function pingSoniox(apiKey) {
    return new Promise((resolve) => {
        const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket');
        const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 5000);
        ws.onopen = () => {
            ws.send(JSON.stringify({ api_key: apiKey, model: 'stt-rt-v5', audio_format: 'pcm_s16le', sample_rate: 16000, num_channels: 1 }));
        };
        ws.onmessage = (e) => {
            clearTimeout(timer);
            try {
                const v = JSON.parse(e.data);
                resolve(!v.error_code);
            } catch { resolve(true); }
            try { ws.close(); } catch {}
        };
        ws.onerror = () => { clearTimeout(timer); resolve(false); };
    });
}

// OpenAI: cheap HTTP GET /v1/models with the key.
async function pingOpenAi(apiKey) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
        const r = await fetch('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: ctrl.signal,
        });
        return r.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}
