/**
 * @param {string} selector
 */
function selectorToNeedle(selector) {
    const trimmed = String(selector || "").trim();
    if (!trimmed) {
        return null;
    }

    if (trimmed.startsWith("#")) {
        const id = trimmed.slice(1).split(/\s+/)[0];
        return {type: "id", value: id, patterns: [`id="${id}"`, `id='${id}'`]};
    }

    const classMatch = trimmed.match(/^\.([a-zA-Z0-9_-]+)/);
    if (classMatch) {
        const className = classMatch[1];
        return {
            type: "class",
            value: className,
            patterns: [
                `class="${className}"`,
                `class='${className}'`,
                `class="[^"]*\\b${className}\\b`,
                `class='[^']*\\b${className}\\b`
            ]
        };
    }

    return {type: "raw", value: trimmed, patterns: [trimmed]};
}

/**
 * @param {string} content
 * @param {string} selector
 * @param {number} contextChars
 */
export function extractHtmlSnippet(content, {selector, contextChars = 6000, maxChars = 12000} = {}) {
    const source = String(content || "");
    if (!selector) {
        const snippet = source.slice(0, maxChars);
        return {
            found: true,
            selector: null,
            startIndex: 0,
            endIndex: snippet.length,
            truncated: source.length > snippet.length,
            snippet
        };
    }

    const needle = selectorToNeedle(selector);
    if (!needle) {
        const snippet = source.slice(0, maxChars);
        return {
            found: false,
            selector,
            reason: "empty_selector",
            truncated: source.length > snippet.length,
            snippet
        };
    }

    let matchIndex = -1;
    for (const pattern of needle.patterns) {
        if (pattern.includes("[^")) {
            const regex = new RegExp(pattern);
            const match = regex.exec(source);
            if (match) {
                matchIndex = match.index;
                break;
            }
        } else {
            const index = source.indexOf(pattern);
            if (index >= 0) {
                matchIndex = index;
                break;
            }
        }
    }

    if (matchIndex < 0 && needle.type === "class") {
        matchIndex = source.indexOf(needle.value);
    }

    if (matchIndex < 0) {
        const snippet = source.slice(0, Math.min(maxChars, 4000));
        return {
            found: false,
            selector,
            reason: "selector_not_found",
            truncated: true,
            snippet,
            hint: "Try vitour_list_pages suggestedSelectors or a simpler class/id selector."
        };
    }

    const startIndex = Math.max(0, matchIndex - contextChars);
    const endIndex = Math.min(source.length, matchIndex + contextChars);
    let snippet = source.slice(startIndex, endIndex);

    if (snippet.length > maxChars) {
        const center = matchIndex - startIndex;
        const half = Math.floor(maxChars / 2);
        snippet = snippet.slice(Math.max(0, center - half), Math.min(snippet.length, center + half));
    }

    return {
        found: true,
        selector,
        matchType: needle.type,
        matchValue: needle.value,
        startIndex,
        endIndex,
        truncated: startIndex > 0 || endIndex < source.length,
        snippet
    };
}
