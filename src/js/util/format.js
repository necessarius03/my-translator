/** Small formatting/timing helpers shared across controllers. */

export function formatSeconds(sec) {
    if (!sec) return '';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${sec}s`;
}

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
