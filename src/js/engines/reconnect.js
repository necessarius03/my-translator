/**
 * Reconnect policy shared by the cloud-realtime engines (OpenAI, Qwen).
 *
 * A dropped session used to schedule a flat 1s retry with no cap, and the
 * superseded client was never disconnected — so every orphan kept its own
 * `onClosed` handler and scheduled another start(). Retries multiplied instead
 * of repeating (1 → 2 → 4 → 8 sessions), and the backend eventually answered
 * the flood with a TCP reset (os error 10054). Engines now keep exactly one
 * live client and back off between attempts.
 */

export const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
// A session that stayed up at least this long counts as healthy: the next drop
// starts a fresh incident instead of counting toward the give-up limit.
const HEALTHY_MS = 30_000;

export class ReconnectPolicy {
    constructor() {
        this.retries = 0;
        this.connectedAt = 0;
    }

    reset() {
        this.retries = 0;
        this.connectedAt = 0;
    }

    /** Called when the engine reports a live session. */
    markConnected() {
        this.connectedAt = Date.now();
    }

    /**
     * Delay in ms before the next attempt, or null when the engine should stop
     * retrying and hand control back to the user.
     */
    nextDelay() {
        if (this.connectedAt && Date.now() - this.connectedAt >= HEALTHY_MS) this.retries = 0;
        this.connectedAt = 0;
        if (this.retries >= MAX_RETRIES) return null;
        const delay = BASE_DELAY_MS * 2 ** this.retries;
        this.retries++;
        return delay;
    }
}
