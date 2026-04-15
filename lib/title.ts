import type { OpenCodeClient } from "./types.js"
import type { Logger } from "./logger.js"
import type { PluginConfig } from "./config.js"
import { extractSmartContext, formatContextForTitle, truncate } from "./context.js"
import { selectModel } from "./model-selector.js"
import { TITLE_PROMPT } from "../prompt.js"
import { basename } from "path"

export type TerminalStatus = "idle" | "running"

let lastTerminalTitle: string | null = null
const inFlightSessionTitleUpdates = new Set<string>()
const queuedSessionTitleUpdates = new Set<string>()

type TerminalWriter = Pick<NodeJS.WriteStream, "write"> & {
    isTTY?: boolean
}

function sanitizeTerminalTitle(value: string): string {
    return value
        .replace(/[\u0007\u001b]/g, "")
        .replace(/[\r\n]+/g, " ")
        .trim()
}

function formatTerminalTitle(directory: string | undefined, status: TerminalStatus): string {
    const projectName = directory ? basename(directory) || "opencode" : "opencode"
    const decoratedStatus = status === "running" ? "🟢" : "💤"
    return sanitizeTerminalTitle(`${decoratedStatus} ${projectName}`)
}

function getTerminalWriter(): TerminalWriter | null {
    if (process.stdout.isTTY) {
        return process.stdout
    }

    if (process.stderr.isTTY) {
        return process.stderr
    }

    return null
}

function wrapOscSequenceForTerminal(sequence: string): string {
    const term = process.env.TERM ?? ""
    const tmux = process.env.TMUX
    const isScreenLike = term.startsWith("screen") || term.startsWith("tmux")

    if (!tmux && !isScreenLike) {
        return sequence
    }

    return `\u001bPtmux;${sequence.replace(/\u001b/g, "\u001b\u001b")}\u001b\\`
}

export function updateTerminalTitle(
    directory: string | undefined,
    status: TerminalStatus,
    logger: Logger
): void {
    try {
        const writer = getTerminalWriter()

        if (!writer) {
            logger.debug("terminal-title", "Skipping terminal title update because no TTY writer is available", {
                status
            })
            return
        }

        const title = formatTerminalTitle(directory, status)

        if (!title || title === lastTerminalTitle) {
            return
        }

        const osc0 = wrapOscSequenceForTerminal(`\u001b]0;${title}\u0007`)
        const osc2 = wrapOscSequenceForTerminal(`\u001b]2;${title}\u0007`)

        writer.write(osc0)
        writer.write(osc2)
        lastTerminalTitle = title

        logger.debug("terminal-title", "Terminal title updated", {
            title,
            status,
            writer: writer === process.stdout ? "stdout" : "stderr",
            tmux: Boolean(process.env.TMUX)
        })
    } catch (error: any) {
        logger.warn("terminal-title", "Failed to update terminal title", {
            status,
            error: error?.message ?? String(error)
        })
    }
}

export function cleanTitle(raw: string): string {
    let cleaned = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "")

    const lines = cleaned.split("\n").map(line => line.trim())
    cleaned = lines.find(line => line.length > 0) || "Untitled"

    if (cleaned.length > 100) {
        cleaned = cleaned.substring(0, 97) + "..."
    }

    return cleaned
}

export async function generateTitleFromContext(
    context: string,
    configModel: string | undefined,
    logger: Logger,
    client: OpenCodeClient
): Promise<string | null> {
    try {
        logger.debug('title-generation', 'Selecting model', { configModel })

        const { model, modelInfo, source, reason, failedModel } = await selectModel(
            logger,
            configModel
        )

        logger.info('title-generation', 'Model selected', {
            providerID: modelInfo.providerID,
            modelID: modelInfo.modelID,
            source,
            reason
        })

        if (failedModel) {
            try {
                await client.tui.showToast({
                    body: {
                        title: "Smart Title: Model fallback",
                        message: `${failedModel.providerID}/${failedModel.modelID} failed\nUsing ${modelInfo.providerID}/${modelInfo.modelID}`,
                        variant: "info",
                        duration: 5000
                    }
                })
                logger.info('title-generation', 'Toast notification shown for model fallback', {
                    failedModel,
                    selectedModel: modelInfo
                })
            } catch (toastError: any) {
                logger.error('title-generation', 'Failed to show toast notification', {
                    error: toastError.message
                })
            }
        }

        logger.debug('title-generation', 'Generating title', {
            contextLength: context.length
        })

        const { generateText } = await import('ai')

        const result = await generateText({
            model,
            messages: [
                {
                    role: 'user',
                    content: `${TITLE_PROMPT}\n\n<conversation>\n${context}\n</conversation>\n\nOutput the title now:`
                }
            ]
        })

        const title = cleanTitle(result.text)

        logger.info('title-generation', 'Title generated successfully', {
            title,
            titleLength: title.length,
            rawLength: result.text.length
        })

        return title

    } catch (error: any) {
        logger.error('title-generation', 'Failed to generate title', {
            error: error.message,
            stack: error.stack
        })
        return null
    }
}

export async function updateSessionTitle(
    client: OpenCodeClient,
    sessionId: string,
    logger: Logger,
    config: PluginConfig
): Promise<void> {
    if (inFlightSessionTitleUpdates.has(sessionId)) {
        queuedSessionTitleUpdates.add(sessionId)
        logger.debug('update-title', 'Skipping duplicate session title update while one is already in flight', {
            sessionId
        })
        return
    }

    inFlightSessionTitleUpdates.add(sessionId)

    try {
        logger.info('update-title', 'Title update triggered', { sessionId })

        const turns = await extractSmartContext(client, sessionId, logger)

        if (turns.length === 0) {
            logger.warn('update-title', 'No conversation turns found', { sessionId })
            return
        }

        logger.info('update-title', 'Context extracted', {
            sessionId,
            turnCount: turns.length
        })

        for (const turn of turns) {
            logger.debug('update-title', 'Turn context', {
                user: truncate(turn.user.text, 100),
                hasAssistant: !!turn.assistant
            })
        }

        const context = formatContextForTitle(turns)

        logger.debug('update-title', 'Formatted context prepared but fixed title override is enabled', {
            sessionId,
            contextLength: context.length,
            configuredModel: config.model
        })

        const newTitle = "hi"

        logger.info('update-title', 'Updating session with new title', {
            sessionId,
            title: newTitle
        })

        await client.session.update({
            path: { id: sessionId },
            body: { title: newTitle }
        })

        logger.info('update-title', 'Session title updated successfully', {
            sessionId,
            title: newTitle
        })

    } catch (error: any) {
        logger.error('update-title', 'Failed to update session title', {
            sessionId,
            error: error.message,
            stack: error.stack
        })
    } finally {
        inFlightSessionTitleUpdates.delete(sessionId)

        if (queuedSessionTitleUpdates.delete(sessionId)) {
            logger.debug('update-title', 'Re-running queued session title update after in-flight completion', {
                sessionId
            })
            await updateSessionTitle(client, sessionId, logger, config)
        }
    }
}
