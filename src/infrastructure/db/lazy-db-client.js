import {createDbClient} from "./client.js";

const DEFAULT_CONNECT_RETRIES = 3;
const DEFAULT_CONNECT_RETRY_DELAY_MS = 1000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createLazyDbClient(dbConfig, {
    maxRetries = DEFAULT_CONNECT_RETRIES,
    retryDelayMs = DEFAULT_CONNECT_RETRY_DELAY_MS
} = {}) {
    let client = null;
    let connectPromise = null;
    let lastConnectError = null;

    async function connectWithRetry() {
        let attempt = 0;
        let lastError = null;

        while (attempt < maxRetries) {
            attempt += 1;

            const candidate = createDbClient(dbConfig);

            try {
                await candidate.connect();
                client = candidate;
                lastConnectError = null;
                return client;
            } catch (error) {
                lastError = error;
                lastConnectError = error instanceof Error ? error.message : String(error);

                try {
                    await candidate.end();
                } catch {
                    // ignore cleanup errors between retries
                }

                if (attempt < maxRetries) {
                    await sleep(retryDelayMs);
                }
            }
        }

        connectPromise = null;
        throw lastError;
    }

    async function ensureConnected() {
        if (client) {
            return client;
        }

        if (!connectPromise) {
            connectPromise = connectWithRetry();
        }

        return connectPromise;
    }

    return {
        async query(text, params) {
            const activeClient = await ensureConnected();
            return activeClient.query(text, params);
        },
        async connect() {
            return ensureConnected();
        },
        async end() {
            if (!client) {
                return;
            }

            await client.end();
            client = null;
            connectPromise = null;
        },
        get isConnected() {
            return Boolean(client);
        },
        get lastConnectError() {
            return lastConnectError;
        }
    };
}
