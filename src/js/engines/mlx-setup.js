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
    const cancelBtn = document.getElementById('btn-cancel-setup');

    // Step mapping: step name → total progress weight
    const stepWeights = { check: 5, venv: 10, packages: 35, models: 50 };
    let totalProgress = 0;

    const updateStep = (stepName, icon, isActive) => {
        const stepEl = document.getElementById(`step-${stepName}`);
        if (!stepEl) return;
        stepEl.querySelector('.step-icon').textContent = icon;
        stepEl.classList.toggle('active', isActive);
        stepEl.classList.toggle('done', icon === '✅');
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
                            if (i < currentIdx) updateStep(s, '✅', false);
                            else if (i === currentIdx) updateStep(s, '🔄', true);
                        });

                        if (data.done) {
                            updateStep(data.step, '✅', false);
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
                    statusText.textContent = '✅ ' + (data.message || 'Setup complete!');
                    ['check', 'venv', 'packages', 'models'].forEach(s => updateStep(s, '✅', false));

                    // Close modal after brief delay
                    setTimeout(() => {
                        modal.style.display = 'none';
                        resolve();
                    }, 1000);
                    break;

                case 'error':
                    statusText.textContent = '❌ ' + (data.message || 'Setup failed');
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
                statusText.textContent = '❌ ' + err;
                modal.style.display = 'none';
                reject(err);
            });
    });
}
