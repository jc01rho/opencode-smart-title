import type { OpenCodeClient } from "./types.js"
import type { Logger } from "./logger.js"

const subagentSessionCache = new Map<string, boolean>()
const subagentSessionChecksInFlight = new Map<string, Promise<boolean>>()
const sessionRootCache = new Map<string, string>()
const sessionRootChecksInFlight = new Map<string, Promise<string>>()

async function resolveSessionRoot(
    client: OpenCodeClient,
    sessionID: string,
    logger: Logger
): Promise<string> {
    const cachedRoot = sessionRootCache.get(sessionID)

    if (cachedRoot) {
        return cachedRoot
    }

    const existingCheck = sessionRootChecksInFlight.get(sessionID)

    if (existingCheck) {
        return await existingCheck
    }

    const checkPromise = (async () => {
        const lineage: string[] = []
        const seen = new Set<string>()
        let currentSessionID = sessionID

        while (true) {
            const cached = sessionRootCache.get(currentSessionID)

            if (cached) {
                for (const lineageSessionID of lineage) {
                    sessionRootCache.set(lineageSessionID, cached)
                    subagentSessionCache.set(lineageSessionID, lineageSessionID !== cached)
                }

                return cached
            }

            if (seen.has(currentSessionID)) {
                logger.warn("subagent-check", "Detected cyclic parent session chain while resolving root session", {
                    sessionID,
                    currentSessionID
                })

                for (const lineageSessionID of lineage) {
                    sessionRootCache.set(lineageSessionID, sessionID)
                    subagentSessionCache.set(lineageSessionID, lineageSessionID !== sessionID)
                }

                sessionRootCache.set(sessionID, sessionID)
                subagentSessionCache.set(sessionID, false)
                return sessionID
            }

            seen.add(currentSessionID)
            lineage.push(currentSessionID)

            const result = await client.session.get({ path: { id: currentSessionID } })
            const parentID = typeof result.data?.parentID === "string" ? result.data.parentID : undefined

            if (!parentID) {
                for (const lineageSessionID of lineage) {
                    sessionRootCache.set(lineageSessionID, currentSessionID)
                    subagentSessionCache.set(lineageSessionID, lineageSessionID !== currentSessionID)
                }

                return currentSessionID
            }

            currentSessionID = parentID
        }
    })()

    sessionRootChecksInFlight.set(sessionID, checkPromise)

    try {
        return await checkPromise
    } finally {
        sessionRootChecksInFlight.delete(sessionID)
    }
}

export async function getRootSessionID(
    client: OpenCodeClient,
    sessionID: string,
    logger: Logger
): Promise<string> {
    try {
        return await resolveSessionRoot(client, sessionID, logger)
    } catch (error: any) {
        logger.error("subagent-check", "Failed to resolve root session", {
            sessionID,
            error: error.message
        })
        return sessionID
    }
}

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
            const rootSessionID = await resolveSessionRoot(client, sessionID, logger)
            const isSubagent = rootSessionID !== sessionID

            subagentSessionCache.set(sessionID, isSubagent)

            if (isSubagent) {
                logger.debug("subagent-check", "Detected subagent session, skipping title generation", {
                    sessionID,
                    rootSessionID
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
