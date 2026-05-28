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
import type { Message, SessionListItem } from "./lib/types.js"
import { join } from "path"
import { homedir } from "os"

const SUBAGENT_ACTIVITY_TTL_MS = 5 * 60 * 1000
const IDLE_DEBOUNCE_MS = 5000

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
    const pendingIdleTimers = new Map<string, NodeJS.Timeout>()
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

    const cancelPendingIdleTimer = (rootSessionId: string) => {
        const timer = pendingIdleTimers.get(rootSessionId)
        if (timer) {
            clearTimeout(timer)
            pendingIdleTimers.delete(rootSessionId)
            logger.debug("terminal-title", "Cancelled pending idle timer due to running event", {
                rootSessionId
            })
        }
    }

    const syncTerminalStatus = async (sessionId: string | undefined, status: Extract<TerminalStatus, "idle" | "running">) => {
        if (!sessionId) {
            return
        }

        const isSubagent = await isSubagentSession(client, sessionId, logger)
        const rootSessionId = isSubagent
            ? await getRootSessionID(client, sessionId, logger)
            : sessionId

        if (status === "running") {
            cancelPendingIdleTimer(rootSessionId)
        }

        if (isSubagent) {
            if (status === "running") {
                markSubagentActivity(rootSessionId, sessionId, true)
            }
            // Don't remove on idle — subagents toggle idle/running frequently
            // during tool execution. Removal happens via session.deleted or TTL expiry.
        } else {
            rootSessionStatuses.set(rootSessionId, status)
        }

        if (status === "idle") {
            if (isSubagent) {
                const effectiveStatus = getEffectiveTerminalStatus(rootSessionId)

                if (
                    lastTerminalStatusSync?.rootSessionId === rootSessionId &&
                    lastTerminalStatusSync.status === effectiveStatus
                ) {
                    return
                }

                updateTerminalTitle(ctx.directory, effectiveStatus, logger)
                lastTerminalStatusSync = { rootSessionId, status: effectiveStatus }

                logger.debug("terminal-title", "Subagent idle, recalculated effective terminal status", {
                    sessionId,
                    rootSessionId,
                    effectiveStatus,
                    activeSubagentCount: activeSubagentsByRoot.get(rootSessionId)?.size ?? 0,
                    rootStatus: rootSessionStatuses.get(rootSessionId) ?? "idle"
                })
                return
            }

            if (pendingIdleTimers.has(rootSessionId)) {
                return
            }

            const timer = setTimeout(async () => {
                pendingIdleTimers.delete(rootSessionId)

                // Check active subagents FIRST — query session.list to avoid event race conditions
                pruneExpiredSubagentActivity(rootSessionId)
                const cachedSubagents = activeSubagentsByRoot.get(rootSessionId)

                // Verify active subagents via SDK in case event-based tracking missed them
                let hasActiveSubagents = cachedSubagents && cachedSubagents.size > 0
                if (!hasActiveSubagents) {
                    try {
                        const { data: sessions } = await (client as any).session.list({
                            query: { roots: false }
                        })
                        const now = Date.now()
                        hasActiveSubagents = sessions.some((s: SessionListItem) =>
                            s.parentID === rootSessionId &&
                            now - s.time.updated < SUBAGENT_ACTIVITY_TTL_MS
                        )
                    } catch {
                        // Ignore errors - fall back to cached state
                    }
                }

                if (hasActiveSubagents) {
                    // Also update event-based tracking for future lookups
                    if (!cachedSubagents || cachedSubagents.size === 0) {
                        getActiveSubagentMap(rootSessionId).set("__sdk_placeholder__", Date.now())
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
                    logger.debug("terminal-title", "Debounced idle skipped: active subagents present", {
                        rootSessionId,
                        hasActiveSubagents
                    })
                    return
                }

                try {
                    const { data: messages } = await client.session.messages({
                        path: { id: rootSessionId }
                    })

                    const lastAssistantMsg = (messages as Message[])
                        .filter(m => m.info.role === "assistant")
                        .at(-1)

                    if (lastAssistantMsg) {
                        const text = lastAssistantMsg.parts
                            .filter(p => p.type === "text")
                            .map(p => p.text ?? "")
                            .join("")

                        if (/<think/i.test(text) && !/<\/think>/i.test(text)) {
                            rootSessionStatuses.set(rootSessionId, "running")
                            updateTerminalTitle(ctx.directory, "thinking", logger)
                            lastTerminalStatusSync = { rootSessionId, status: "thinking" }

                            logger.debug("terminal-title", "Thinking still in progress, using thinking status", {
                                rootSessionId
                            })
                            return
                        }
                    }

                    // Check for running tool parts (background bash tasks etc.)
                    const hasRunningToolParts = (messages as Message[]).some(msg =>
                        msg.parts.some(p => p.state?.status === "running")
                    )

                    if (hasRunningToolParts) {
                        rootSessionStatuses.set(rootSessionId, "running")
                        updateTerminalTitle(ctx.directory, "running", logger)
                        lastTerminalStatusSync = { rootSessionId, status: "running" }

                        logger.debug("terminal-title", "Tool parts still running, keeping running status", {
                            rootSessionId
                        })
                        return
                    }
                } catch {
                    // Ignore errors checking thinking state
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

                logger.debug("terminal-title", "Debounced idle sync applied", {
                    rootSessionId,
                    effectiveStatus
                })
            }, IDLE_DEBOUNCE_MS)

            pendingIdleTimers.set(rootSessionId, timer)
            return
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
        },
        "tool.execute.after": async ({ sessionID }) => {
            // No-op: idle debounce timer checks running tool parts directly
        }
    }
}

export default SmartTitlePlugin
