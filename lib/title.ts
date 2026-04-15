import type { OpenCodeClient } from "./types.js"
import type { Logger } from "./logger.js"
import type { PluginConfig } from "./config.js"
import { extractSmartContext, formatContextForTitle, truncate } from "./context.js"
import { selectModel } from "./model-selector.js"
import { TITLE_PROMPT } from "../prompt.js"

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
    }
}
