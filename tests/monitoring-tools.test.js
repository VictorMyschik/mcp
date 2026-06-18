import test from "node:test";
import assert from "node:assert/strict";
import {existsSync, mkdtempSync, mkdirSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";

import {getConfigFromEnv} from "../src/config/env.js";
import {resolveOutventoRoot} from "../src/services/monitoring/resolve-outvento-root.js";
import {resolveMonitoringPaths} from "../src/services/monitoring/latency-report-service.js";

test("resolveOutventoRoot finds repo when OUTVENTO_ROOT is set", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "outvento-root-"));
    mkdirSync(path.join(tempRoot, "scripts"), {recursive: true});
    writeFileSync(path.join(tempRoot, "scripts", "latency_report.sh"), "#!/usr/bin/env bash\n");

    assert.equal(resolveOutventoRoot({OUTVENTO_ROOT: tempRoot}), tempRoot);
});

test("monitoring tools enabled when outvento root and ssh key exist", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "outvento-root-"));
    mkdirSync(path.join(tempRoot, "scripts"), {recursive: true});
    writeFileSync(path.join(tempRoot, "scripts", "latency_report.sh"), "#!/usr/bin/env bash\n");

    const sshDir = mkdtempSync(path.join(os.tmpdir(), "ssh-key-"));
    const sshKey = path.join(sshDir, "outvento_server");
    writeFileSync(sshKey, "dummy-key");

    const config = getConfigFromEnv({
        OUTVENTO_ROOT: tempRoot,
        MONITORING_SSH_KEY: sshKey,
        DB_HOST: "localhost",
        DB_PORT: "5432",
        DB_USER: "user",
        DB_PASSWORD: "secret",
        DB_NAME: "app",
        SWAGGER_URL: "http://localhost/docs.json"
    });

    assert.equal(config.tools.monitoring.enabled, true);
    assert.equal(config.monitoring.outventoRoot, tempRoot);
    assert.equal(config.monitoring.sshKeyPath, sshKey);
});

test("resolveMonitoringPaths expands home directory", () => {
    const paths = resolveMonitoringPaths({MONITORING_SSH_KEY: "~/.ssh/outvento_server"});
    assert.equal(paths.sshKeyPath, path.join(os.homedir(), ".ssh/outvento_server"));
});

test("monitoring disabled when ssh key is missing", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "outvento-root-"));
    mkdirSync(path.join(tempRoot, "scripts"), {recursive: true});
    writeFileSync(path.join(tempRoot, "scripts", "latency_report.sh"), "#!/usr/bin/env bash\n");

    const config = getConfigFromEnv({
        OUTVENTO_ROOT: tempRoot,
        MONITORING_SSH_KEY: path.join(tempRoot, "missing-key"),
        DB_HOST: "localhost",
        DB_PORT: "5432",
        DB_USER: "user",
        DB_PASSWORD: "secret",
        DB_NAME: "app",
        SWAGGER_URL: "http://localhost/docs.json"
    });

    assert.equal(config.tools.monitoring.enabled, false);
    assert.equal(config.tools.monitoring.disabledReason, "ssh_key_not_found");
    assert.equal(existsSync(config.monitoring.sshKeyPath), false);
});
