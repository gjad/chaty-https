// All SQL lives here. Everything is synchronous: the database is the Durable Object's built-in SQLite
// (storage.sql), so a handler that does not `await` between statements is atomic by construction.
import type { AuditEntry, AuditRow, DeviceType, MessageRow, RoomRow } from '../types';
import { generateRoomId, nowIso } from '../lib/util';

type Bind = string | number | null;

const AUDIT_MAX_ROWS = 200_000;
const MAX_ROOM_CREATE_ATTEMPTS = 3;
const ROOM_LIST_LIMIT = 300;
const LAST_MESSAGE_PREVIEW_CHARS = 200;

// Columns holding timestamps: imported legacy values ("YYYY-MM-DD HH:MM:SS", UTC) are converted to ISO-8601.
const TIME_COLUMNS = new Set(['createdAt', 'doneAt', 'timestamp', 'lastReadTimestamp', 'lastActiveAt', 'updatedAt']);

const toIsoTime = (value: string): string => {
  if (value.includes('T') || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return value;
  return `${value.replace(' ', 'T')}.000Z`;
};

export interface RoomListRow extends RoomRow {
  lastMessage: string | null;
  lastTimestamp: string | null;
  lastSenderName: string | null;
  unreadCount: number;
  hasUnread: number;
}

export interface KnowledgeRow {
  category: string;
  categoryOrder: number;
  title: string;
  content: string;
  sortOrder: number;
}

export interface NewMessage {
  messageId: string;
  roomId: string;
  senderType: 'visitor' | 'agent';
  senderId: string;
  senderName: string;
  content: string;
  type: 'text' | 'image';
  imageUrl: string | null;
  timestamp: string;
}

// Tables/columns accepted by the admin bulk import (migration from the self-hosted SQLite file).
export const IMPORT_COLUMNS: Record<string, string[]> = {
  agents: ['agentId', 'username', 'passwordHash', 'name', 'createdAt'],
  rooms: ['roomId', 'visitorId', 'visitorName', 'currentPage', 'createdAt', 'isActive', 'status', 'doneAt'],
  messages: ['messageId', 'roomId', 'senderType', 'senderId', 'senderName', 'content', 'type', 'imageUrl', 'isRead', 'timestamp'],
  room_reads: ['userId', 'roomId', 'lastReadTimestamp'],
  agent_sessions: ['sessionId', 'agentId', 'deviceType', 'userAgent', 'lastActiveAt', 'createdAt'],
  upload_files: ['filename', 'roomId', 'uploaderType', 'uploaderId', 'createdAt'],
  knowledge_entries: ['entryId', 'category', 'categoryOrder', 'title', 'content', 'sortOrder', 'createdAt', 'updatedAt']
};

export class Store {
  constructor(private storage: DurableObjectStorage) {}

  private all<T>(query: string, ...bindings: Bind[]): T[] {
    return this.storage.sql.exec(query, ...bindings).toArray() as T[];
  }

  private first<T>(query: string, ...bindings: Bind[]): T | null {
    return this.all<T>(query, ...bindings)[0] ?? null;
  }

  private run(query: string, ...bindings: Bind[]): void {
    this.storage.sql.exec(query, ...bindings);
  }

  private tx<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  // ---------- agents & sessions ----------

  getAgentByUsername(username: string) {
    return this.first<{ agentId: string; username: string; passwordHash: string; name: string }>(
      'SELECT agentId, username, passwordHash, name FROM agents WHERE username = ?',
      username
    );
  }

  getAgentById(agentId: string) {
    return this.first<{ agentId: string; name: string; passwordHash: string }>(
      'SELECT agentId, name, passwordHash FROM agents WHERE agentId = ?',
      agentId
    );
  }

  getAgentName(agentId: string): string | null {
    return this.first<{ name: string }>('SELECT name FROM agents WHERE agentId = ?', agentId)?.name ?? null;
  }

  countAgents(): number {
    return this.first<{ count: number }>('SELECT count(*) AS count FROM agents')?.count ?? 0;
  }

  insertAgent(agent: { agentId: string; username: string; passwordHash: string; name: string }) {
    this.run(
      'INSERT INTO agents (agentId, username, passwordHash, name, createdAt) VALUES (?, ?, ?, ?, ?)',
      agent.agentId,
      agent.username,
      agent.passwordHash,
      agent.name,
      nowIso()
    );
  }

  updateAgentPassword(agentId: string, passwordHash: string) {
    this.run('UPDATE agents SET passwordHash = ? WHERE agentId = ?', passwordHash, agentId);
  }

  getSession(sessionId: string, agentId: string) {
    return this.first<{ sessionId: string; deviceType: DeviceType; lastActiveAt: string | null }>(
      'SELECT sessionId, deviceType, lastActiveAt FROM agent_sessions WHERE sessionId = ? AND agentId = ?',
      sessionId,
      agentId
    );
  }

  // One live session per agent and device type: returns the ids that were replaced.
  replaceSessions(params: { agentId: string; deviceType: DeviceType; sessionId: string; userAgent: string }): string[] {
    return this.tx(() => {
      const old = this.all<{ sessionId: string }>(
        'SELECT sessionId FROM agent_sessions WHERE agentId = ? AND deviceType = ?',
        params.agentId,
        params.deviceType
      ).map((r) => r.sessionId);
      this.run('DELETE FROM agent_sessions WHERE agentId = ? AND deviceType = ?', params.agentId, params.deviceType);
      const now = nowIso();
      this.run(
        'INSERT INTO agent_sessions (sessionId, agentId, deviceType, userAgent, lastActiveAt, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
        params.sessionId,
        params.agentId,
        params.deviceType,
        params.userAgent,
        now,
        now
      );
      return old;
    });
  }

  // With `agentId` the session is only removed when it belongs to that agent.
  deleteSession(sessionId: string, agentId?: string): boolean {
    const where = agentId ? 'sessionId = ? AND agentId = ?' : 'sessionId = ?';
    const binds: Bind[] = agentId ? [sessionId, agentId] : [sessionId];
    if (!this.first(`SELECT 1 AS x FROM agent_sessions WHERE ${where}`, ...binds)) return false;
    this.run(`DELETE FROM agent_sessions WHERE ${where}`, ...binds);
    return true;
  }

  // Deletes every session of the agent except `keepSessionId`; returns the removed ids.
  deleteOtherSessions(agentId: string, keepSessionId: string): string[] {
    return this.tx(() => {
      const ids = this.all<{ sessionId: string }>(
        'SELECT sessionId FROM agent_sessions WHERE agentId = ? AND sessionId != ?',
        agentId,
        keepSessionId
      ).map((r) => r.sessionId);
      this.run('DELETE FROM agent_sessions WHERE agentId = ? AND sessionId != ?', agentId, keepSessionId);
      return ids;
    });
  }

  touchSession(sessionId: string) {
    this.run('UPDATE agent_sessions SET lastActiveAt = ? WHERE sessionId = ?', new Date().toISOString(), sessionId);
  }

  // ---------- rooms ----------

  getRoom(roomId: string) {
    return this.first<RoomRow>('SELECT * FROM rooms WHERE roomId = ?', roomId);
  }

  getOwnedRoom(roomId: string, visitorId: string) {
    return this.first<RoomRow>('SELECT * FROM rooms WHERE roomId = ? AND visitorId = ?', roomId, visitorId);
  }

  getLatestRoomForVisitor(visitorId: string, onlyActive = false) {
    return this.first<RoomRow>(
      `SELECT * FROM rooms WHERE visitorId = ? ${onlyActive ? 'AND isActive = 1' : ''} ORDER BY createdAt DESC LIMIT 1`,
      visitorId
    );
  }

  createRoomWithRetry(params: { visitorId: string; visitorName: string; currentPage: string }): string {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_ROOM_CREATE_ATTEMPTS; attempt += 1) {
      const roomId = generateRoomId();
      try {
        this.run(
          'INSERT INTO rooms (roomId, visitorId, visitorName, currentPage, createdAt) VALUES (?, ?, ?, ?, ?)',
          roomId,
          params.visitorId,
          params.visitorName || 'Visitor',
          params.currentPage || '',
          nowIso()
        );
        return roomId;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error('ROOM_CREATE_FAILED');
  }

  // Atomic "find the visitor's active room or create one".
  ensureVisitorRoom(params: { visitorId: string; visitorName: string; currentPage: string }): { roomId: string; created: boolean } {
    return this.tx(() => {
      const existing = this.getLatestRoomForVisitor(params.visitorId, true);
      if (existing) return { roomId: existing.roomId, created: false };
      return { roomId: this.createRoomWithRetry(params), created: true };
    });
  }

  updateRoomPage(roomId: string, currentPage: string) {
    this.run('UPDATE rooms SET currentPage = ? WHERE roomId = ?', currentPage, roomId);
  }

  updateRoomVisitor(roomId: string, visitorName: string | null, currentPage: string | null) {
    this.run('UPDATE rooms SET visitorName = ?, currentPage = ? WHERE roomId = ?', visitorName, currentPage, roomId);
  }

  updateRoomStatus(roomId: string, status: 'active' | 'done') {
    if (status === 'done') {
      this.run('UPDATE rooms SET status = ?, doneAt = ? WHERE roomId = ?', status, new Date().toISOString(), roomId);
    } else {
      this.run('UPDATE rooms SET status = ? WHERE roomId = ?', status, roomId);
    }
  }

  getLastMessageMeta(roomId: string) {
    return this.first<{ senderType: 'visitor' | 'agent'; timestamp: string }>(
      'SELECT senderType, timestamp FROM messages WHERE roomId = ? ORDER BY timestamp DESC LIMIT 1',
      roomId
    );
  }

  // ---------- read markers ----------

  private upsertRoomRead(userId: string, roomId: string, timestamp: string) {
    this.run(
      `INSERT INTO room_reads (userId, roomId, lastReadTimestamp) VALUES (?, ?, ?)
       ON CONFLICT(userId, roomId) DO UPDATE SET lastReadTimestamp = excluded.lastReadTimestamp`,
      userId,
      roomId,
      timestamp
    );
  }

  updateRoomRead(userId: string, roomId: string) {
    this.upsertRoomRead(userId, roomId, new Date().toISOString());
  }

  markRoomReadForAllAgents(roomId: string) {
    this.run(
      `INSERT INTO room_reads (userId, roomId, lastReadTimestamp)
       SELECT agentId, ?, ? FROM agents WHERE true
       ON CONFLICT(userId, roomId) DO UPDATE SET lastReadTimestamp = excluded.lastReadTimestamp`,
      roomId,
      new Date().toISOString()
    );
  }

  // ---------- messages ----------

  // Sender read marker + (visitor) reactivation of a done room + the message row, atomically.
  saveMessage(msg: NewMessage) {
    this.tx(() => {
      this.upsertRoomRead(msg.senderId, msg.roomId, msg.timestamp);
      if (msg.senderType === 'visitor') {
        this.run("UPDATE rooms SET status = 'active' WHERE roomId = ? AND status = 'done'", msg.roomId);
      }
      this.run(
        `INSERT INTO messages (messageId, roomId, senderType, senderId, senderName, content, type, imageUrl, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        msg.messageId,
        msg.roomId,
        msg.senderType,
        msg.senderId,
        msg.senderName,
        msg.content,
        msg.type,
        msg.imageUrl,
        msg.timestamp
      );
    });
  }

  getHistory(roomId: string, limit: number, before?: string): MessageRow[] {
    const rows = before
      ? this.all<MessageRow>(
          'SELECT * FROM messages WHERE roomId = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?',
          roomId,
          before,
          limit
        )
      : this.all<MessageRow>('SELECT * FROM messages WHERE roomId = ? ORDER BY timestamp DESC LIMIT ?', roomId, limit);
    return rows.reverse();
  }

  // ---------- room list ----------

  // Unread rules (unchanged from the self-hosted server): done rooms and rooms whose latest message
  // is from an agent have 0 unread; otherwise count visitor messages newer than this agent's read marker.
  // The latest message is looked up once per room (index messages(roomId, timestamp)) and the preview is cut
  // to a few hundred characters so one huge message cannot bloat every room-list push.
  getRoomList(agentId: string): RoomListRow[] {
    if (!agentId) return [];
    const doneSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return this.all<RoomListRow>(
      `SELECT *, CASE WHEN unreadCount > 0 THEN 1 ELSE 0 END AS hasUnread FROM (
         SELECT r.*,
           CASE WHEN m.type = 'image' THEN '[图片]' ELSE substr(m.content, 1, ${LAST_MESSAGE_PREVIEW_CHARS}) END AS lastMessage,
           m.timestamp AS lastTimestamp,
           m.senderName AS lastSenderName,
           CASE
             WHEN r.status = 'done' THEN 0
             WHEN m.senderType = 'agent' THEN 0
             ELSE (
               SELECT COUNT(*) FROM messages
               WHERE roomId = r.roomId AND senderType = 'visitor'
                 AND timestamp > COALESCE((SELECT lastReadTimestamp FROM room_reads WHERE userId = ? AND roomId = r.roomId), '1970-01-01')
             )
           END AS unreadCount
         FROM rooms r
         LEFT JOIN messages m ON m.messageId = (
           SELECT messageId FROM messages WHERE roomId = r.roomId ORDER BY timestamp DESC LIMIT 1
         )
         WHERE r.isActive = 1
           AND (r.status = 'active' OR (r.status = 'done' AND r.doneAt IS NOT NULL AND r.doneAt > ?))
       )
       ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, lastTimestamp DESC
       LIMIT ${ROOM_LIST_LIMIT}`,
      agentId,
      doneSince
    );
  }

  // ---------- uploads ----------

  getUploadMeta(filename: string) {
    return this.first<{ filename: string; roomId: string }>('SELECT filename, roomId FROM upload_files WHERE filename = ?', filename);
  }

  insertUploadMeta(params: { filename: string; roomId: string; uploaderType: 'visitor' | 'agent'; uploaderId: string }) {
    this.run(
      'INSERT INTO upload_files (filename, roomId, uploaderType, uploaderId, createdAt) VALUES (?, ?, ?, ?, ?)',
      params.filename,
      params.roomId,
      params.uploaderType,
      params.uploaderId,
      nowIso()
    );
  }

  // ---------- meta (small key/value settings) ----------

  getMeta(key: string): string | null {
    return this.first<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
  }

  setMeta(key: string, value: string) {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  // ---------- knowledge base ----------

  listKnowledge() {
    return this.all<KnowledgeRow & { entryId: number }>(
      `SELECT entryId, category, categoryOrder, title, content, sortOrder
       FROM knowledge_entries ORDER BY categoryOrder ASC, sortOrder ASC, entryId ASC`
    );
  }

  replaceKnowledge(rows: KnowledgeRow[], baseVersion?: number): { ok: true; version: number } | { ok: false } {
    return this.tx(() => {
      const current = Number(this.getMeta('knowledge_version') ?? '0') || 0;
      if (baseVersion !== undefined && baseVersion !== current) return { ok: false as const };

      this.run('DELETE FROM knowledge_entries');
      for (const row of rows) {
        this.run(
          `INSERT INTO knowledge_entries (category, categoryOrder, title, content, sortOrder, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?)`,
          row.category,
          row.categoryOrder,
          row.title,
          row.content,
          row.sortOrder,
          nowIso()
        );
      }
      this.setMeta('knowledge_version', String(current + 1));
      return { ok: true as const, version: current + 1 };
    });
  }

  getKnowledgeVersion(): number {
    return Number(this.getMeta('knowledge_version') ?? '0') || 0;
  }

  // ---------- admin: bulk import ----------

  importRows(table: string, rows: Record<string, unknown>[]): number {
    const columns = IMPORT_COLUMNS[table];
    if (!columns) throw new Error(`Unknown table: ${table}`);

    const query = `${table === 'agents' ? 'INSERT OR IGNORE' : 'INSERT OR REPLACE'} INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    return this.tx(() => {
      for (const row of rows) {
        const bindings = columns.map((col): Bind => {
          const value = row[col];
          if (value === undefined || value === null) return null;
          if (typeof value === 'string') return TIME_COLUMNS.has(col) ? toIsoTime(value) : value;
          if (typeof value === 'number') return value;
          if (typeof value === 'boolean') return value ? 1 : 0;
          return String(value);
        });
        this.run(query, ...bindings);
      }
      return rows.length;
    });
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const table of Object.keys(IMPORT_COLUMNS)) {
      out[table] = this.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0;
    }
    return out;
  }

  // ---------- audit log (append-only; only the newest AUDIT_MAX_ROWS rows are kept) ----------

  insertAudit(entry: AuditEntry) {
    this.tx(() => {
      this.run(
        `INSERT INTO audit_log (ts, actorType, actorId, action, result, ip, country, ua, target, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        nowIso(),
        entry.actorType,
        entry.actorId ?? null,
        entry.action,
        entry.result,
        entry.ip ?? null,
        entry.country ?? null,
        entry.ua ?? null,
        entry.target ?? null,
        entry.detail ?? null
      );
      this.run('DELETE FROM audit_log WHERE id <= (SELECT max(id) FROM audit_log) - ?', AUDIT_MAX_ROWS);
    });
  }

  listAudit(limit: number, offset: number): AuditRow[] {
    return this.all<AuditRow>(
      `SELECT a.*, g.name AS actorName FROM audit_log a LEFT JOIN agents g ON g.agentId = a.actorId
       ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      limit,
      offset
    );
  }
}
