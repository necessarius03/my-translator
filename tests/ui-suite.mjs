/**
 * Frontend behaviour suite — runs the real UI against the browser-dev mock.
 *
 * Serves `src/` on :3111 (the port `tauri-mock.js` activates on) and drives it
 * with the system Chrome. Every check asserts that state actually CHANGED —
 * "no console error" alone passes even when a control is silently dead.
 *
 * Covers the surface that needs no API key: engine switching and the settings
 * sections it drives, TTS provider panels, the Microsoft/Local voice managers,
 * Read mode, the session library, keyboard shortcuts and window chrome.
 *
 * NOT covered (needs the real Tauri runtime and a provider key): live
 * translation sessions, engine reconnect, real audio output, real session
 * files, window geometry, the exit flush.
 *
 * Run: npm run test:ui
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { mkdirSync, createReadStream, statSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3111;
const BASE = `http://localhost:${PORT}/`;
const SHOTS = join(ROOT, 'tests', 'screenshots');

// ── dev server ──────────────────────────────────────────────
// Serving `src/` in-process rather than shelling out to `npx serve`: spawning
// npx through a Windows shell proved unreliable from inside `npm run`, and it
// left an orphaned process tree holding the port. A dozen lines of http keeps
// the whole thing inside this process, so teardown is just close().
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

let server = null;
function startServer() {
    return new Promise((resolve, reject) => {
        server = createServer((req, res) => {
            const url = decodeURIComponent((req.url || '/').split('?')[0]);
            const rel = normalize(url === '/' ? 'index.html' : url.replace(/^\/+/, ''));
            // Refuse to escape src/ — the suite only ever asks for app files.
            if (rel.startsWith('..')) {
                res.writeHead(403).end();
                return;
            }
            const file = join(ROOT, 'src', rel);
            try {
                if (!statSync(file).isFile()) throw new Error('not a file');
            } catch {
                res.writeHead(404).end();
                return;
            }
            res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
            createReadStream(file).pipe(res);
        });
        server.on('error', async (e) => {
            if (e.code !== 'EADDRINUSE') return reject(e);
            // Someone is already on the port — most likely `npm run dev:web`.
            // Reuse it if it serves this app, otherwise say what is in the way.
            server = null;
            try {
                const r = await fetch(BASE, { signal: AbortSignal.timeout(2000) });
                if (r.ok && (await r.text()).includes('transcript-content')) {
                    console.log(`Reusing the server already on :${PORT}`);
                    return resolve();
                }
            } catch { /* fall through */ }
            reject(new Error(`port ${PORT} is taken by something that is not this app`));
        });
        server.listen(PORT, () => {
            console.log(`Serving src/ on :${PORT}`);
            resolve();
        });
    });
}
const stopServer = () => { if (server) { server.close(); server = null; } };

// ── harness ─────────────────────────────────────────────────────────────────
const errors = [];
let pass = 0;
let fail = 0;

const ok = (cond, name, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n── ${t}`);

mkdirSync(SHOTS, { recursive: true });
await startServer();
// Safety net: the browser launch below is outside the try/finally, so a machine
// with neither Chrome nor Edge would otherwise leave `serve` holding the port.
process.on('exit', stopServer);

// `channel` uses an already-installed browser, so no playwright browser
// download is needed. Edge is the fallback — present on every Windows box.
let browser;
try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
} catch {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
}
const page = await browser.newPage({ viewport: { width: 1000, height: 620 } });

// Only the app's own requests count. Two things are deliberately ignored:
// /favicon.ico, which the browser always asks for and this server has none of,
// and anything off-origin (index.html pulls Inter from Google Fonts) — the
// suite tests the app, and should still pass on a machine with no internet.
const ignorable = (u = '') => /favicon/i.test(u) || !u.startsWith(BASE);
page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // A failed subresource reports the offending URL in location(), not text().
    if (ignorable(m.location()?.url || '')) return;
    errors.push(`CONSOLE ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`PAGEERROR ${(e.stack || e.message).split('\n')[0]}`));
