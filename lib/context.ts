import type { OpenCodeClient, ConversationTurn, MessagePart, Message } from "./types.js"
import type { Logger } from "./logger.js"

export function extractTextOnly(parts: MessagePart[]): string {
    const textParts = parts.filter(
        part => part.type === "text" && !part.synthetic
    )

    return textParts
        .map(part => part.text || '')
        .join("\n")
        .trim()
}

export async function extractSmartContext(
    client: OpenCodeClient,
    sessionId: string,
    logger: Logger
): Promise<ConversationTurn[]> {

    logger.debug('context-extraction', 'Fetching session messages', { sessionId })

    const { data: messages } = await client.session.messages({
        path: { id: sessionId }
    })

    logger.debug('context-extraction', 'Messages fetched', {
        sessionId,
        totalMessages: messages.length
    })

    const conversationMessages = messages.filter(
        (msg: Message) => msg.info.role === "user" || msg.info.role === "assistant"
    )

    logger.debug('context-extraction', 'Filtered conversation messages', {
        sessionId,
        conversationMessages: conversationMessages.length
    })

    const turns: ConversationTurn[] = []
    let currentTurn: ConversationTurn | null = null
    let assistantMessagesInTurn: Array<{ text: string, time: number }> = []

    for (const msg of conversationMessages) {
        if (msg.info.role === "user") {
            if (currentTurn && assistantMessagesInTurn.length > 0) {
                currentTurn.assistant = {
                    first: assistantMessagesInTurn[0].text,
                    last: assistantMessagesInTurn[assistantMessagesInTurn.length - 1].text,
                    time: assistantMessagesInTurn[0].time
                }
                turns.push(currentTurn)
            }

            const userText = extractTextOnly(msg.parts)
            currentTurn = {
                user: {
                    text: userText,
                    time: msg.info.time.created
                }
            }
            assistantMessagesInTurn = []

        } else if (msg.info.role === "assistant") {
            const assistantText = extractTextOnly(msg.parts)
            if (assistantText.length > 0) {
                assistantMessagesInTurn.push({
                    text: assistantText,
                    time: msg.info.time.created
                })
            }
        }
    }

    if (currentTurn) {
        if (assistantMessagesInTurn.length > 0) {
            currentTurn.assistant = {
                first: assistantMessagesInTurn[0].text,
                last: assistantMessagesInTurn[assistantMessagesInTurn.length - 1].text,
                time: assistantMessagesInTurn[0].time
            }
        }

        turns.push(currentTurn)
    }

    logger.debug('context-extraction', 'Extracted conversation turns', {
        sessionId,
        turnCount: turns.length
    })

    return turns
}

export function truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text
    return text.substring(0, maxLength) + "..."
}

export function formatContextForTitle(turns: ConversationTurn[]): string {
    const formatted: string[] = []

    for (const turn of turns) {
        formatted.push(`User: ${turn.user.text}`)
        formatted.push("")

        if (turn.assistant) {
            if (turn.assistant.first === turn.assistant.last) {
                formatted.push(`Assistant: ${turn.assistant.first}`)
            } else {
                formatted.push(`Assistant (initial): ${turn.assistant.first}`)
                formatted.push(`Assistant (final): ${turn.assistant.last}`)
            }
            formatted.push("")
        }
    }

    return formatted.join("\n")
}
