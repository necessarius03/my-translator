/** Global keyboard shortcuts. Bound once at startup against the App root. */
import { showToast } from '../util/toast.js';
import { getActivity } from '../ui-shell.js';

export function bindKeyboardShortcuts(app) {
    document.addEventListener('keydown', (e) => {
        // Ignore when typing in input fields (SELECT: keep native typeahead)
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
            return;
        }

        // Cmd/Ctrl + Enter: Start/Stop
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            if (app.isStarting) return;
            // On the Meeting tab this is the meeting's own Start / End, so the
            // session is tagged a meeting and its clock runs.
            if (getActivity() === 'meeting') {
                app.meeting.toggleRecording();
                return;
            }
            (async () => {
                try {
                    if (app.isRunning) {
                        await app.live.stopSession();
                    } else {
                        app.isStarting = true;
                        await app.live.start();
                    }
                } catch (err) {
                    console.error('[App] Keyboard start/stop error:', err);
                    showToast(`Error: ${err}`, 'error');
                    app.isRunning = false;
                    app.live.updateStartButton();
                    app.live.updateStatus('error');
                } finally {
                    app.isStarting = false;
                }
            })();
        }

        // Escape: Go back to overlay / close settings
        if (e.key === 'Escape') {
            e.preventDefault();
            // Shortcut sheet closes first if open
            const sheet = document.getElementById('shortcut-sheet');
            if (sheet && sheet.style.display !== 'none') {
                app.chrome.toggleShortcutSheet?.(false);
                return;
            }
            const settingsVisible = document.getElementById('settings-view').classList.contains('active');
            if (settingsVisible) {
                app.showView('overlay');
            }
        }

        // "?": shortcut cheat-sheet (guarded above from input/textarea)
        if (e.key === '?' && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            app.chrome.toggleShortcutSheet?.(true);
        }

        // Cmd/Ctrl + ,: Open settings
        if ((e.metaKey || e.ctrlKey) && e.key === ',') {
            e.preventDefault();
            app.showView('settings');
        }

        // Cmd/Ctrl + 1: Switch to System Audio
        if ((e.metaKey || e.ctrlKey) && e.key === '1') {
            e.preventDefault();
            app.live.setSource('system');
        }

        // Cmd/Ctrl + 2: Switch to Microphone
        if ((e.metaKey || e.ctrlKey) && e.key === '2') {
            e.preventDefault();
            app.live.setSource('microphone');
        }

        // Cmd/Ctrl + 3: Switch to Both
        if ((e.metaKey || e.ctrlKey) && e.key === '3') {
            e.preventDefault();
            app.live.setSource('both');
        }

        // Cmd/Ctrl + T: Toggle TTS
        if ((e.metaKey || e.ctrlKey) && e.key === 't') {
            e.preventDefault();
            app.tts.toggle();
        }

        // Cmd/Ctrl + U: Toggle the on-screen subtitle overlay
        if ((e.metaKey || e.ctrlKey) && e.key === 'u') {
            e.preventDefault();
            app.subtitle.toggle();
        }

        // Cmd/Ctrl + Shift + U: Lock/unlock it for dragging
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'U' || e.key === 'u')) {
            e.preventDefault();
            app.subtitle.toggleLock();
        }

        // Cmd/Ctrl + M: Minimize
        if ((e.metaKey || e.ctrlKey) && e.key === 'm') {
            e.preventDefault();
            app.chrome.savePosition();
            app.appWindow.minimize();
        }

        // Cmd/Ctrl + P: Toggle Pin
        if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
            e.preventDefault();
            app.chrome.togglePin();
        }

        // Cmd/Ctrl + D: Toggle Compact
        if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
            e.preventDefault();
            app.chrome.toggleCompact();
        }
    });
}
