import type { OpenCodeClient } from "./types.js"
import type { Logger } from "./logger.js"

export async function isSubagentSession(
    client: OpenCodeClient,
    sessionID: string,
    logger: Logger
): Promise<boolean> {
    try {
        const result = await client.session.get({ path: { id: sessionID } })

        if (result.data?.parentID) {
            logger.debug("subagent-check", "Detected subagent session, skipping title generation", {
                sessionID,
                parentID: result.data.parentID
            })
            return true
        }

        return false
    } catch (error: any) {
        logger.error("subagent-check", "Failed to check if session is subagent", {
            sessionID,
            error: error.message
        })
        return false
    }
}

export const sessionIdleCount = new Map<string, number>()
