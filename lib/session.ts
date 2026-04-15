import type { OpenCodeClient } from "./types.js"
import type { Logger } from "./logger.js"

const subagentSessionCache = new Map<string, boolean>()
const subagentSessionChecksInFlight = new Map<string, Promise<boolean>>()

export async function isSubagentSession(
    client: OpenCodeClient,
    sessionID: string,
    logger: Logger
): Promise<boolean> {
    try {
        const cached = subagentSessionCache.get(sessionID)

        if (typeof cached === "boolean") {
            return cached
        }

        const existingCheck = subagentSessionChecksInFlight.get(sessionID)

        if (existingCheck) {
            return await existingCheck
        }

        const checkPromise = (async () => {
            const result = await client.session.get({ path: { id: sessionID } })
            const isSubagent = Boolean(result.data?.parentID)

            subagentSessionCache.set(sessionID, isSubagent)

            if (isSubagent) {
                logger.debug("subagent-check", "Detected subagent session, skipping title generation", {
                    sessionID,
                    parentID: result.data.parentID
                })
            }

            return isSubagent
        })()

        subagentSessionChecksInFlight.set(sessionID, checkPromise)

        const isSubagent = await checkPromise
        subagentSessionChecksInFlight.delete(sessionID)

        if (isSubagent) {
            return true
        }

        return false
    } catch (error: any) {
        subagentSessionChecksInFlight.delete(sessionID)
        logger.error("subagent-check", "Failed to check if session is subagent", {
            sessionID,
            error: error.message
        })
        return false
    }
}

export const sessionIdleCount = new Map<string, number>()
