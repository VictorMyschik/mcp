import * as z from "zod/v4";

import {prepareFixtureImage, resolveQaArtifactsDir} from "../services/qa/fixture-image.js";
import {asToolResult} from "./tool-result.js";

const VERIFICATION_CODE_QUERY = `
    SELECT nc.code,
           nc.address,
           nc.type,
           nc.created_at,
           u.id AS user_id,
           u.email_verified_at IS NOT NULL AS verified
    FROM notification_codes nc
    JOIN users u ON u.id = nc.user_id
    WHERE nc.address = $1
    ORDER BY nc.created_at DESC
    LIMIT 1
`;

export function registerQaTools(server, {
    dbClient,
    browserConfig
}) {
    const qaArtifactsDir = resolveQaArtifactsDir(browserConfig);
    const registeredToolNames = [];

    if (dbClient) {
        server.registerTool(
            "qa_get_verification_code",
            {
                description: "Return the latest email verification code for a registered user (read-only SQL helper for QA flows).",
                inputSchema: {
                    email: z.string().email()
                }
            },
            async ({email}) => {
                const result = await dbClient.query(VERIFICATION_CODE_QUERY, [email]);
                const row = result.rows[0] || null;

                return asToolResult({
                    found: Boolean(row),
                    email,
                    code: row?.code ?? null,
                    userId: row?.user_id ?? null,
                    verified: row?.verified ?? null,
                    type: row?.type ?? null,
                    createdAt: row?.created_at ?? null
                });
            }
        );

        server.registerTool(
            "qa_list_recent_users",
            {
                description: "List recently created users matching an email prefix (read-only SQL helper for QA cleanup/review).",
                inputSchema: {
                    emailPrefix: z.string().min(1).default("qa-browser-"),
                    limit: z.number().int().positive().max(50).default(20)
                }
            },
            async ({emailPrefix, limit}) => {
                const result = await dbClient.query(
                    `
                        SELECT id, email, name, email_verified_at IS NOT NULL AS verified, created_at
                        FROM users
                        WHERE email LIKE $1
                        ORDER BY id DESC
                        LIMIT $2
                    `,
                    [`${emailPrefix}%`, limit]
                );

                return asToolResult({
                    emailPrefix,
                    count: result.rows.length,
                    users: result.rows
                });
            }
        );

        registeredToolNames.push("qa_get_verification_code", "qa_list_recent_users");
    }

    server.registerTool(
        "qa_prepare_fixture_image",
        {
            description: "Create a local JPEG test image for browser file uploads during QA runs.",
            inputSchema: {
                fileName: z.string().min(1).optional(),
                variant: z.string().min(1).optional()
            }
        },
        async ({fileName, variant}) => {
            const fixture = await prepareFixtureImage({
                artifactsDir: qaArtifactsDir,
                fileName,
                variant
            });

            return asToolResult({
                ok: true,
                ...fixture,
                artifactsDir: qaArtifactsDir
            });
        }
    );

    registeredToolNames.push("qa_prepare_fixture_image");

    return {registeredToolNames};
}
