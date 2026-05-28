/**
 * Type definitions for Smart Title Plugin
 */

export interface SessionListItem {
    id: string
    parentID?: string
    time: {
        created: number
        updated: number
        archived?: number
    }
    [key: string]: unknown
}

export interface OpenCodeClient {
    session: {
        messages: (params: { path: { id: string } }) => Promise<any>
        update: (params: { path: { id: string }, body: { title: string } }) => Promise<any>
        get: (params: { path: { id: string } }) => Promise<any>
    }
    tui: {
        showToast: (params: { body: { title: string, message: string, variant: "info" | "success" | "warning" | "error", duration: number } }) => Promise<any>
    }
}

export interface ConversationTurn {
    user: {
        text: string
        time: number
    }
    assistant?: {
        first: string
        last: string
        time: number
    }
}

export interface MessagePart {
    type: string
    text?: string
    synthetic?: boolean
    state?: {
        status?: string
        [key: string]: any
    }
}

export interface Message {
    info: {
        id: string
        role: "user" | "assistant" | "system"
        sessionID: string
        time: {
            created: number
            completed?: number
        }
        parentID?: string
    }
    parts: MessagePart[]
}
