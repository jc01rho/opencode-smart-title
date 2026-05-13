/**
 * Smart Title Plugin for OpenCode
 * 
 * Automatically generates meaningful session titles based on conversation content.
 * Uses OpenCode auth provider for unified authentication across all AI providers.
 * 
 * Configuration: ~/.config/opencode/smart-title.jsonc
 * Logs: ~/.config/opencode/logs/smart-title/YYYY-MM-DD.log
 * 
 * NOTE: ai package is lazily imported to avoid loading the 2.8MB package during
 * plugin initialization. The package is only loaded when title generation is needed.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config.js"
import { Logger } from "./lib/logger.js"
import { updateSessionTitle, updateTerminalTitle, type TerminalStatus } from "./lib/title.js"
import { getRootSessionID, isSubagentSession, sessionIdleCount } from "./lib/session.js"
import { join } from "path"
import { homedir } from "os"

const SUBAGENT_ACTIVITY_TTL_MS = 5 * 60 * 1000

const SmartTitlePlugin: Plugin = async (ctx) => {
    const config = getConfig(ctx)

    if (!config.enabled) {
        return {}
    }

    const logger = new Logger(config.debug)
    const { client } = ctx
    let lastTerminalStatusSync: { rootSessionId: string; status: TerminalStatus } | null = null
    const rootSessionStatuses = new Map<string, Extract<TerminalStatus, "idle" | "running">>()
    const activeSubagentsByRoot = new Map<string, Map<string, number>>()
    const getEventSessionId = (event: { properties: unknown }): string | undefined => {
        if (!event.properties || typeof event.properties !== "object") {
            return undefined
        }

        if (!("sessionID" in event.properties)) {
            if (!("info" in event.properties) || !event.properties.info || typeof event.properties.info !== "object") {
                return undefined
            }

            const { id } = event.properties.info as { id?: unknown }
            return typeof id === "string" ? id : undefined
        }

        const { sessionID } = event.properties
        return typeof sessionID === "string" ? sessionID : undefined
    }

    const getActiveSubagentMap = (rootSessionId: string): Map<string, number> => {
        let activeSubagents = activeSubagentsByRoot.get(rootSessionId)

        if (!activeSubagents) {
            activeSubagents = new Map<string, number>()
            activeSubagentsByRoot.set(rootSessionId, activeSubagents)
        }

        return activeSubagents
    }

    const pruneExpiredSubagentActivity = (rootSessionId: string) => {
        const activeSubagents = activeSubagentsByRoot.get(rootSessionId)

        if (!activeSubagents) {
            return
        }

        const now = Date.now()

        for (const [subagentSessionId, lastSeenActiveAt] of activeSubagents.entries()) {
            if (now - lastSeenActiveAt > SUBAGENT_ACTIVITY_TTL_MS) {
                activeSubagents.delete(subagentSessionId)
                logger.debug("terminal-title", "Pruned stale subagent activity from terminal state", {
                    rootSessionId,
                    subagentSessionId,
                    ttlMs: SUBAGENT_ACTIVITY_TTL_MS
                })
            }
        }

        if (activeSubagents.size === 0) {
            activeSubagentsByRoot.delete(rootSessionId)
        }
    }

    const markSubagentActivity = (rootSessionId: string, sessionId: string, isActive: boolean) => {
        const activeSubagents = getActiveSubagentMap(rootSessionId)

        if (isActive) {
            activeSubagents.set(sessionId, Date.now())
            return
        }

        activeSubagents.delete(sessionId)

        if (activeSubagents.size === 0) {
            activeSubagentsByRoot.delete(rootSessionId)
        }
    }

    const getEffectiveTerminalStatus = (rootSessionId: string): TerminalStatus => {
        pruneExpiredSubagentActivity(rootSessionId)

        if (rootSessionStatuses.get(rootSessionId) === "running") {
            return "running"
        }

        const activeSubagents = activeSubagentsByRoot.get(rootSessionId)

        if (activeSubagents && activeSubagents.size > 0) {
            return "subagent"
        }

        return "idle"
    }

    const syncTerminalStatus = async (sessionId: string | undefined, status: Extract<TerminalStatus, "idle" | "running">) => {
        if (!sessionId) {
            return
        }

        const isSubagent = await isSubagentSession(client, sessionId, logger)
        const rootSessionId = isSubagent
            ? await getRootSessionID(client, sessionId, logger)
            : sessionId

        if (isSubagent) {
            if (status === "running") {
                markSubagentActivity(rootSessionId, sessionId, true)
            }
        } else {
            rootSessionStatuses.set(rootSessionId, status)
        }

        const effectiveStatus = getEffectiveTerminalStatus(rootSessionId)

        if (
            lastTerminalStatusSync?.rootSessionId === rootSessionId &&
            lastTerminalStatusSync.status === effectiveStatus
        ) {
            return
        }

        updateTerminalTitle(ctx.directory, effectiveStatus, logger)
        lastTerminalStatusSync = { rootSessionId, status: effectiveStatus }

        logger.debug("terminal-title", "Synchronized effective terminal status", {
            sessionId,
            rootSessionId,
            isSubagent,
            requestedStatus: status,
            effectiveStatus,
            activeSubagentCount: activeSubagentsByRoot.get(rootSessionId)?.size ?? 0,
            rootStatus: rootSessionStatuses.get(rootSessionId) ?? "idle"
        })
    }

    const clearSubagentActivity = async (sessionId: string | undefined) => {
        if (!sessionId) {
            return
        }

        const isSubagent = await isSubagentSession(client, sessionId, logger)

        if (!isSubagent) {
            return
        }

        const rootSessionId = await getRootSessionID(client, sessionId, logger)
        markSubagentActivity(rootSessionId, sessionId, false)

        const effectiveStatus = getEffectiveTerminalStatus(rootSessionId)

        if (
            lastTerminalStatusSync?.rootSessionId === rootSessionId &&
            lastTerminalStatusSync.status === effectiveStatus
        ) {
            return
        }

        updateTerminalTitle(ctx.directory, effectiveStatus, logger)
        lastTerminalStatusSync = { rootSessionId, status: effectiveStatus }

        logger.debug("terminal-title", "Cleared subagent activity from terminal state", {
            sessionId,
            rootSessionId,
            effectiveStatus,
            activeSubagentCount: activeSubagentsByRoot.get(rootSessionId)?.size ?? 0,
            rootStatus: rootSessionStatuses.get(rootSessionId) ?? "idle"
        })
    }

    logger.info('plugin', 'Smart Title plugin initialized', {
        enabled: config.enabled,
        debug: config.debug,
        model: config.model,
        updateThreshold: config.updateThreshold,
        globalConfigFile: join(homedir(), ".config", "opencode", "smart-title.jsonc"),
        projectConfigFile: ctx.directory ? join(ctx.directory, ".opencode", "smart-title.jsonc") : "N/A",
        logDirectory: join(homedir(), ".config", "opencode", "logs", "smart-title")
    })

    return {
        event: async ({ event }) => {
            const sessionId = getEventSessionId(event)

            if (event.type === "session.deleted") {
                await clearSubagentActivity(sessionId)
                return
            }

            const isLegacyIdleEvent =
                event.type === "session.status" &&
                event.properties.status?.type === "idle"
            const isIdleEvent = event.type === "session.idle" || isLegacyIdleEvent

            if (isIdleEvent) {
                await syncTerminalStatus(sessionId, "idle")
            } else if (event.type === "session.status") {
                await syncTerminalStatus(sessionId, "running")
            }

            if (isIdleEvent) {
                logger.debug('event', 'Session became idle', { sessionId })

                if (!sessionId) {
                    logger.debug('event', 'Skipping idle handling because session ID is unavailable', {
                        eventType: event.type
                    })
                    return
                }

                if (await isSubagentSession(client, sessionId, logger)) {
                    logger.debug('event', 'Skipping AI title generation for subagent idle event', {
                        sessionId
                    })
                    return
                }

                const currentCount = (sessionIdleCount.get(sessionId) || 0) + 1
                sessionIdleCount.set(sessionId, currentCount)

                logger.debug('event', 'Idle count updated', {
                    sessionId,
                    currentCount,
                    threshold: config.updateThreshold
                })

                if (currentCount % config.updateThreshold !== 0) {
                    logger.debug('event', 'Threshold not reached, skipping title update', {
                        sessionId,
                        currentCount,
                        threshold: config.updateThreshold
                    })
                    return
                }

                logger.info('event', 'Threshold reached, triggering title update for idle session', {
                    sessionId,
                    currentCount,
                    threshold: config.updateThreshold
                })

                updateSessionTitle(client, sessionId, logger, config).catch((error) => {
                    logger.error('event', 'Title update failed', {
                        sessionId,
                        error: error.message,
                        stack: error.stack
                    })
                })
            }
        },
        "chat.message": async ({ sessionID }) => {
            await syncTerminalStatus(sessionID, "running")
        },
        "command.execute.before": async ({ sessionID }) => {
            await syncTerminalStatus(sessionID, "running")
        },
        "tool.execute.before": async ({ sessionID }) => {
            await syncTerminalStatus(sessionID, "running")
        }
    }
}

export default SmartTitlePlugin
