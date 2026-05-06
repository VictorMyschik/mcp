import {browserError} from "./browser-errors.js";

const DEFAULT_STYLE_PROPERTIES = [
    "display",
    "position",
    "top",
    "right",
    "bottom",
    "left",
    "width",
    "height",
    "min-width",
    "min-height",
    "max-width",
    "max-height",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "overflow",
    "overflow-x",
    "overflow-y",
    "box-sizing",
    "align-items",
    "justify-content",
    "flex-direction",
    "gap",
    "grid-template-columns",
    "grid-template-rows",
    "transform",
    "z-index"
];

const ALLOWED_WAIT_UNTIL = new Set(["load", "domcontentloaded", "networkidle", "commit"]);

const LAYOUT_ASSERTION_SPECS = {
    topLessThanOrEqual: {field: "top", operator: "<="},
    topLessThan: {field: "top", operator: "<"},
    topGreaterThanOrEqual: {field: "top", operator: ">="},
    topGreaterThan: {field: "top", operator: ">"},
    leftLessThanOrEqual: {field: "left", operator: "<="},
    leftLessThan: {field: "left", operator: "<"},
    leftGreaterThanOrEqual: {field: "left", operator: ">="},
    leftGreaterThan: {field: "left", operator: ">"},
    rightLessThanOrEqual: {field: "right", operator: "<="},
    rightLessThan: {field: "right", operator: "<"},
    rightGreaterThanOrEqual: {field: "right", operator: ">="},
    rightGreaterThan: {field: "right", operator: ">"},
    bottomLessThanOrEqual: {field: "bottom", operator: "<="},
    bottomLessThan: {field: "bottom", operator: "<"},
    bottomGreaterThanOrEqual: {field: "bottom", operator: ">="},
    bottomGreaterThan: {field: "bottom", operator: ">"},
    widthLessThanOrEqual: {field: "width", operator: "<="},
    widthLessThan: {field: "width", operator: "<"},
    widthGreaterThanOrEqual: {field: "width", operator: ">="},
    widthGreaterThan: {field: "width", operator: ">"},
    heightLessThanOrEqual: {field: "height", operator: "<="},
    heightLessThan: {field: "height", operator: "<"},
    heightGreaterThanOrEqual: {field: "height", operator: ">="},
    heightGreaterThan: {field: "height", operator: ">"},
    xLessThanOrEqual: {field: "x", operator: "<="},
    xLessThan: {field: "x", operator: "<"},
    xGreaterThanOrEqual: {field: "x", operator: ">="},
    xGreaterThan: {field: "x", operator: ">"},
    yLessThanOrEqual: {field: "y", operator: "<="},
    yLessThan: {field: "y", operator: "<"},
    yGreaterThanOrEqual: {field: "y", operator: ">="},
    yGreaterThan: {field: "y", operator: ">"}
};

function isLoginUrl(url) {
    try {
        const pathname = new URL(url).pathname.toLowerCase();
        return pathname.includes("/login");
    } catch {
        return String(url || "").toLowerCase().includes("/login");
    }
}

function resolveUrl(session, url) {
    if (!url) {
        return session.page.url() || session.baseUrl;
    }

    try {
        return new URL(url).toString();
    } catch {
        return new URL(url, session.baseUrl).toString();
    }
}

