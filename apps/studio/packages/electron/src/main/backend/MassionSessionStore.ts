import { randomUUID } from 'node:crypto';
import type {
    SessionStore,
    SessionMeta,
    CreateSessionPayload,
    UpdateSessionMetadataPayload,
    SessionListOptions,
    SessionSearchOptions,
} from '@nimbalyst/runtime/ai/adapters/sessionStore';
import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript/TranscriptProjector';

interface MassionWork {
    workId: string;
    status: string;
    revision: number;
    artifactIds: string[];
    workspaceId?: string;
}

interface MassionTimelineCell {
    cellId: string;
    kind: string;
    title: string;
    detail?: string;
    createdAt: string;
    sequence: number;
}

// ponytail: list() fetches timeline(limit:5) per work in parallel for titles
// — add server-side title field to work.list response if this becomes slow at scale
export class MassionSessionStore implements SessionStore {
    private readonly baseUrl: string;
    private readonly token: string;

    constructor(baseUrl: string, token: string) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.token = token;
    }

    private async query<T>(operation: string, payload: Record<string, unknown> = {}): Promise<T> {
        const response = await fetch(`${this.baseUrl}/api/v1/query`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.token}`,
            },
            body: JSON.stringify({ operation, payload }),
        });
        if (!response.ok) throw new Error(`Massion query ${operation} failed (${response.status})`);
        // Response shape: {schemaVersion, operation, data: <result>}
        const envelope = await response.json() as { data: T };
        return envelope.data;
    }

    private async command(operation: string, payload: Record<string, unknown> = {}): Promise<void> {
        const response = await fetch(`${this.baseUrl}/api/v1/commands`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.token}`,
            },
            body: JSON.stringify({
                schemaVersion: 'massion.application.v1',
                commandId: randomUUID(),
                correlationId: randomUUID(),
                operation,
                payload,
            }),
        });
        if (!response.ok) throw new Error(`Massion command ${operation} failed (${response.status})`);
    }

    async ensureReady(): Promise<void> {}

    async list(workspaceId: string, _options?: SessionListOptions): Promise<SessionMeta[]> {
        const works = await this.query<MassionWork[]>('work.list', workspaceId ? { workspaceId } : {});

        const withTimelines = await Promise.all(
            works.map(async (work) => {
                try {
                    const cells = await this.query<MassionTimelineCell[]>('work.timeline', {
                        workId: work.workId,
                        limit: 5,
                    });
                    return { work, cells };
                } catch {
                    return { work, cells: [] as MassionTimelineCell[] };
                }
            })
        );

        return withTimelines.map(({ work, cells }) => this.toSessionMeta(work, cells));
    }

    async get(sessionId: string): Promise<SessionData | null> {
        try {
            const [work, cells] = await Promise.all([
                this.query<MassionWork>('work.get', { workId: sessionId }),
                this.query<MassionTimelineCell[]>('work.timeline', { workId: sessionId }),
            ]);
            const firstCell = cells[0];
            const lastCell = cells[cells.length - 1];
            return {
                id: sessionId,
                provider: 'massion',
                sessionType: 'session',
                title: this.extractTitle(cells) || sessionId.slice(0, 8),
                messages: cells.map((cell, i) => this.cellToMessage(cell, i)),
                workspacePath: work.workspaceId,
                createdAt: firstCell ? Date.parse(firstCell.createdAt) : 0,
                updatedAt: lastCell ? Date.parse(lastCell.createdAt) : 0,
            };
        } catch {
            return null;
        }
    }

    // ponytail: create() is a no-op for S2 — work is created via CLI (massion run <text>)
    // wire to work.create command in S3 once org-version lookup is implemented
    async create(_payload: CreateSessionPayload): Promise<void> {}

    async updateMetadata(_sessionId: string, _metadata: UpdateSessionMetadataPayload): Promise<void> {}

    async search(workspaceId: string, query: string, _options?: SessionSearchOptions): Promise<SessionMeta[]> {
        const all = await this.list(workspaceId);
        const q = query.toLowerCase();
        return all.filter((s) => s.title.toLowerCase().includes(q));
    }

    async delete(sessionId: string): Promise<void> {
        await this.command('work.cancel', { workId: sessionId }).catch(() => {});
    }

    async updateTitleIfNotNamed(_id: string, _title: string): Promise<boolean> {
        return false;
    }

    async getBranches(_id: string): Promise<SessionMeta[]> {
        return [];
    }

    private toSessionMeta(work: MassionWork, cells: MassionTimelineCell[]): SessionMeta {
        const firstCell = cells[0];
        const lastCell = cells[cells.length - 1];
        const createdAt = firstCell ? Date.parse(firstCell.createdAt) : 0;
        const updatedAt = lastCell ? Date.parse(lastCell.createdAt) : createdAt;

        return {
            id: work.workId,
            title: this.extractTitle(cells) || work.workId.slice(0, 8),
            provider: 'massion',
            sessionType: 'session',
            workspaceId: work.workspaceId ?? '',
            worktreeId: null,
            parentSessionId: null,
            childCount: 0,
            uncommittedCount: 0,
            createdAt,
            updatedAt,
            messageCount: cells.length,
            isArchived: work.status === 'completed' || work.status === 'cancelled',
            isPinned: false,
            phase: work.status,
        };
    }

    private extractTitle(cells: MassionTimelineCell[]): string {
        return cells.find((c) => c.kind === 'user-message')?.title ?? '';
    }

    private cellToMessage(cell: MassionTimelineCell, index: number): TranscriptViewMessage {
        const type = cell.kind === 'user-message' ? 'user_message' : 'assistant_message';
        return {
            id: index,
            sequence: cell.sequence,
            createdAt: new Date(cell.createdAt),
            type,
            text: cell.detail ?? cell.title,
        } as unknown as TranscriptViewMessage;
    }
}