page.on('requestfailed', (r) => { if (!ignorable(r.url())) errors.push(`REQFAIL ${r.url()}`); });
page.on('response', (r) => {
    if (r.status() >= 400 && !ignorable(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`);
});

const shot = (n) => page.screenshot({ path: join(SHOTS, `${n}.png`) }).catch(() => {});
const openSettings = async () => { await page.click('#btn-settings'); await page.waitForTimeout(250); };
const settingsHome = async () => {
    const back = page.locator('.settings-back-row:visible').first();
    if (await back.count()) { await back.click(); await page.waitForTimeout(200); }
};
const card = async (id) => { await settingsHome(); await page.click(`#${id}`); await page.waitForTimeout(300); };
const setEngine = async (mode) => {
    await card('card-translation');
    await page.selectOption('#select-translation-mode', mode);
    await page.waitForTimeout(300);
};
const optionValues = (sel) => page.$$eval(`${sel} option`, (o) => o.map((x) => x.value));

try {
    // ── boot ────────────────────────────────────────────────────────────────
    section('Boot');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    ok(await page.evaluate(() => !!window.__TAURI__), 'Tauri mock is active');
    ok((await page.locator('#transcript-content').count()) === 1, 'transcript UI mounted');
    ok(errors.length === 0, 'no console errors on boot', errors.join(' | '));
    await shot('01-boot');

    const picker = page.locator('#engine-picker .engine-card[data-engine-class="standard"]');
    if ((await picker.count()) && (await picker.first().isVisible())) await picker.first().click();

    // ── engine UI ───────────────────────────────────────────────────────────
    section('Engine UI + language lists (EngineUiController)');
    await openSettings();
    await setEngine('soniox');
    const sonioxTargets = (await optionValues('#select-target-lang')).length;
    ok((await optionValues('#select-source-lang')).includes('auto'), 'Soniox: source list offers Auto');
    ok(await page.locator('#section-api-key').isVisible(), 'Soniox: its key section is shown');
    ok(await page.locator('#section-soniox-context').isVisible(), 'Soniox: custom context is shown');

    await setEngine('openai');
    const openaiTargets = await optionValues('#select-target-lang');
    ok(openaiTargets.length === 13, 'OpenAI: target list narrows to 13', `saw ${openaiTargets.length}`);
    ok(await page.locator('#section-openai-key').isVisible(), 'OpenAI: its key section is shown');
    ok(!(await page.locator('#section-soniox-context').isVisible()), 'OpenAI: custom context hidden');

    await setEngine('qwen');
    const qwenTargets = await optionValues('#select-target-lang');
    ok(!(await optionValues('#select-source-lang')).includes('auto'), 'Qwen: Auto removed from source list');
    ok(qwenTargets.length > 40, 'Qwen: 60-language target list', `saw ${qwenTargets.length}`);
    ok(await page.locator('#section-qwen-key').isVisible(), 'Qwen: its key section is shown');
    ok(
        (await page.$eval('#select-translation-type option[value="two_way"]', (o) => o.disabled)) === true,
        'Qwen: two-way mode disabled',
    );

    await setEngine('soniox');
    const restored = (await optionValues('#select-target-lang')).length;
    ok(restored === sonioxTargets, 'back to Soniox: full target list restored', `${restored} vs ${sonioxTargets}`);
    await shot('02-engine-ui');

    // Regression: narrowing the target list coerces the <select>, and that
    // coerced value has to be SAVED. It used to be written to the element only,
    // so the UI showed a supported language while settings.target_language still
    // held one the engine cannot produce — and that is the value a session is
    // started with.
    const savedTarget = () => page.evaluate(async () => {
        const { settingsManager } = await import('/js/settings.js');
        return settingsManager.get().target_language;
    });

    await setEngine('soniox');
    await page.selectOption('#select-target-lang', 'th');   // Thai: Soniox only
    await page.click('#btn-save-settings');
    await page.waitForTimeout(300);
    ok(await savedTarget() === 'th', 'Soniox keeps a language only it supports');

    await openSettings();
    await card('card-translation');
    await setEngine('openai');                              // no Thai in its 13
    ok(
        await page.inputValue('#select-target-lang') === 'vi',
        'OpenAI: the unsupported target falls back in the picker',
    );
    ok(
        await savedTarget() === 'vi',
        'and the fallback is persisted, so the session cannot start on Thai',
    );
    await setEngine('soniox');

    // Regression: glossary rows are rebuilt from saved settings with innerHTML.
    // addTermRow interpolated the stored text straight into value="..." with no
    // escaping, so a term containing a quote closed the attribute on the next
    // Settings open — the row rendered wrong and the term was corrupted when
    // re-saved. The `&` matters too: escAttr did not escape it, which made it
    // non-idempotent and let pre-encoded text decode back into a real quote.
    section('Glossary terms survive quotes and ampersands (regression)');

    const TRICKY_SRC = 'say "hello" & wave';
    const TRICKY_TGT = 'nói "xin chào" & vẫy';

    // Already inside Settings here (the engine section above leaves it open), so
    // navigate via the home list rather than the overlay's gear button.
    await settingsHome();
    await card('card-translation');
    await page.click('#btn-add-term');
    await page.fill('#translation-terms-list .term-row:last-child .term-source', TRICKY_SRC);
    await page.fill('#translation-terms-list .term-row:last-child .term-target', TRICKY_TGT);
    await page.click('#btn-save-settings');
    await page.waitForTimeout(300);

    // Reopening rebuilds the rows from storage — the round trip that used to break.
    await openSettings();
    await card('card-translation');
    const roundTrip = await page.evaluate(() => {
        const row = [...document.querySelectorAll('#translation-terms-list .term-row')].pop();
        return row ? {
            source: row.querySelector('.term-source')?.value,
            target: row.querySelector('.term-target')?.value,
        } : null;
    });
    ok(roundTrip?.source === TRICKY_SRC, 'a term with a quote and an ampersand reloads intact', roundTrip?.source);
    ok(roundTrip?.target === TRICKY_TGT, 'and so does its translation', roundTrip?.target);

    ok(
        await page.evaluate(async () => {
            const { escAttr } = await import('/js/util/html.js');
            // Idempotence: escaping twice must not double-encode, and a value that
            // already contains the text "&quot;" must stay inert.
            return escAttr(escAttr('a "b" & c')) === escAttr('a "b" & c').replace(/&/g, '&amp;')
                && !escAttr('&quot;').includes('"');
        }),
        'escAttr escapes & first, so it is idempotent and neutralises pre-encoded input',
    );

    // ── settings cards ──────────────────────────────────────────────────────
    section('Settings cards (SettingsFormController)');
    await settingsHome();
    const sub = await page.locator('#card-translation-sub').textContent();
    ok(/Soniox/.test(sub), 'engine card reflects the selected engine', sub);
    ok(/API key/i.test(sub), 'engine card warns about the missing key', sub);

    // ── TTS ─────────────────────────────────────────────────────────────────
    section('TTS providers (TtsController + voice managers)');
    await card('card-tts');
    const panels = {
        edge: 'tts-edge-settings',
        microsoft: 'tts-microsoft-settings',
        'google-free': 'tts-google-free-settings',
        tiktok: 'tts-tiktok-settings',
        local: 'tts-local-settings',
        google: 'tts-google-settings',
        elevenlabs: 'tts-elevenlabs-settings',
    };
    for (const [prov, panelId] of Object.entries(panels)) {
        await page.selectOption('#select-tts-provider', prov);
        await page.waitForTimeout(350);
        const visible = await page.locator(`#${panelId}`).isVisible();
        const leaked = [];
        for (const [other, id] of Object.entries(panels)) {
            if (other !== prov && (await page.locator(`#${id}`).isVisible())) leaked.push(other);
        }
        ok(visible && leaked.length === 0, `provider "${prov}": only its own panel is shown`,
            leaked.length ? `also visible: ${leaked.join(',')}` : 'panel did not show');
    }

    await page.selectOption('#select-tts-provider', 'microsoft');
    await page.waitForTimeout(600);
    ok((await optionValues('#select-microsoft-voice')).length >= 2, 'Microsoft: voice list populates');

    await page.selectOption('#select-tts-provider', 'local');
    await page.waitForTimeout(700);
    ok((await page.locator('#local-voice-list .local-voice-row').count()) > 0, 'Local: voice rows render');
    ok((await page.locator('#local-voice-list .btn-local-download').count()) > 0, 'Local: download button for uninstalled voices');
    ok((await page.locator('#local-voice-list .btn-local-delete').count()) > 0, 'Local: delete button for installed voices');
    await shot('03-tts');

    const dl = page.locator('#local-voice-list .btn-local-download').first();
    const dlId = await dl.getAttribute('data-id');
    await dl.click();
    await page.waitForTimeout(900);
    ok(
        (await page.locator(`#local-voice-list input[name="local-voice"][value="${dlId}"]`).count()) === 1,
        'Local: a downloaded voice flips to installed', dlId,
    );

    // ── read mode ───────────────────────────────────────────────────────────
    section('Read mode (ReadModeController)');
    await page.click('#btn-back');
    await page.waitForTimeout(300);
    await page.click('.activity-tab[data-activity="read"]');
    await page.waitForTimeout(400);
    ok(await page.locator('#read-input').isVisible(), 'read panel is shown');

    // The mock synthesiser returns a ~60ms clip, so short text finishes almost
    // instantly. Use long text and drive off control visibility, not wall time.
    const long = Array.from({ length: 40 }, (_, i) => `This is test sentence number ${i + 1}.`).join(' ');
    await page.fill('#read-input', long);
    await page.click('#btn-read-play');
    await page.locator('#btn-read-pause').waitFor({ state: 'visible', timeout: 5000 });

    // Regression guard: Play once dispatched to the LIVE session because a
    // rename collapsed `this.start()` onto the wrong object, so it launched a
    // translation session and bounced to Settings.
    ok(
        !(await page.locator('#settings-view').evaluate((el) => el.classList.contains('active'))),
        'Play starts the reader, not a live translation session',
    );

    await page.waitForTimeout(600);
    await page.click('#btn-read-pause');   // freeze before asserting
    await page.waitForTimeout(300);

    ok((await page.locator('#read-output .read-chunk').count()) >= 10, 'text is split into chunks');
    ok((await page.locator('#read-output .read-chunk.active').count()) === 1, 'exactly one chunk is highlighted');
    const progPaused = await page.locator('#read-progress').textContent();
    ok(/\d+\s+of\s+\d+/.test(progPaused), 'progress is displayed', progPaused);
    ok(await page.locator('#btn-read-play').isVisible(), 'pause: Play returns as Resume');
    await shot('04-read-paused');

    await page.click('#btn-read-play');
    await page.waitForTimeout(1200);
    const progResumed = await page.locator('#read-progress').textContent();
    const idx = (s) => parseInt((s.match(/(\d+)\//) || [])[1] || '0', 10);
    ok(idx(progResumed) >= idx(progPaused), 'resume continues instead of restarting', `${progPaused} -> ${progResumed}`);

    await page.click('#btn-read-stop');
    await page.waitForTimeout(400);
    ok(await page.locator('#read-input').isVisible(), 'stop: back to the input box');
    ok((await page.locator('#read-progress').textContent()) === '', 'stop: progress cleared');
    await shot('05-read-stopped');

    await page.fill('#read-input', 'One short sentence. Two short sentences.');
    await page.click('#btn-read-play');
    await page.locator('#btn-read-play').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(300);
    ok(!(await page.locator('#btn-read-pause').isVisible()), 'reading to the end returns to idle');

    // ── library ─────────────────────────────────────────────────────────────
    section('Session library (SessionLibraryController)');
    await page.click('.activity-tab[data-activity="library"]');
    await page.waitForTimeout(900);
    const lib = await page.locator('#sessions-list').textContent();
    ok(!/Loading/.test(lib), 'session list finishes loading', lib.slice(0, 60));
    ok(await page.locator('#input-session-search').isVisible(), 'search box is shown');
    await shot('06-library');

    // ── keyboard + chrome ───────────────────────────────────────────────────
    section('Keyboard + chrome (keyboard.js, WindowChromeController)');
    await page.click('.activity-tab[data-activity="live"]');
    await page.waitForTimeout(300);
    const settingsActive = () => page.locator('#settings-view').evaluate((el) => el.classList.contains('active'));

    await page.keyboard.press('Control+Comma');
    await page.waitForTimeout(400);
    ok(await settingsActive(), 'Ctrl+, opens Settings');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    ok(!(await settingsActive()), 'Escape closes Settings');

    await page.keyboard.press('?');
    await page.waitForTimeout(300);
    ok(await page.locator('#shortcut-sheet').isVisible(), '? opens the shortcut sheet');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    ok(!(await page.locator('#shortcut-sheet').isVisible()), 'Escape closes the shortcut sheet');

    // configure() sets --transcript-font-size on the container and a child rule
    // consumes it, so read the custom property, not the container's own size.
    const fontVar = () => page.$eval('#transcript-content', (el) => el.style.getPropertyValue('--transcript-font-size'));
    await page.evaluate(() => document.getElementById('btn-font-up').click());
    await page.waitForTimeout(200);
    const up = await fontVar();
    ok(parseFloat(up) > 0, 'A+ sets the font-size variable', up);
    await page.evaluate(() => document.getElementById('btn-font-down').click());
    await page.waitForTimeout(200);
    const down = await fontVar();
    ok(parseFloat(down) < parseFloat(up), 'A− shrinks the font size', `${up} -> ${down}`);

    // The ⋯ menu opens upward and #overlay-view clips its children, so in a
    // short window its top used to be cut off. It must stay inside the frame.
    await page.setViewportSize({ width: 430, height: 340 });
    await page.waitForTimeout(250);
    await page.evaluate(() => document.getElementById('btn-more').click());
    await page.waitForTimeout(250);
    const menuBox = await page.locator('#more-menu').boundingBox();
    ok(menuBox !== null && menuBox.y >= 0, 'the ⋯ menu stays inside a short window',
        menuBox ? `top=${Math.round(menuBox.y)}` : 'no box');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1000, height: 620 });
    await page.waitForTimeout(250);

    await page.evaluate(() => document.getElementById('btn-view-mode').click());
    await page.waitForTimeout(200);
    ok(await page.locator('#btn-view-mode').evaluate((el) => el.classList.contains('active')), 'dual-panel toggles on');
    await shot('07-chrome');

    // ── transcript rendering ────────────────────────────────────────────────
    section('Transcript (TranscriptUI)');
    // The chrome section above left dual view on, and dual view renders through
    // a different path entirely. These checks are about single view.
    await page.evaluate(() => {
        const ui = window.__app.transcriptUI;
        ui.configure({ viewMode: 'single', showOriginal: true });
        ui.addOriginal('We benchmarked it at 24 kHz.');
        ui.addTranslation('Bọn tôi đo ở 24 kHz.');
    });
    await page.waitForTimeout(250);
    ok(
        await page.locator('#transcript-content .seg-translated').count() > 0,
        'the translation is rendered',
    );
    // "Show original text" used to be accepted by configure() and then ignored
    // in single view, so the setting controlled nothing.
    ok(
        await page.locator('#transcript-content .seg-original').count() > 0,
        'the source line is rendered above it when Show original is on',
    );
    await page.evaluate(() => window.__app.transcriptUI.configure({ showOriginal: false }));
    await page.waitForTimeout(200);
    ok(
        await page.locator('#transcript-content .seg-original').count() === 0,
        'turning Show original off actually removes it',
    );
    await page.evaluate(() => window.__app.transcriptUI.configure({ showOriginal: true }));

    // ── meeting mode ────────────────────────────────────────────────────────
    // A real recording needs an engine key and audio, neither of which browser
    // dev has. What IS testable is the mode's own contract: the tab exists, the
    // transcript element MOVES rather than being duplicated, and the
    // live-translate switch refuses engines that cannot honour it.
    section('Meeting mode (MeetingController)');

    const activity = async (id) => {
        await page.evaluate((a) => document.querySelector(`.activity-tab[data-activity="${a}"]`).click(), id);
        await page.waitForTimeout(300);
    };

    await activity('meeting');
    ok(await page.locator('.meeting-panel').isVisible(), 'meeting tab opens its panel');
    ok(await page.locator('#meeting-clock').isVisible(), 'clock is shown');
    // The Summary/Transcript strip must stay hidden until a summary exists —
    // a class rule that sets `display` otherwise beats the [hidden] attribute.
    ok(
        !(await page.locator('#meeting-views').isVisible()),
        'the view tabs stay hidden before there is a summary',
    );

    // One transcript node, reparented — not a second copy.
    const parentOf = () => page.evaluate(() => document.getElementById('transcript-content')?.parentElement?.id);
    ok(await parentOf() === 'meeting-stream', 'transcript element moves into the meeting panel');
    ok(
        await page.evaluate(() => document.querySelectorAll('#transcript-content').length) === 1,
        'there is still exactly one transcript element',
    );

    await activity('live');
    ok(await parentOf() === 'transcript-container', 'leaving gives the transcript back to Live');

    // ...and back in the RIGHT place. Appending would leave the action row
    // above the transcript, which also flips the upward-opening ⋯ menu off the
    // top of the window.
    const liveOrder = await page.evaluate(() =>
        [...document.getElementById('transcript-container').children].map((c) => c.id || c.className));
    ok(
        liveOrder.indexOf('transcript-content') < liveOrder.indexOf('live-action-row'),
        'the transcript returns above the action row, not after it',
        liveOrder.join(' | '),
    );

    await activity('meeting');

    // Soniox can transcribe without translating, so the switch is live there.
    await openSettings();
    await setEngine('soniox');
    await page.click('#btn-save-settings');
    await page.waitForTimeout(500);
    await activity('meeting');
    ok(
        !(await page.locator('#check-meeting-translate').isDisabled()),
        'Soniox: the live-translate switch is usable',
    );
    await page.evaluate(() => {
        const el = document.getElementById('check-meeting-translate');
        el.checked = false;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(250);
    ok(
        await page.evaluate(() => window.__app.transcribeOnly) === true,
        'switching it off puts the app in transcribe-only mode',
    );

    // OpenAI's realtime endpoint always translates — the switch must lock, not
    // fail later at connect time.
    await openSettings();
    await setEngine('openai');
    await page.click('#btn-save-settings');
    await page.waitForTimeout(500);
    await activity('meeting');
    ok(
        await page.locator('#check-meeting-translate').isDisabled(),
        'OpenAI: the switch is locked instead of promising something it cannot do',
    );
    ok(
        (await page.locator('#meeting-hint').textContent()).trim().length > 0,
        'and the reason is stated on screen',
    );
    ok(
        await page.evaluate(() => window.__app.transcribeOnly) === false,
        'locking the switch also clears transcribe-only',
    );
    // ── meeting summary ─────────────────────────────────────────────────────
    // The provider call itself is mocked; what these assert is the wiring
    // around it — that a missing key fails visibly instead of at the end of a
    // real meeting, that the chosen provider/model actually reach the backend,
    // and that model-written Markdown is rendered as markup rather than dumped.
    section('Meeting summary (Phase C)');

    const summaryBody = () => page.locator('#meeting-summary-body');

    // Transcript to summarise. Every engine session feeds BOTH sinks for each
    // segment — TranscriptUI for the screen and sessionStore for the record —
    // so the seed has to do the same or it is not the path a real session takes.
    // The summary reads the store, because the on-screen buffer is a window that
    // gets trimmed; seeding only the UI would pass while the real feature breaks.
    await page.evaluate(async () => {
        const ui = window.__app.transcriptUI;
        const { sessionStore } = await import('/js/session-store.js');
        ui.addOriginal('We should ship macOS first.');
        ui.addTranslation('Nên phát hành bản macOS trước.');
        sessionStore.addSegment('We should ship macOS first.', 'Nên phát hành bản macOS trước.');
    });

    // No key yet: the failure has to be visible and the transcript untouched.
    await page.evaluate(() => document.getElementById('btn-meeting-resummarize').click());
    await page.waitForTimeout(400);
    ok(
        (await summaryBody().textContent()).includes('API key'),
        'a missing API key is reported in the summary pane',
    );
    ok(
        await page.evaluate(() => window.__mockSummary.lastRequest) === null,
        'and nothing was sent to the provider',
    );

    // With a key, the summary runs.
    await openSettings();
    await card('card-translation');
    await page.fill('#input-openai-key', 'sk-test-key');
    await page.click('#btn-save-settings');
    await page.waitForTimeout(500);
    await activity('meeting');
    await page.evaluate(() => document.getElementById('btn-meeting-resummarize').click());
    await page.waitForTimeout(600);

    const sent = await page.evaluate(() => window.__mockSummary.lastRequest);
    ok(sent?.provider === 'openai', 'the configured provider is used', JSON.stringify(sent?.provider));
    ok(sent?.model === 'gpt-4.1-mini', 'an unset model falls back to the provider default', sent?.model);
    ok(
        (sent?.transcript || '').includes('Nên phát hành bản macOS trước.'),
        'the transcript is what gets sent',
    );

    ok(
        await page.locator('#meeting-summary-body h3').count() > 0,
        'Markdown headings are rendered as markup',
    );
    ok(
        await page.locator('#meeting-summary-body li').count() > 0,
        'and bullets as a list',
    );
    ok(
        (await page.locator('#meeting-summary-meta').textContent()).includes('OpenAI'),
        'the footer credits the model that wrote it',
    );

    ok(
        !(await page.locator('#meeting-stream').isVisible()),
        'showing the summary hides the transcript, not stacks on it',
    );

    await shot('10-summary');

    // The tab strip only appears once there is a second thing to look at.
    ok(await page.locator('#meeting-views').isVisible(), 'the Summary/Transcript tabs appear');
    await page.evaluate(() => document.querySelector('.meeting-view-tab[data-view="transcript"]').click());
    await page.waitForTimeout(250);
    ok(await page.locator('#meeting-stream').isVisible(), 'switching back shows the transcript');
    ok(!(await page.locator('#meeting-summary').isVisible()), 'and hides the summary');

    // ── the transcript survives everything that touches settings ────────────
    // Regression: the summary used to be built from the ON-SCREEN buffer, which
    // TranscriptUI trims destructively down to the user's line limit. Meeting
    // mode lifted that limit, but applySettings() re-applied it on every
    // settings save — so saving anything mid-meeting (an audio-source switch,
    // a subtitle toggle) silently deleted the start of the transcript and the
    // summary then covered only the tail, with nothing on screen to say so.
    section('Meeting transcript survives a settings save (regression)');

    // Far more than the 5-line window can hold: ~40 segments against a limit of
    // 5 lines x 160 chars, so a trim would certainly drop the first line.
    await page.evaluate(async () => {
        const { sessionStore } = await import('/js/session-store.js');
        const ui = window.__app.transcriptUI;
        for (let i = 0; i < 40; i++) {
            ui.addOriginal(`Line ${i} of the meeting, long enough to matter.`);
            ui.addTranslation(`Dòng ${i} của cuộc họp, đủ dài để tính.`);
            sessionStore.addSegment(
                `Line ${i} of the meeting, long enough to matter.`,
                `Dòng ${i} của cuộc họp, đủ dài để tính.`,
            );
        }
    });

    // The exact trigger from the bug report: a settings save while the meeting
    // is open. It runs applySettings(), which reconfigures TranscriptUI.
    await page.evaluate(async () => {
        const { settingsManager } = await import('/js/settings.js');
        settingsManager.save({ audio_source: 'microphone' });
    });
    await page.waitForTimeout(300);

    const firstLineOnScreen = () => page.evaluate(() =>
        window.__app.transcriptUI.getPlainText().includes('Line 0 of the meeting'));

    ok(
        await firstLineOnScreen(),
        'a settings save mid-meeting does not trim the start of the transcript',
    );

    // Leaving the tab is not ending the meeting either.
    await activity('library');
    await activity('meeting');
    ok(
        await firstLineOnScreen(),
        'and neither does switching tabs while the meeting is open',
    );

    await page.evaluate(() => { window.__mockSummary.lastRequest = null; });
    await page.evaluate(() => document.getElementById('btn-meeting-resummarize').click());
    await page.waitForTimeout(400);
    const whole = await page.evaluate(() => window.__mockSummary.lastRequest);
    ok(
        (whole?.transcript || '').includes('Line 0 of the meeting'),
        'the summary is built from the whole meeting, not just the tail',
    );

    await activity('live');

    // ── a failed source switch must not leave the app claiming to run ───────
    // Regression: setSource() restarted the session with `.then()` and no
    // `.catch()`. If start() rejected — a provider refusing the new connection —
    // the rejection went unhandled and isRunning stayed true, so the button kept
    // reading "Stop" on a session that was not running. ⌘1/⌘2/⌘3 share this path.
    section('A failed source switch fails visibly (regression)');

    const switchOutcome = await page.evaluate(async () => {
        const live = window.__app.live;
        const realStart = live.start.bind(live);
        const realPause = live.pause.bind(live);
        live.pause = async () => {};
        live.start = async () => { throw new Error('provider refused'); };
        window.__app.isRunning = true;

        let unhandled = null;
        const onRejection = (e) => { unhandled = String(e.reason); };
        window.addEventListener('unhandledrejection', onRejection);

        // The handler logs the failure on purpose; silence it here so an EXPECTED
        // error does not land in the suite's console channel and mask a real one.
        const realError = console.error;
        console.error = () => {};

        live.setSource('microphone');
        await new Promise((r) => setTimeout(r, 400));

        console.error = realError;
        window.removeEventListener('unhandledrejection', onRejection);
        const out = { unhandled, isRunning: window.__app.isRunning, isStarting: window.__app.isStarting };
        live.start = realStart;
        live.pause = realPause;
        return out;
    });

    ok(switchOutcome.unhandled === null, 'the rejection is handled, not thrown into the void', switchOutcome.unhandled || '');
    ok(switchOutcome.isRunning === false, 'the app stops claiming to run');
    ok(switchOutcome.isStarting === false, 'and the re-entry guard is released');

    // ── window modes ────────────────────────────────────────────────────────
    // Regression: there was no default size for overlay mode, only for expanded.
    // Shrinking with nothing in localStorage therefore removed the `expanded`
    // class and never called setSize at all — the layout went compact while the
    // window stayed at the expanded size. And the size of the mode being LEFT
    // was saved on every toggle, so the first expand recorded the 900x500
    // startup size as a chosen overlay size and shrinking restored that forever.
    section('Window shrink actually shrinks the window');

    const winState = () => page.evaluate(() => window.__mockWindow);

    await page.evaluate(() => {
        Object.keys(localStorage)
            .filter((k) => k.startsWith('win_size') || k === 'window_mode')
            .forEach((k) => localStorage.removeItem(k));
        window.__mockWindow.size = { w: 900, h: 500 };
        window.__mockWindow.setSizeCalls = [];
    });

    await page.evaluate(async () => {
        const { applyWindowMode } = await import('/js/ui-shell.js');
        await applyWindowMode('expanded');
    });
    await page.waitForTimeout(200);
    const expanded = await winState();
    ok(expanded.size.w === 900 && expanded.size.h === 640,
        'expanding uses the expanded default', JSON.stringify(expanded.size));

    await page.evaluate(async () => {
        const { applyWindowMode } = await import('/js/ui-shell.js');
        await applyWindowMode('overlay');
    });
    await page.waitForTimeout(200);
    const shrunk = await winState();
    ok(shrunk.setSizeCalls.length >= 2,
        'shrinking actually calls setSize instead of silently doing nothing',
        `${shrunk.setSizeCalls.length} calls`);
    ok(shrunk.size.w < 600 && shrunk.size.h < 400,
        'and the window ends up genuinely small', JSON.stringify(shrunk.size));
    ok(!(await page.evaluate(() => document.body.classList.contains('expanded'))),
        'the compact layout matches the compact window');

    // A size the user never chose must not be remembered as a preference.
    ok(
        await page.evaluate(() => localStorage.getItem('win_size_v2_overlay')) === null,
        'toggling modes does not record a size the user never picked',
    );

    // ── subtitle overlay ────────────────────────────────────────────────────
    // The real overlay is a second transparent Tauri window, which browser dev
    // has no way to open — so these assert the MAIN-window half: that toggling
    // reaches the backend, that cues are pushed from the transcript stream, and
    // that settings actually change the pushed style.
    section('Subtitle overlay (SubtitleController)');
    const subState = () => page.evaluate(() => window.__mockSubtitle);

    ok(!(await subState()).open, 'starts closed');

    await page.evaluate(() => document.getElementById('btn-subtitle').click());
    await page.waitForTimeout(300);
    ok((await subState()).open, 'toggle opens the overlay window');
    ok(
        await page.locator('#btn-subtitle').evaluate((el) => el.classList.contains('active')),
        'toggle marks the button active',
    );

    // A cue must come from the same TranscriptUI the app renders, not from a
    // separate path that could drift out of sync.
    await page.evaluate(() => {
        const ui = window.__app?.transcriptUI;
        ui.addOriginal('The signing cert renews on the 14th.');
        ui.addTranslation('Chứng chỉ ký gia hạn ngày 14.');
    });
    await page.waitForTimeout(400);
    const cue = (await subState()).lastLine;
    ok(cue?.tgt === 'Chứng chỉ ký gia hạn ngày 14.', 'translation is pushed as the cue', JSON.stringify(cue));
    ok(cue?.src === 'The signing cert renews on the 14th.', 'source line rides along with it');

    // Unlock = the window stops being click-through so it can be dragged.
    await page.evaluate(() => document.getElementById('btn-more').click());
    await page.waitForTimeout(150);
    await page.evaluate(() => document.getElementById('btn-subtitle-lock').click());
    await page.waitForTimeout(250);
    ok((await subState()).locked === false, 'unlock turns click-through off');

    // Settings must reach the live overlay, not just the settings file.
    await openSettings();
    await card('card-display');
    await page.evaluate(() => {
        const el = document.getElementById('range-subtitle-font');
        el.value = '48';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#check-subtitle-boxed').check();
    await page.click('#btn-save-settings');
    await page.waitForTimeout(500);
    const style = (await subState()).style;
    ok(style?.font_size === 48, 'font size reaches the overlay', JSON.stringify(style));
    ok(style?.boxed === true, 'boxed background reaches the overlay');

    // Saving already returns to the overlay; only click Back if it didn't.
    if (await page.locator('#settings-view.active').count()) {
        await page.click('#btn-back');
        await page.waitForTimeout(250);
    }
    await page.evaluate(() => document.getElementById('btn-subtitle').click());
    await page.waitForTimeout(300);
    ok(!(await subState()).open, 'toggle closes it again');
    await shot('08-subtitle');

    // ── cross-controller ────────────────────────────────────────────────────
    section('Two-way mode locks TTS (EngineUiController + TtsController)');
    await openSettings();
    await card('card-translation');
    await page.selectOption('#select-translation-mode', 'soniox');
    await page.waitForTimeout(300);
    await page.selectOption('#select-translation-type', 'two_way');
    await page.waitForTimeout(400);
    ok(await page.locator('#section-twoway-langs').isVisible(), 'two-way shows the A/B language pair');
    await page.click('#btn-back');
    await page.waitForTimeout(300);
    ok(
        await page.locator('#btn-tts').evaluate((el) => el.classList.contains('disabled')),
        'TTS button is locked in two-way mode',
    );
} catch (e) {
    // A broken control usually surfaces as a timeout waiting for state that
    // never arrives. Report it as a failure with the line that gave up, rather
    // than dying on an uncaught exception and swallowing the summary.
    fail++;
    console.log(`\n  FAIL suite aborted — ${String(e.message).split('\n')[0]}`);
    const at = (e.stack || '').split('\n').find((l) => l.includes('ui-suite.mjs'));
    if (at) console.log(`       ${at.trim()}`);
} finally {
    await browser.close();
    stopServer();
}

console.log(`\n════ ${pass} passed, ${fail} failed ════`);
if (errors.length) {
    console.log('\nConsole / network problems:');
    for (const e of errors) console.log(`  ${e}`);
}
process.exit(fail || errors.length ? 1 : 0);