function normalizeTimeout(timeoutMs, fallback = 30000) {
    const value = Number(timeoutMs);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isPlaywrightTimeout(error) {
    return error instanceof Error && error.name === "TimeoutError";
}

function ensureWaitUntil(waitUntil) {
    if (!waitUntil) {
        return null;
    }

    if (!ALLOWED_WAIT_UNTIL.has(waitUntil)) {
        throw browserError("INVALID_WAIT_UNTIL", `Unsupported waitUntil value '${waitUntil}'.`, {
            meta: {allowedValues: [...ALLOWED_WAIT_UNTIL]}
        });
    }

    return waitUntil;
}

function compareNumbers(left, operator, right) {
    switch (operator) {
        case "<=":
            return left <= right;
        case "<":
            return left < right;
        case ">=":
            return left >= right;
        case ">":
            return left > right;
        default:
            return false;
    }
}

function resolveOptionalObjectPreset(value, defaults = {}) {
    if (value === true) {
        return {...defaults};
    }

    if (value && typeof value === "object") {
        return {...defaults, ...value};
    }

    return null;
}

function pushFailedAssertion(failedAssertions, assertion) {
    failedAssertions.push(assertion);
}

async function waitForLocator(page, selector, timeoutMs, state = "attached") {
    const locator = page.locator(selector).first();

    try {
        await locator.waitFor({state, timeout: timeoutMs});
        return locator;
    } catch (error) {
        if (isPlaywrightTimeout(error)) {
            const url = page.url();
            if (isLoginUrl(url)) {
                throw browserError("REDIRECTED_TO_LOGIN", `Target selector '${selector}' was not found because the page redirected to login.`, {url});
            }
            throw browserError("TARGET_SELECTOR_TIMEOUT", `Timed out waiting for selector ${selector}`, {url});
        }

        throw error;
    }
}

async function waitForVisibleLocator(page, selector, timeoutMs) {
    return waitForLocator(page, selector, timeoutMs, "visible");
}

function toRect(rect) {
    return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left
    };
}

