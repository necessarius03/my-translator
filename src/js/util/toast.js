/**
 * Transient bottom toast. One at a time — a new toast replaces the old.
 *
 * The icon belongs to the toast, not to the message. Callers used to prefix
 * their own emoji ("✅ App is up to date", "❌ Invalid API key") which meant
 * every call site re-decided what an error looks like, and the glyph ignored
 * the theme. Now `type` picks the icon in one place and messages stay plain
 * text — which also keeps them greppable and translatable.
 *
 * Colour alone would not do: a red pill and a green pill read the same to a
 * red-green colourblind user, so the shape has to carry the meaning too.
 */
const TOAST_ICON = {
    success: 'i-check-circle',
    error: 'i-x-circle',
    info: 'i-info',
};

export function showToast(message, type = 'success') {
    // Remove existing toast
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    // Icon markup is static, so innerHTML is safe here; the message goes in as
    // textContent because it can carry a provider's error string verbatim.
    toast.innerHTML =
        `<svg class="ic ic-sm" viewBox="0 0 24 24">`
        + `<use href="#${TOAST_ICON[type] || TOAST_ICON.info}" /></svg>`;
    const label = document.createElement('span');
    label.textContent = message;
    toast.appendChild(label);
    document.body.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    // Auto-remove (longer for errors)
    const duration = type === 'error' ? 5000 : 3000;
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}
