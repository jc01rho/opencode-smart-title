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
import { updateSessionTitle } from "./lib/title.js"
import { isSubagentSession, sessionIdleCount } from "./lib/session.js"
import { join } from "path"
import { homedir } from "os"

const SmartTitlePlugin: Plugin = async (ctx) => {
    const config = getConfig(ctx)

    if (!config.enabled) {
        return {}
    }

    const logger = new Logger(config.debug)
    const { client } = ctx

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
            const isLegacyIdleEvent =
                event.type === "session.status" &&
                event.properties.status?.type === "idle"
            const isIdleEvent = event.type === "session.idle" || isLegacyIdleEvent

            if (isIdleEvent) {
                const sessionId = event.properties.sessionID

                logger.debug('event', 'Session became idle', { sessionId })

                if (await isSubagentSession(client, sessionId, logger)) {
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
        }
    }
}

export default SmartTitlePlugin
