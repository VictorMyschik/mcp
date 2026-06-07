/** @typedef {{ slug: string, purpose: string, outventoHint?: string, selectors?: string[] }} VitourPageHint */

/** @type {Record<string, VitourPageHint>} */
export const VITOUR_PAGE_HINTS = {
    "index.html": {
        slug: "home",
        purpose: "Main landing / hero sections",
        outventoHint: "Welcome / marketing pages"
    },
    "home2.html": {slug: "home2", purpose: "Alternate home layout"},
    "home3.html": {slug: "home3", purpose: "Alternate home layout"},
    "home4.html": {slug: "home4", purpose: "Alternate home layout"},
    "home5.html": {slug: "home5", purpose: "Alternate home layout"},
    "blog.html": {
        slug: "blog",
        purpose: "Blog / news list cards and sidebar",
        outventoHint: "travelfront NewsListPage, NewsHubPage",
        selectors: [".blog-list", ".sidebar", ".pagination"]
    },
    "blog-details.html": {
        slug: "blog-details",
        purpose: "Blog / news article detail, comments, related posts",
        outventoHint: "travelfront NewsDetailPage",
        selectors: [".blog-details", ".post-content", ".comment-area"]
    },
    "about-us.html": {
        slug: "about",
        purpose: "About page sections",
        outventoHint: "Outvento about-us page"
    },
    "contact-us.html": {slug: "contact", purpose: "Contact form layout"},
    "tour-single.html": {slug: "tour-single", purpose: "Single tour / trip detail"},
    "tour-package-v2.html": {slug: "tour-package-v2", purpose: "Tour package listing v2"},
    "tour-package-v4.html": {slug: "tour-package-v4", purpose: "Tour package listing v4"},
    "tour-destination-v1.html": {slug: "tour-destination-v1", purpose: "Destination listing v1"},
    "tour-destination-v2.html": {slug: "tour-destination-v2", purpose: "Destination listing v2"},
    "tour-destination-v3.html": {slug: "tour-destination-v3", purpose: "Destination listing v3"},
    "single-destination.html": {slug: "single-destination", purpose: "Single destination detail"},
    "archieve-tour.html": {slug: "archive-tour", purpose: "Tour archive / search results"},
    "gallery.html": {slug: "gallery", purpose: "Image gallery grid"},
    "team.html": {slug: "team", purpose: "Team members grid"},
    "dashboard.html": {slug: "dashboard", purpose: "User dashboard shell"},
    "login.html": {slug: "login", purpose: "Login form (reference only)"},
    "sign-up.html": {slug: "sign-up", purpose: "Registration form (reference only)"},
    "my-profile.html": {slug: "my-profile", purpose: "Account profile layout"},
    "my-booking.html": {slug: "my-booking", purpose: "Bookings list"},
    "my-favorite.html": {slug: "my-favorite", purpose: "Favorites list"},
    "my-listing.html": {slug: "my-listing", purpose: "Host listings"},
    "add-tour.html": {slug: "add-tour", purpose: "Create tour form"},
    "help-center.html": {slug: "help-center", purpose: "FAQ / help layout"},
    "terms-condition.html": {slug: "terms", purpose: "Legal / terms page"}
};

const SLUG_TO_FILE = Object.fromEntries(
    Object.entries(VITOUR_PAGE_HINTS).map(([file, hint]) => [hint.slug, file])
);

/**
 * @param {string} pageOrFile
 * @returns {string}
 */
export function normalizeVitourPageInput(pageOrFile) {
    const raw = String(pageOrFile || "").trim();
    if (!raw) {
        return "";
    }

    if (raw.endsWith(".html")) {
        return pathBasename(raw);
    }

    const bySlug = SLUG_TO_FILE[raw.toLowerCase()];
    if (bySlug) {
        return bySlug;
    }

    if (!raw.includes(".")) {
        return `${raw}.html`;
    }

    return raw;
}

function pathBasename(value) {
    const parts = String(value).replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || value;
}

/**
 * @param {string} root
 * @param {import("node:fs").Dirent[]} entries
 */
export function buildVitourPageCatalog(root, entries) {
    const htmlFiles = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));

    return htmlFiles.map((file) => {
        const hint = VITOUR_PAGE_HINTS[file] || null;
        return {
            file,
            path: `/${file}`,
            slug: hint?.slug || file.replace(/\.html$/i, ""),
            purpose: hint?.purpose || "Vitour HTML page",
            outventoHint: hint?.outventoHint || null,
            suggestedSelectors: hint?.selectors || [],
            root
        };
    });
}
