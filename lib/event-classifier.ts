export type SessionEventKind =
    | "session.idle"
    | "session.running"
    | "session.error"
    | "session.deleted"
    | "permission.updated"
    | "permission.asked"
    | "question.asked"
    | "tool.execute.before"
    | "tool.execute.after"
    | "chat.message"
    | "command.execute.before"
    | "unknown"

export interface SessionEventClassification {
    kind: SessionEventKind
    sessionId: string | undefined
    dedupeKey: string | undefined
    label: string
}

interface StatusProperties {
    sessionID?: string
    status?: { type?: string }
}

interface WithIdentifier {
    sessionID?: string
    requestID?: string
    callID?: string
}

function extractSessionId(properties: unknown): string | undefined {
    if (!properties || typeof properties !== "object") return undefined
    const props = properties as Record<string, unknown>
    if (typeof props.sessionID === "string") return props.sessionID
    const info = props.info
    if (info && typeof info === "object") {
        const id = (info as { id?: unknown }).id
        if (typeof id === "string") return id
    }
    return undefined
}

export function classifySessionEvent(event: {
    type: string
    properties?: unknown
}): SessionEventClassification {
    const { type, properties } = event
    const sessionId = extractSessionId(properties)

    switch (type) {
        case "session.idle":
            return { kind: "session.idle", sessionId, dedupeKey: `session-idle:${sessionId}`, label: "session.idle" }

        case "session.status": {
            const statusType = (properties as StatusProperties | undefined)?.status?.type
            if (statusType === "idle") {
                return { kind: "session.idle", sessionId, dedupeKey: `session-status-idle:${sessionId}`, label: "session.status (idle)" }
            }
            return { kind: "session.running", sessionId, dedupeKey: `session-status-running:${sessionId}`, label: `session.status (${statusType ?? "unknown"})` }
        }

        case "session.error":
            return { kind: "session.error", sessionId, dedupeKey: `session-error:${sessionId}`, label: "session.error" }

        case "session.deleted":
            return { kind: "session.deleted", sessionId, dedupeKey: undefined, label: "session.deleted" }

        case "permission.updated":
        case "permission.asked": {
            const p = properties as WithIdentifier | undefined
            return { kind: type, sessionId, dedupeKey: `permission:${sessionId}:${p?.requestID ?? "unknown"}`, label: type }
        }

        case "question.asked": {
            const p = properties as WithIdentifier | undefined
            return { kind: "question.asked", sessionId, dedupeKey: `question:${sessionId}:${p?.callID ?? "unknown"}`, label: "question.asked" }
        }

        case "tool.execute.before":
        case "tool.execute.after":
        case "chat.message":
        case "command.execute.before":
            return { kind: type, sessionId, dedupeKey: undefined, label: type }

        default:
            return { kind: "unknown", sessionId: undefined, dedupeKey: undefined, label: type }
    }
}

export class EventDedupeTracker {
    private readonly windowMs: number
    private readonly recent = new Map<string, number>()

    constructor(windowMs: number) {
        this.windowMs = windowMs
    }

    shouldProcess(dedupeKey: string | undefined, nowMs = Date.now()): boolean {
        if (!dedupeKey) return true

        for (const [key, timestamp] of this.recent.entries()) {
            if (nowMs - timestamp >= this.windowMs) {
                this.recent.delete(key)
            }
        }

        const lastProcessedAt = this.recent.get(dedupeKey)
        if (lastProcessedAt !== undefined && nowMs - lastProcessedAt < this.windowMs) {
            return false
        }

        this.recent.set(dedupeKey, nowMs)
        return true
    }
}
