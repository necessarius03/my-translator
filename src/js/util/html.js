/** HTML escaping for the few places that build markup by hand. */

export function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Escape for use inside a double-quoted HTML attribute.
 *
 * `&` goes FIRST, and it has to be here at all: without it the function is not
 * idempotent and, worse, it passes pre-encoded text straight through — a stored
 * value containing the literal characters `&quot;` came out unchanged, and the
 * browser then decoded it into a real quote that closed the attribute. Escaping
 * `&` first also stops the entities produced below from being re-escaped.
 */
export function escAttr(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Minimal Markdown → HTML for model-written meeting summaries.
 *
 * Deliberately tiny and deliberately escape-first: the input is text a language
 * model produced from a meeting transcript, so it is untrusted and must never
 * be able to inject markup. Only the constructs the summary prompt actually
 * asks for are rendered — headings, bullets, bold, quotes, paragraphs — and
 * anything else stays literal text.
 */
export function renderSummaryMarkdown(md) {
    const inline = (t) => esc(t)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');

    const out = [];
    let list = null;

    const closeList = () => {
        if (list) {
            out.push(`<ul>${list.join('')}</ul>`);
            list = null;
        }
    };

    for (const raw of String(md ?? '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) {
            closeList();
            continue;
        }

        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
            closeList();
            // "#" renders as h2 — the panel already has its own h1-equivalent.
            const level = Math.min(heading[1].length + 1, 5);
            out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
            continue;
        }

        const bullet = line.match(/^[-*+]\s+(.*)$/);
        if (bullet) {
            (list ??= []).push(`<li>${inline(bullet[1])}</li>`);
            continue;
        }

        const quote = line.match(/^>\s*(.*)$/);
        if (quote) {
            closeList();
            out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
            continue;
        }

        closeList();
        out.push(`<p>${inline(line)}</p>`);
    }

    closeList();
    return out.join('');
}