export function createPlaywrightService() {
    async function getViewportMetrics(session) {
        return session.page.evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight
        }));
    }

    async function navigate({session, url, waitUntil = "domcontentloaded"}) {
        ensureWaitUntil(waitUntil);

        const targetUrl = resolveUrl(session, url);
        await session.page.goto(targetUrl, {waitUntil});

        return {
            ok: true,
            url: session.page.url(),
            title: await session.page.title()
        };
    }

    async function waitFor({session, selector, state = "visible", waitUntil, timeoutMs, urlIncludes, urlMatches}) {
        const timeout = normalizeTimeout(timeoutMs);

        try {
            if (selector) {
                await session.page.waitForSelector(selector, {state, timeout});
                return {ok: true};
            }

            if (waitUntil) {
                ensureWaitUntil(waitUntil);
                await session.page.waitForLoadState(waitUntil, {timeout});
                return {ok: true};
            }

            if (urlIncludes) {
                await session.page.waitForURL((url) => url.toString().includes(urlIncludes), {timeout});
                return {ok: true};
            }

            if (urlMatches) {
                const matcher = new RegExp(urlMatches);
                await session.page.waitForURL((url) => matcher.test(url.toString()), {timeout});
                return {ok: true};
            }
        } catch (error) {
                    if (isPlaywrightTimeout(error)) {
                const currentUrl = session.page.url();
                if (selector && isLoginUrl(currentUrl)) {
                    throw browserError("REDIRECTED_TO_LOGIN", `Timed out waiting for selector ${selector}; current page redirected to login.`, {
                        url: currentUrl
                    });
                }

                throw browserError("WAIT_TIMEOUT", "Timed out waiting for the requested browser condition.", {
                    url: currentUrl
                });
            }

            throw error;
        }

        throw browserError("INVALID_WAIT_CONDITION", "Provide selector, waitUntil, urlIncludes, or urlMatches.");
    }

    async function screenshot({session, type, selector, path, timeoutMs}) {
        if (type === "fullPage") {
            await session.page.screenshot({path, fullPage: true});
            return {ok: true, path};
        }

        if (type !== "element") {
            throw browserError("INVALID_SCREENSHOT_TYPE", `Unsupported screenshot type '${type}'.`);
        }

        const locator = await waitForVisibleLocator(session.page, selector, normalizeTimeout(timeoutMs));
        await locator.screenshot({path});

        return {ok: true, path};
    }

    async function getBoundingRect({session, selector, timeoutMs}) {
        const locator = await waitForVisibleLocator(session.page, selector, normalizeTimeout(timeoutMs));
        const rect = await locator.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return {
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
                top: box.top,
                right: box.right,
                bottom: box.bottom,
                left: box.left
            };
        });

        return {
            ok: true,
            selector,
            rect: toRect(rect)
        };
    }

    async function getComputedStyles({session, selector, includeParents = false, stopAt, properties, timeoutMs}) {
        const locator = await waitForVisibleLocator(session.page, selector, normalizeTimeout(timeoutMs));
        const resolvedProperties = Array.isArray(properties) && properties.length > 0
            ? properties
            : DEFAULT_STYLE_PROPERTIES;

        const chain = await locator.evaluate((element, {includeParents: inspectParents, stopAt: stopSelector, properties: styleProperties}) => {
            function shouldStop(current) {
                if (!stopSelector) {
                    return false;
                }

                const normalizedStopSelector = String(stopSelector || "").trim().toLowerCase();
                if (!normalizedStopSelector) {
                    return false;
                }

                if (current.matches?.(stopSelector)) {
                    return true;
                }

                return current.tagName?.toLowerCase() === normalizedStopSelector;
            }

            function serializeNode(node) {
                const computedStyle = window.getComputedStyle(node);
                const computedStyles = Object.fromEntries(styleProperties.map((property) => [
                    property,
                    computedStyle.getPropertyValue(property)
                ]));

                return {
                    tag: node.tagName?.toLowerCase() || null,
                    id: node.id || null,
                    classes: typeof node.className === "string"
                        ? node.className.trim()
                        : Array.isArray(node.classList)
                            ? node.classList.join(" ")
                            : String(node.className || "").trim(),
                    computedStyles
                };
            }

            const nodes = [];
            let current = element;
            while (current) {
                nodes.push(serializeNode(current));
                if (!inspectParents || shouldStop(current)) {
                    break;
                }
                current = current.parentElement;
            }

            return nodes;
        }, {includeParents, stopAt, properties: resolvedProperties});

        return {
            ok: true,
            url: session.page.url(),
            selector,
            chain
        };
    }

    async function getText({session, selector, timeoutMs, trim = true}) {
        const locator = await waitForVisibleLocator(session.page, selector, normalizeTimeout(timeoutMs));
        const text = await locator.evaluate((element, shouldTrim) => {
            const raw = element.innerText ?? element.textContent ?? "";
            return shouldTrim ? String(raw).trim() : String(raw);
        }, trim);

        return {
            ok: true,
            url: session.page.url(),
            selector,
            text
        };
    }

    async function getAttribute({session, selector, name, timeoutMs}) {
        const locator = await waitForLocator(session.page, selector, normalizeTimeout(timeoutMs), "attached");
        const value = await locator.getAttribute(name);

        return {
            ok: true,
            url: session.page.url(),
            selector,
            name,
            present: value !== null,
            value
        };
    }

    async function saveStorageState({session}) {
        const storageState = await session.context.storageState();
        return {
            ok: true,
            url: session.page.url(),
            storageState,
            cookiesCount: Array.isArray(storageState.cookies) ? storageState.cookies.length : 0,
            originsCount: Array.isArray(storageState.origins) ? storageState.origins.length : 0
        };
    }

    async function loadStorageState({session, storageState}) {
        const normalizedStorageState = storageState && typeof storageState === "object"
            ? storageState
            : null;

        if (!normalizedStorageState) {
            throw browserError("INVALID_STORAGE_STATE", "browser_load_storage_state requires a valid Playwright storage state object.");
        }

        const existingState = await session.context.storageState();
        const targetOrigins = new Set(
            [
                ...(Array.isArray(existingState.origins) ? existingState.origins.map((entry) => entry.origin) : []),
                ...(Array.isArray(normalizedStorageState.origins) ? normalizedStorageState.origins.map((entry) => entry.origin) : [])
            ].filter(Boolean)
        );

        const localStorageByOrigin = new Map(
            (Array.isArray(normalizedStorageState.origins) ? normalizedStorageState.origins : []).map((entry) => [
                entry.origin,
                Array.isArray(entry.localStorage) ? entry.localStorage : []
            ])
        );

        await session.context.clearCookies();
        const tempPage = await session.context.newPage();
        tempPage.setDefaultNavigationTimeout(normalizeTimeout(undefined));
        tempPage.setDefaultTimeout(normalizeTimeout(undefined));

        try {
            for (const origin of targetOrigins) {
                await tempPage.goto(origin, {waitUntil: "domcontentloaded"});
                const items = localStorageByOrigin.get(origin) || [];
                await tempPage.evaluate((entries) => {
                    window.localStorage.clear();
                    for (const entry of entries) {
                        if (entry?.name) {
                            window.localStorage.setItem(entry.name, String(entry.value ?? ""));
                        }
                    }
                }, items);
            }

            if (Array.isArray(normalizedStorageState.cookies) && normalizedStorageState.cookies.length > 0) {
                await session.context.addCookies(normalizedStorageState.cookies);
            }
        } finally {
            await tempPage.close().catch(() => null);
        }

        session.consoleLogs.length = 0;
        session.networkErrors.length = 0;

        return {
            ok: true,
            url: session.page.url(),
            cookiesCount: Array.isArray(normalizedStorageState.cookies) ? normalizedStorageState.cookies.length : 0,
            originsCount: Array.isArray(normalizedStorageState.origins) ? normalizedStorageState.origins.length : 0,
            reusedSession: true
        };
    }

    async function click({session, selector, timeoutMs, waitUntil, button = "left", clickCount = 1}) {
        const timeout = normalizeTimeout(timeoutMs);
        const resolvedWaitUntil = ensureWaitUntil(waitUntil);
        const locator = await waitForVisibleLocator(session.page, selector, timeout);

        await locator.click({timeout, button, clickCount});

        if (resolvedWaitUntil) {
            await session.page.waitForLoadState(resolvedWaitUntil, {timeout});
        }

        return {
            ok: true,
            selector,
            url: session.page.url()
        };
    }

    async function fill({session, selector, value, timeoutMs}) {
        const timeout = normalizeTimeout(timeoutMs);
        const locator = await waitForVisibleLocator(session.page, selector, timeout);
        await locator.fill(String(value ?? ""), {timeout});

        return {
            ok: true,
            selector,
            url: session.page.url()
        };
    }

    async function press({session, key, selector, timeoutMs, waitUntil}) {
        const timeout = normalizeTimeout(timeoutMs);
        const resolvedWaitUntil = ensureWaitUntil(waitUntil);

        if (selector) {
            const locator = await waitForVisibleLocator(session.page, selector, timeout);
            await locator.press(key, {timeout});
        } else {
            await session.page.keyboard.press(key);
        }

        if (resolvedWaitUntil) {
            await session.page.waitForLoadState(resolvedWaitUntil, {timeout});
        }

        return {
            ok: true,
            key,
            selector: selector || null,
            url: session.page.url()
        };
    }

    async function evaluate({session, expression, arg, selector, timeoutMs}) {
        const timeout = normalizeTimeout(timeoutMs);
        let result;

        if (selector) {
            const locator = await waitForLocator(session.page, selector, timeout, "attached");
            result = await locator.evaluate((element, {expression: source, arg: value}) => {
                const evaluator = new Function("element", "arg", "window", "document", `"use strict"; return (${source});`);
                return evaluator(element, value, window, document);
            }, {expression, arg});
        } else {
            result = await session.page.evaluate(({expression: source, arg: value}) => {
                const evaluator = new Function("arg", "window", "document", `"use strict"; return (${source});`);
                return evaluator(value, window, document);
            }, {expression, arg});
        }

        return {
            ok: true,
            url: session.page.url(),
            result
        };
    }

    async function assertLayout({session, selector, assertions, presets, timeoutMs}) {
        const normalizedAssertions = assertions && typeof assertions === "object"
            ? Object.entries(assertions).filter(([, value]) => value !== undefined && value !== null)
            : [];
        const normalizedPresets = presets && typeof presets === "object" ? presets : {};

        if (normalizedAssertions.length === 0 && Object.keys(normalizedPresets).length === 0) {
            throw browserError("INVALID_LAYOUT_ASSERTIONS", "Provide at least one browser_assert_layout assertion or preset.");
        }

        const {rect} = await getBoundingRect({session, selector, timeoutMs});
        const failedAssertions = [];
        const presetResults = [];
        const relatedRects = {};

        for (const [assertionName, expected] of normalizedAssertions) {
            const spec = LAYOUT_ASSERTION_SPECS[assertionName];
            if (!spec) {
                throw browserError("INVALID_LAYOUT_ASSERTION", `Unsupported layout assertion '${assertionName}'.`, {
                    meta: {supportedAssertions: Object.keys(LAYOUT_ASSERTION_SPECS).sort((left, right) => left.localeCompare(right))}
                });
            }

            const actual = rect[spec.field];
            const passed = compareNumbers(actual, spec.operator, Number(expected));
            if (!passed) {
                pushFailedAssertion(failedAssertions, {
                    name: assertionName,
                    expected,
                    actual,
                    operator: spec.operator,
                    field: spec.field
                });
            }
        }

        const nearTopPreset = resolveOptionalObjectPreset(normalizedPresets.nearTop, {maxTop: 80});
        if (nearTopPreset) {
            const checks = [];
            if (nearTopPreset.maxTop !== undefined) {
                checks.push({field: "top", operator: "<=", expected: Number(nearTopPreset.maxTop), actual: rect.top, name: "nearTop.maxTop"});
            }
            if (nearTopPreset.minTop !== undefined) {
                checks.push({field: "top", operator: ">=", expected: Number(nearTopPreset.minTop), actual: rect.top, name: "nearTop.minTop"});
            }

            const presetPassed = checks.every((check) => compareNumbers(check.actual, check.operator, check.expected));
            presetResults.push({name: "nearTop", passed: presetPassed, config: nearTopPreset});

            for (const check of checks) {
                if (!compareNumbers(check.actual, check.operator, check.expected)) {
                    pushFailedAssertion(failedAssertions, check);
                }
            }
        }

        const withinViewportPreset = resolveOptionalObjectPreset(normalizedPresets.withinViewport, {padding: 0});
        let viewport = null;
        if (withinViewportPreset) {
            viewport = await getViewportMetrics(session);
            const padding = Number(withinViewportPreset.padding || 0);
            const checks = [
                {name: "withinViewport.top", field: "top", operator: ">=", expected: padding, actual: rect.top},
                {name: "withinViewport.left", field: "left", operator: ">=", expected: padding, actual: rect.left},
                {name: "withinViewport.right", field: "right", operator: "<=", expected: viewport.width - padding, actual: rect.right},
                {name: "withinViewport.bottom", field: "bottom", operator: "<=", expected: viewport.height - padding, actual: rect.bottom}
            ];
            const presetPassed = checks.every((check) => compareNumbers(check.actual, check.operator, check.expected));
            presetResults.push({name: "withinViewport", passed: presetPassed, config: withinViewportPreset});

            for (const check of checks) {
                if (!compareNumbers(check.actual, check.operator, check.expected)) {
                    pushFailedAssertion(failedAssertions, check);
                }
            }
        }

        const sidebarPreset = normalizedPresets.sidebarDoesNotPushContentDown;
        if (sidebarPreset && typeof sidebarPreset === "object") {
            const sidebarSelector = String(sidebarPreset.sidebarSelector || "").trim();
            if (!sidebarSelector) {
                throw browserError("INVALID_LAYOUT_PRESET", "sidebarDoesNotPushContentDown requires sidebarSelector.");
            }

            const sidebarRectPayload = await getBoundingRect({session, selector: sidebarSelector, timeoutMs});
            relatedRects.sidebar = {
                selector: sidebarSelector,
                rect: sidebarRectPayload.rect
            };
            const maxTopDifference = Number(sidebarPreset.maxTopDifference ?? 24);
            const expected = sidebarRectPayload.rect.top + maxTopDifference;
            const presetPassed = rect.top <= expected;
            presetResults.push({
                name: "sidebarDoesNotPushContentDown",
                passed: presetPassed,
                config: {
                    sidebarSelector,
                    maxTopDifference
                }
            });

            if (!presetPassed) {
                pushFailedAssertion(failedAssertions, {
                    name: "sidebarDoesNotPushContentDown",
                    field: "top",
                    operator: "<=",
                    expected,
                    actual: rect.top,
                    relatedSelector: sidebarSelector,
                    relatedActual: sidebarRectPayload.rect.top
                });
            }
        }

        return {
            ok: true,
            url: session.page.url(),
            selector,
            passed: failedAssertions.length === 0,
            actual: rect,
            viewport,
            presetResults,
            relatedRects,
            failedAssertions
        };
    }

    return {
        navigate,
        waitFor,
        screenshot,
        getBoundingRect,
        getComputedStyles,
        getText,
        getAttribute,
        saveStorageState,
        loadStorageState,
        click,
        fill,
        press,
        evaluate,
        assertLayout,
        defaultStyleProperties: DEFAULT_STYLE_PROPERTIES
    };
}

