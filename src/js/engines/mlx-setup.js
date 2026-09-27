/**
 * One-time MLX model setup: drives the progress modal and resolves when the
 * Rust side reports completion. Rejects on cancel or error.
 */

const { invoke } = window.__TAURI__.core;

export async function runMlxSetup() {
    const modal = document.getElementById('setup-modal');
    const progressFill = document.getElementById('setup-progress-fill');
    const progressPct = document.getElementById('setup-progress-pct');
    const statusText = document.getElementById('setup-status-text');
    // The row, not the sentence, carries the failure state — see .setup-status.is-error.
    const setupStatus = document.querySelector('.setup-status');
    const cancelBtn = document.getElementById('btn-cancel-setup');

    // Step mapping: step name → total progress weight
    const stepWeights = { check: 5, venv: 10, packages: 35, models: 50 };
    let totalProgress = 0;

    // Step state is a NAME, not a glyph. It used to be the emoji itself, with
    // `icon === '✅'` standing in for "done" — which meant the visual and the
    // state were the same string and neither could change without the other.
    const STEP_ICON = {
        pending: 'i-circle',
        busy: 'i-loader',
        done: 'i-check-circle',
        error: 'i-x-circle',
    };

    const updateStep = (stepName, state, isActive) => {
        const stepEl = document.getElementById(`step-${stepName}`);
        if (!stepEl) return;
        const spin = state === 'busy' ? ' ic-spin' : '';
        stepEl.querySelector('.step-icon').innerHTML =
            `<svg class="ic ic-sm${spin}" viewBox="0 0 24 24"><use href="#${STEP_ICON[state] || STEP_ICON.pending}" /></svg>`;
        stepEl.classList.toggle('active', isActive);
        stepEl.classList.toggle('done', state === 'done');
    };

    const updateProgress = (pct) => {
        totalProgress = Math.min(100, pct);
        progressFill.style.width = totalProgress + '%';
        progressPct.textContent = Math.round(totalProgress) + '%';
    };

    // Show modal
    modal.style.display = 'flex';

    return new Promise((resolve, reject) => {
        const channel = new window.__TAURI__.core.Channel();

        // Cancel handler
        const onCancel = () => {
            modal.style.display = 'none';
            reject(new Error('Setup cancelled'));
        };
        cancelBtn.addEventListener('click', onCancel, { once: true });

        channel.onmessage = (msg) => {
            let data;
            try {
                data = (typeof msg === 'string') ? JSON.parse(msg) : msg;
            } catch (e) {
                return;
            }

            switch (data.type) {
                case 'progress':
                    statusText.textContent = data.message || 'Working...';

                    // Update step indicators
                    if (data.step) {
                        // Mark previous steps as done
                        const steps = ['check', 'venv', 'packages', 'models'];
                        const currentIdx = steps.indexOf(data.step);
                        steps.forEach((s, i) => {
                            if (i < currentIdx) updateStep(s, 'done', false);
                            else if (i === currentIdx) updateStep(s, 'busy', true);
                        });

                        if (data.done) {
                            updateStep(data.step, 'done', false);
                        }

                        // Calculate overall progress
                        let pct = 0;
                        steps.forEach((s, i) => {
                            if (i < currentIdx) pct += stepWeights[s];
                            else if (i === currentIdx) {
                                pct += (data.progress || 0) / 100 * stepWeights[s];
                            }
                        });
                        updateProgress(pct);
                    }
                    break;

                case 'complete':
                    updateProgress(100);
                    statusText.textContent = data.message || 'Setup complete!';
                    setupStatus?.classList.remove('is-error');
                    ['check', 'venv', 'packages', 'models'].forEach(s => updateStep(s, 'done', false));

                    // Close modal after brief delay
                    setTimeout(() => {
                        modal.style.display = 'none';
                        resolve();
                    }, 1000);
                    break;

                case 'error':
                    statusText.textContent = data.message || 'Setup failed';
                    setupStatus?.classList.add('is-error');
                    cancelBtn.textContent = 'Close';
                    cancelBtn.removeEventListener('click', onCancel);
                    cancelBtn.addEventListener('click', () => {
                        modal.style.display = 'none';
                        reject(new Error(data.message));
                    }, { once: true });
                    break;

                case 'log':
                    console.log('[MLX Setup]', data.message);
                    break;
            }
        };

        invoke('run_mlx_setup', { channel })
            .catch(err => {
                statusText.textContent = String(err);
                setupStatus?.classList.add('is-error');
                modal.style.display = 'none';
                reject(err);
            });
    });
}
