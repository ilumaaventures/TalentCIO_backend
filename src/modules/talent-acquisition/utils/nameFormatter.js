/**
 * Standardizes candidate names across CV parsing, public applications, and internal forms.
 * - Normalizes Unicode compatibility characters (NFKC) so styled/fancy Unicode fonts become plain text.
 * - Strips invisible/zero-width characters and normalizes whitespace.
 * - Optionally collapses spaced-out single letters (common in PDF extraction, e.g. "J O H N   D O E").
 * - Applies consistent Title Case (First letter uppercase, rest lowercase; preserves hyphens & apostrophes).
 */
const collapseSpacedOutLetters = (input) => {
    const segments = input.split(/\s{2,}|\t+/);
    const normalizedSegments = segments.map((segment) => {
        const tokens = segment.trim().split(' ').filter(Boolean);
        if (tokens.length >= 3 && tokens.every((token) => /^\p{L}$/u.test(token))) {
            return tokens.join('');
        }
        return tokens.join(' ');
    });
    return normalizedSegments.filter(Boolean).join(' ');
};

const toTitleCaseWord = (word) => {
    if (!word) return '';
    return word
        .toLocaleLowerCase()
        .replace(/(^|[-'’])(\p{L})/gu, (match, sep, char) => `${sep}${char.toLocaleUpperCase()}`);
};

const normalizeCandidateName = (rawName, { collapseSpacedLetters = false } = {}) => {
    if (typeof rawName !== 'string') {
        return '';
    }

    let cleaned = rawName
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
        .replace(/\u00A0/g, ' ')
        .trim();

    if (!cleaned) {
        return '';
    }

    if (collapseSpacedLetters) {
        cleaned = collapseSpacedOutLetters(cleaned);
    }

    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    return cleaned
        .split(' ')
        .map(toTitleCaseWord)
        .join(' ');
};

module.exports = {
    normalizeCandidateName
};
