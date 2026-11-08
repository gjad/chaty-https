import { DurableObject } from 'cloudflare:workers';
import type { AuditEntry, AuditRow, DeviceType, Env, MessageRow } from './types';
import { cookieSecret } from './types';
import { migrate } from './db/schema';
import { Store } from './db/store';
import type { KnowledgeRow } from './db/store';
import { parseCookieHeader, verifySignedCookieValue } from './lib/cookies';
import { verifyAgentToken, verifyVisitorToken } from './lib/jwt';
import { sendBark } from './lib/push';
import { ROOM_ID_PATTERN, UPLOAD_KEY_PATTERN, parseDbTime, pickRandomVisitorName, sanitizePageUrl } from './lib/util';
import { securityLog } from './lib/log';

// ChatHub is the single stateful object of the system. It owns
//   * the SQLite database (ctx.storage.sql, via Store) - the only place data lives,
//   * every WebSocket (Hibernation API),
//   * the data operations the Worker needs, exposed as RPC methods (see "RPC" below).
//
// Wire protocol (JSON text frames), mirrors the Socket.IO event names used by the old server:
//   client -> server  {"e": "<event>", "d": <payload>, "id": <number, optional: ack requested>}
//   server -> client  {"e": "<event>", "d": <payload>}
//   server -> client  {"a": <id>, "d": <ack payload>}
// Keep-alive: the client sends the literal text "ping"; the runtime answers "pong" without waking the object.

const AUTH_TIMEOUT_MS = 10_000;
const MAX_FRAME_CHARS = 256 * 1024;
const MAX_TEXT_CHARS = 4000;
const DONE_GUARD_SECONDS = 30;
const BROADCAST_DELAY_MS = 150;
// An agent session that has not been used for this long is dead (sliding window, refreshed while in use).
const SESSION_IDLE_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 10 * 60 * 1000;
const MAX_SOCKETS_PER_VISITOR = 10;
const MAX_ATTACHED_COOKIE_CHARS = 1200;
const BARK_MIN_INTERVAL_MS = 15_000;
const BARK_PREVIEW_CHARS = 120;

// Close codes the clients can distinguish.
const CLOSE_SESSION_ENDED = 4001;
const CLOSE_LOGGED_OUT = 4002;
const CLOSE_RATE_LIMITED = 1008;

// Token bucket: `cap` events of burst, refilled at `perSec` events per second.
class Bucket {
  private tokens: number;
  last = Date.now();

  constructor(private cap: number, private perSec: number) {
    this.tokens = cap;
  }

  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.cap, this.tokens + ((now - this.last) / 1000) * this.perSec);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// Per-connection budgets (kept in memory: a hibernated, idle socket simply starts with fresh budgets).
interface SocketLimits {
  all: Bucket; // every frame
  auth: Bucket; // agent-login / visitor-join
  heavy: Bucket; // events that recompute the room list
  page: Bucket; // visitor-page-change
  send: Bucket; // send-message
  violations: number;
}

interface Attachment {
  role: 'agent' | 'visitor' | null;
  t: number;
  // Cookie-derived credentials captured at upgrade time (cleared after authentication).
  ck?: { visitorId?: string; agentToken?: string; agentSession?: string };
  agent?: { agentId: string; username: string; sessionId: string };
  visitor?: { visitorId: string; visitorName: string; roomId: string; currentPage: string };
}

type Json = Record<string, unknown>;
type Access = { agent: boolean; visitorIds: string[] };
type NewRoom = { roomId: string; visitorId: string; visitorName: string; currentPage: string };

export type HistoryResult =
  | { ok: false; status: 401 }
  | { ok: true; messages: MessageRow[]; visitorName: string; currentPage: string; status: string };

export type UploadAuthResult =
  | { ok: true; roomId: string }
  | { ok: false; status: 403 | 503; error: string; code?: string };

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export class ChatHub extends DurableObject<Env> {
  private store: Store;
  private chains = new WeakMap<WebSocket, Promise<void>>();
  private limits = new WeakMap<WebSocket, SocketLimits>();
  private visitorSendBuckets = new Map<string, Bucket>();
  private lastBark = new Map<string, number>();
  private broadcastPending = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage);
    ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // ================================================================ RPC (called from the Worker)

  // ---- agents & sessions

  getAgentByUsername(username: string) {
    return this.store.getAgentByUsername(username);
  }

  getAgentById(agentId: string) {
    return this.store.getAgentById(agentId);
  }

  // Creates the agent's new session; replaced sessions of the same device type are told to log out.
  createAgentSession(p: { agentId: string; deviceType: DeviceType; userAgent: string }): string {
    const sessionId = crypto.randomUUID();
    const replaced = this.store.replaceSessions({ ...p, sessionId });
    this.kickSessions(replaced, '您的账号在另一台设备上登录');
    return sessionId;
  }

  // Session check used by the API guard and /verify-token. Returns the agent when the session is alive.
  verifyAgentSession(agentId: string, sessionId: string): { agentId: string; name: string } | null {
    if (!this.sessionAlive(agentId, sessionId)) return null;
    const agent = this.store.getAgentById(agentId);
    return agent ? { agentId: agent.agentId, name: agent.name } : null;
  }

  // Alive = the row exists and was used within SESSION_IDLE_TTL_MS. Use refreshes the sliding window.
  private sessionAlive(agentId: string, sessionId: string): boolean {
    const session = this.store.getSession(sessionId, agentId);
    if (!session) return false;

    const idleFor = Date.now() - parseDbTime(session.lastActiveAt);
    if (idleFor > SESSION_IDLE_TTL_MS) {
      this.store.deleteSession(sessionId);
      return false;
    }
    if (idleFor > SESSION_TOUCH_INTERVAL_MS) this.store.touchSession(sessionId);
    return true;
  }

  // Logout: removes the caller's own session and drops its sockets.
  endSession(sessionId: string, agentId: string): void {
    if (this.store.deleteSession(sessionId, agentId)) this.closeSessionSockets([sessionId], CLOSE_LOGGED_OUT, 'logged out');
  }

  changeAgentPassword(agentId: string, passwordHash: string, keepSessionId: string): void {
    this.store.updateAgentPassword(agentId, passwordHash);
    const removed = this.store.deleteOtherSessions(agentId, keepSessionId);
    this.kickSessions(removed, '密码已修改，请重新登录');
  }

  getVisitorRoomSummary(visitorId: string): { roomId: string; visitorName: string | null } | null {
    const room = this.store.getLatestRoomForVisitor(visitorId);
    return room ? { roomId: room.roomId, visitorName: room.visitorName } : null;
  }

  // ---- history / knowledge base

  getHistory(p: { roomId: string; limit: number; before?: string } & Access): HistoryResult {
    const room = this.store.getRoom(p.roomId);
    const authorized = p.agent || (!!room && p.visitorIds.includes(room.visitorId));
    if (!authorized) return { ok: false, status: 401 };

    return {
      ok: true,
      messages: this.store.getHistory(p.roomId, p.limit, p.before),
      visitorName: room ? room.visitorName || '访客' : '访客',
      currentPage: room ? room.currentPage || '' : '',
      status: room ? room.status : 'active'
    };
  }

  getKnowledge(): { name: string; items: { title: string; content: string }[] }[] {
    const categories = new Map<string, { name: string; items: { title: string; content: string }[] }>();
    for (const row of this.store.listKnowledge()) {
      const key = `${row.categoryOrder}::${row.category}`;
      let entry = categories.get(key);
      if (!entry) {
        entry = { name: row.category, items: [] };
        categories.set(key, entry);
      }
      entry.items.push({ title: row.title, content: row.content });
    }
    return [...categories.values()];
  }

  getKnowledgeVersion(): number {
    return this.store.getKnowledgeVersion();
  }

  replaceKnowledge(rows: KnowledgeRow[], baseVersion?: number): { ok: true; total: number; version: number } | { ok: false } {
    const result = this.store.replaceKnowledge(rows, baseVersion);
    return result.ok ? { ok: true, total: rows.length, version: result.version } : { ok: false };
  }

  // ---- uploads

  // Who may upload into which room. Visitors without a room get one created (atomically).
  authorizeUpload(p: { roomId: string; identity: { type: 'agent' | 'visitor'; id: string } }): UploadAuthResult {
    let roomId = p.roomId;
    let room = roomId ? this.store.getRoom(roomId) : null;

    if (p.identity.type === 'visitor') {
      if (!room) {
        const existing = this.store.getLatestRoomForVisitor(p.identity.id, true);
        if (existing) {
          room = existing;
          roomId = existing.roomId;
        }
      }

      if (!roomId) {
        try {
          const ensured = this.store.ensureVisitorRoom({
            visitorId: p.identity.id,
            visitorName: pickRandomVisitorName(),
            currentPage: ''
          });
          roomId = ensured.roomId;
          room = this.store.getRoom(roomId);
          this.bindVisitorRoom(p.identity.id, roomId);
        } catch (err) {
          console.error('Failed to create room for upload:', err);
          return { ok: false, status: 503, error: 'Room create failed', code: 'ROOM_CREATE_FAILED' };
        }
      } else if (!room) {
        return { ok: false, status: 403, error: 'Room not available for upload' };
      }

      if (!room || room.visitorId !== p.identity.id || room.isActive !== 1) {
        return { ok: false, status: 403, error: 'Visitor is not authorized for this room' };
      }
      return { ok: true, roomId };
    }

    if (!room || room.isActive !== 1) return { ok: false, status: 403, error: 'Room not available for upload' };
    return { ok: true, roomId };
  }

  recordUpload(p: { filename: string; roomId: string; uploaderType: 'visitor' | 'agent'; uploaderId: string }): void {
    this.store.insertUploadMeta(p);
  }

  getFileAccess(p: { key: string } & Access): 'ok' | 'not-found' | 'forbidden' {
    const meta = this.store.getUploadMeta(p.key);
    if (!meta) return 'not-found';
    if (p.agent) return 'ok';
    const room = this.store.getRoom(meta.roomId);
    return room && p.visitorIds.includes(room.visitorId) ? 'ok' : 'forbidden';
  }

  // ---- admin (guarded by ADMIN_TOKEN in the Worker)

  adminCreateAgent(p: { username: string; passwordHash: string; name: string }): { agentId: string } | { error: 'exists' } {
    if (this.store.getAgentByUsername(p.username)) return { error: 'exists' };
    const agentId = crypto.randomUUID();
    this.store.insertAgent({ agentId, ...p });
    return { agentId };
  }

  adminImport(table: string, rows: Record<string, unknown>[]): number {
    return this.store.importRows(table, rows);
  }

  adminCounts(): Record<string, number> {
    return this.store.counts();
  }

  // ---- audit trail

  audit(entry: AuditEntry): void {
    this.store.insertAudit(entry);
  }

  listAudit(limit: number, offset: number): AuditRow[] {
    return this.store.listAudit(limit, offset);
  }

  // ================================================================ upgrade

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const cookies = parseCookieHeader(request.headers.get('cookie'));
    const ck: NonNullable<Attachment['ck']> = {};
    const cookieVisitorId = await verifySignedCookieValue(cookies.visitorAuth, cookieSecret(this.env));
    if (cookieVisitorId && cookieVisitorId.length <= 100) ck.visitorId = cookieVisitorId;
    // Attachments are limited to 2 KB: oversized (necessarily invalid) credentials are simply not carried along.
    if (cookies.agent_token && cookies.agent_token.length <= MAX_ATTACHED_COOKIE_CHARS) ck.agentToken = cookies.agent_token;
    if (cookies.agent_session && cookies.agent_session.length <= 100) ck.agentSession = cookies.agent_session;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    this.setAtt(server, { role: null, t: Date.now(), ck });

    this.emit(server, 'version-check', this.env.APP_VERSION);
    await this.armAuthAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  private async armAuthAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + AUTH_TIMEOUT_MS);
    }
  }

  // Closes sockets that never authenticated (the client must send agent-login / visitor-join right after connecting).
  async alarm(): Promise<void> {
    const now = Date.now();
    let nextDue: number | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.getAtt(ws);
      if (att.role !== null) continue;
      const due = att.t + AUTH_TIMEOUT_MS;
      if (now >= due) {
        try {
          ws.close(4401, 'auth timeout');
        } catch {
          /* already closed */
        }
      } else if (nextDue === null || due < nextDue) {
        nextDue = due;
      }
    }
    if (nextDue !== null) await this.ctx.storage.setAlarm(nextDue);
  }

  // ================================================================ socket plumbing

  private getAtt(ws: WebSocket): Attachment {
    return (ws.deserializeAttachment() as Attachment | null) ?? { role: null, t: 0 };
  }

  private setAtt(ws: WebSocket, att: Attachment) {
    ws.serializeAttachment(att);
  }

  private emit(ws: WebSocket, event: string, data?: unknown) {
    try {
      ws.send(JSON.stringify({ e: event, d: data }));
    } catch {
      /* socket already closed */
    }
  }

  private ack(ws: WebSocket, id: number, data: unknown) {
    try {
      ws.send(JSON.stringify({ a: id, d: data }));
    } catch {
      /* socket already closed */
    }
  }

  private agentSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => this.getAtt(ws).role === 'agent');
  }

  // Replaces socket.io's `io.to(roomId).emit`: every agent plus visitor sockets bound to the room.
  private emitToRoom(roomId: string, event: string, data: unknown) {
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.getAtt(ws);
      if (att.role === 'agent' || (att.role === 'visitor' && att.visitor?.roomId === roomId)) {
        this.emit(ws, event, data);
      }
    }
  }

  // Binds every socket of a visitor to a (new) room, e.g. a second tab opened before the first message.
  private bindVisitorRoom(visitorId: string, roomId: string) {
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.getAtt(ws);
      if (att.role === 'visitor' && att.visitor && att.visitor.visitorId === visitorId && att.visitor.roomId !== roomId) {
        att.visitor.roomId = roomId;
        this.setAtt(ws, att);
      }
    }
  }

  // Another device signed in / password changed: tell the old sessions, then really drop their sockets so a
  // client that ignores `force-logout` cannot keep operating.
  private kickSessions(sessionIds: string[], reason: string) {
    const targets = new Set(sessionIds);
    if (!targets.size) return;
    for (const ws of this.agentSockets()) {
      const sessionId = this.getAtt(ws).agent?.sessionId;
      if (sessionId && targets.has(sessionId)) {
        this.emit(ws, 'force-logout', { reason, sessionId });
        this.safeClose(ws, CLOSE_SESSION_ENDED, 'session ended');
      }
    }
  }

  private closeSessionSockets(sessionIds: string[], code: number, reason: string) {
    const targets = new Set(sessionIds);
    for (const ws of this.agentSockets()) {
      const sessionId = this.getAtt(ws).agent?.sessionId;
      if (sessionId && targets.has(sessionId)) this.safeClose(ws, code, reason);
    }
  }

  private safeClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    if (message.length > MAX_FRAME_CHARS) {
      ws.close(1009, 'message too large');
      return;
    }

    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    if (!isObj(frame) || typeof frame.e !== 'string') return;

    const event = frame.e;
    const payload = frame.d;
    const id = typeof frame.id === 'number' ? frame.id : null;

    // Flood protection: every frame costs one token; sustained abuse closes the connection.
    const limits = this.limitsFor(ws);
    if (!limits.all.take()) {
      limits.violations += 1;
      if (id !== null) this.ack(ws, id, { success: false, error: 'Too many requests', code: 'RATE_LIMITED' });
      if (limits.violations >= 100) this.safeClose(ws, CLOSE_RATE_LIMITED, 'rate limited');
      return;
    }

    // Serialize events per socket: JWT verification awaits must not reorder a client's own messages.
    const prev = this.chains.get(ws) ?? Promise.resolve();
    const next = prev
      .then(() => this.dispatch(ws, event, payload, id))
      .catch((err) => {
        console.error(`Event ${event} failed:`, err);
        if (id !== null) this.ack(ws, id, { success: false, error: 'Internal error' });
        else this.emit(ws, 'error', 'Internal error');
      });
    this.chains.set(ws, next);
    await next;
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.chains.delete(ws);
    this.limits.delete(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('WebSocket error:', error);
    this.chains.delete(ws);
    this.limits.delete(ws);
  }

  private limitsFor(ws: WebSocket): SocketLimits {
    let limits = this.limits.get(ws);
    if (!limits) {
      limits = {
        all: new Bucket(60, 15),
        auth: new Bucket(5, 1 / 6),
        heavy: new Bucket(20, 5),
        page: new Bucket(5, 0.5),
        send: new Bucket(10, 1),
        violations: 0
      };
      this.limits.set(ws, limits);
    }
    return limits;
  }

  // Returns true when the event may proceed. Silent events are dropped, acked ones get an error reply.
  private allow(ws: WebSocket, bucket: Bucket, id: number | null): boolean {
    if (bucket.take()) return true;
    if (id !== null) this.ack(ws, id, { success: false, error: 'Too many requests', code: 'RATE_LIMITED' });
    return false;
  }

  private async dispatch(ws: WebSocket, event: string, payload: unknown, id: number | null) {
    const limits = this.limitsFor(ws);

    // A signed-in agent socket is only as good as its session row: re-checked on every event, so logout,
    // password change and sign-in elsewhere cut the connection off immediately.
    const agent = this.getAtt(ws).agent;
    if (agent && event !== 'agent-login' && !this.sessionAlive(agent.agentId, agent.sessionId)) {
      if (id !== null) this.ack(ws, id, { success: false, error: 'Session expired', code: 'SESSION_EXPIRED' });
      this.emit(ws, 'force-logout', { reason: '会话已失效，请重新登录', sessionId: agent.sessionId });
      this.safeClose(ws, CLOSE_SESSION_ENDED, 'session ended');
      return undefined;
    }

    switch (event) {
      case 'visitor-join':
        return this.allow(ws, limits.auth, id) ? this.onVisitorJoin(ws, payload) : undefined;
      case 'visitor-page-change':
        return this.allow(ws, limits.page, id) ? this.onVisitorPageChange(ws, payload) : undefined;
      case 'agent-login':
        return this.allow(ws, limits.auth, id) ? this.onAgentLogin(ws, payload) : undefined;
      case 'join-room':
        return this.allow(ws, limits.heavy, id) ? this.onJoinRoom(ws, payload) : undefined;
      case 'leave-room':
        return this.onLeaveRoom(ws, payload);
      case 'request-room-list':
        return this.allow(ws, limits.heavy, id) ? this.onRequestRoomList(ws) : undefined;
      case 'update-room-status':
        return this.allow(ws, limits.heavy, id) ? this.onUpdateRoomStatus(ws, payload) : undefined;
      case 'mark-read':
        return this.allow(ws, limits.heavy, id) ? this.onMarkRead(ws, payload) : undefined;
      case 'send-message':
        return this.allow(ws, limits.send, id) ? this.onSendMessage(ws, payload, id) : undefined;
      default:
        return undefined;
    }
  }

  // ================================================================ room list broadcast

  // Coalesced: bursts of changes within BROADCAST_DELAY_MS produce a single room-list push per agent.
  private requestRoomListBroadcast() {
    if (this.broadcastPending) return;
    this.broadcastPending = true;
    setTimeout(() => {
      this.broadcastPending = false;
      try {
        this.sendRoomLists();
      } catch (err) {
        console.error('Room list broadcast failed:', err);
      }
    }, BROADCAST_DELAY_MS);
  }

  private sendRoomLists() {
    const byAgent = new Map<string, WebSocket[]>();
    for (const ws of this.agentSockets()) {
      const agentId = this.getAtt(ws).agent?.agentId;
      if (!agentId) continue;
      const list = byAgent.get(agentId);
      if (list) list.push(ws);
      else byAgent.set(agentId, [ws]);
    }

    for (const [agentId, sockets] of byAgent) {
      const rooms = this.store.getRoomList(agentId);
      for (const ws of sockets) this.emit(ws, 'room-list', rooms);
    }
  }

  // ================================================================ event handlers

  private updateVisitorCurrentPage(params: { visitorId: string; roomId: string; currentPage: string }): string {
    const safePage = sanitizePageUrl(params.currentPage);
    if (!params.visitorId || !safePage) return '';

    let resolvedRoomId = params.roomId.trim();
    let room = resolvedRoomId ? this.store.getOwnedRoom(resolvedRoomId, params.visitorId) : null;
    if (!room) {
      room = this.store.getLatestRoomForVisitor(params.visitorId);
      resolvedRoomId = room ? room.roomId : '';
    }
    if (!room || !resolvedRoomId) return '';

    if (room.currentPage !== safePage) {
      this.store.updateRoomPage(resolvedRoomId, safePage);
      this.requestRoomListBroadcast();
    }
    return resolvedRoomId;
  }

  private async onVisitorJoin(ws: WebSocket, raw: unknown) {
    const att = this.getAtt(ws);
    if (att.role === 'agent') {
      this.emit(ws, 'error', '当前连接已作为客服身份登录');
      return;
    }

    const p = isObj(raw) ? raw : {};
    const claimedVisitorId = str(p.visitorId).trim();
    const visitorName = str(p.visitorName).trim().slice(0, 80) || pickRandomVisitorName();
    const claimedRoomId = str(p.roomId).trim();
    // Shown as a link in the agent app: http(s) only.
    const currentPage = sanitizePageUrl(p.currentPage);

    // The claimed id must be proven by the signed cookie OR the visitor token (either is enough, exactly like the
    // HTTP API). Requiring a specific one would lock out a tab whose token is valid but whose shared cookie was
    // refreshed by another tab of the same browser.
    const tokenVisitorId = await verifyVisitorToken(str(p.visitorToken), this.env.JWT_SECRET);
    const proven = [att.ck?.visitorId, tokenVisitorId].filter((v): v is string => !!v);

    if (!proven.length || !claimedVisitorId || !proven.includes(claimedVisitorId)) {
      securityLog('visitor_join_rejected', null, {
        claimed: claimedVisitorId.slice(0, 40) || 'empty',
        proofs: proven.length
      });
      this.emit(ws, 'error', '身份验证失败，请刷新页面重试');
      // Lets the widget re-run /visitor-auth and join again instead of waiting for the auth timeout.
      this.emit(ws, 'auth-failed', { reason: proven.length ? 'mismatch' : 'missing' });
      return;
    }
    const verifiedVisitorId = claimedVisitorId;

    this.limitVisitorSockets(ws, verifiedVisitorId);

    let roomId = '';
    if (claimedRoomId) {
      const owned = this.store.getOwnedRoom(claimedRoomId, verifiedVisitorId);
      if (owned) roomId = owned.roomId;
    }
    if (!roomId) {
      const latest = this.store.getLatestRoomForVisitor(verifiedVisitorId);
      roomId = latest ? latest.roomId : '';
    }

    this.setAtt(ws, {
      role: 'visitor',
      t: att.t,
      ck: att.ck?.visitorId ? { visitorId: att.ck.visitorId } : undefined,
      visitor: { visitorId: verifiedVisitorId, visitorName, roomId, currentPage }
    });

    if (roomId && currentPage) {
      this.updateVisitorCurrentPage({ visitorId: verifiedVisitorId, roomId, currentPage });
    }

    this.emit(ws, 'joined', { roomId });
  }

  // A visitor may have a handful of tabs open, not hundreds: beyond the cap the oldest connections are dropped.
  private limitVisitorSockets(self: WebSocket, visitorId: string) {
    const others = this.ctx.getWebSockets().filter((ws) => {
      if (ws === self) return false;
      const att = this.getAtt(ws);
      return att.role === 'visitor' && att.visitor?.visitorId === visitorId;
    });
    if (others.length < MAX_SOCKETS_PER_VISITOR) return;
    others.sort((a, b) => this.getAtt(a).t - this.getAtt(b).t);
    for (const ws of others.slice(0, others.length - MAX_SOCKETS_PER_VISITOR + 1)) {
      this.safeClose(ws, CLOSE_RATE_LIMITED, 'too many connections');
    }
  }

  private onVisitorPageChange(ws: WebSocket, raw: unknown) {
    const att = this.getAtt(ws);
    if (att.role !== 'visitor' || !att.visitor) return;

    const p = isObj(raw) ? raw : {};
    const currentPage = sanitizePageUrl(p.currentPage);
    if (!currentPage) return;

    att.visitor.currentPage = currentPage;
    const resolvedRoomId = this.updateVisitorCurrentPage({
      visitorId: att.visitor.visitorId,
      roomId: str(p.roomId) || att.visitor.roomId,
      currentPage
    });
    if (resolvedRoomId) att.visitor.roomId = resolvedRoomId;
    this.setAtt(ws, att);
  }

  private async onAgentLogin(ws: WebSocket, raw: unknown) {
    const att = this.getAtt(ws);
    if (att.role === 'visitor') {
      this.emit(ws, 'error', '当前连接已作为访客身份登录');
      return;
    }

    const p = isObj(raw) ? raw : {};
    const token = str(p.token) || att.ck?.agentToken;
    const sessionId = str(p.sessionId) || att.ck?.agentSession;

    const decoded = await verifyAgentToken(token, this.env.JWT_SECRET);
    if (!decoded || !sessionId) {
      this.emit(ws, 'error', 'Invalid token');
      return;
    }

    if (!this.store.getSession(sessionId, decoded.agentId)) {
      this.emit(ws, 'force-logout', { reason: '会话已失效，您的账号在其他设备登录', sessionId });
      return;
    }

    // Keep the verified credentials: the client re-sends `agent-login` (with only the sessionId) on the same
    // socket after navigation, and that must still resolve the token from the cookie.
    this.setAtt(ws, {
      role: 'agent',
      t: att.t,
      ck: { agentToken: token, agentSession: sessionId },
      agent: { agentId: decoded.agentId, username: decoded.username, sessionId }
    });

    this.store.touchSession(sessionId);
    this.emit(ws, 'room-list', this.store.getRoomList(decoded.agentId));
  }

  private onJoinRoom(ws: WebSocket, raw: unknown) {
    const agent = this.getAtt(ws).agent;
    const roomId = str(raw);
    if (!agent || !ROOM_ID_PATTERN.test(roomId) || !this.store.getRoom(roomId)) return;
    this.store.updateRoomRead(agent.agentId, roomId);
    this.emit(ws, 'room-list', this.store.getRoomList(agent.agentId));
  }

  private onLeaveRoom(ws: WebSocket, raw: unknown) {
    const agent = this.getAtt(ws).agent;
    const roomId = str(raw);
    if (!agent || !ROOM_ID_PATTERN.test(roomId) || !this.store.getRoom(roomId)) return;
    this.store.updateRoomRead(agent.agentId, roomId);
  }

  private onRequestRoomList(ws: WebSocket) {
    const agent = this.getAtt(ws).agent;
    if (!agent) return;
    this.emit(ws, 'room-list', this.store.getRoomList(agent.agentId));
  }

  private onUpdateRoomStatus(ws: WebSocket, raw: unknown) {
    const agent = this.getAtt(ws).agent;
    const p = isObj(raw) ? raw : {};
    const roomId = str(p.roomId);
    const status = p.status;
    if (!agent || !ROOM_ID_PATTERN.test(roomId) || (status !== 'active' && status !== 'done')) return;
    if (!this.store.getRoom(roomId)) return;

    if (status === 'done') {
      const last = this.store.getLastMessageMeta(roomId);
      if (last && last.senderType === 'visitor') {
        const diffSeconds = (Date.now() - new Date(last.timestamp).getTime()) / 1000;
        if (diffSeconds < DONE_GUARD_SECONDS) {
          const wait = Math.ceil(DONE_GUARD_SECONDS - diffSeconds);
          this.emit(ws, 'error', `访客刚发过消息，请至少等待 ${wait} 秒后再结束会话，以免漏看消息。`);
          return;
        }
      }
      this.store.markRoomReadForAllAgents(roomId);
    }

    this.store.updateRoomStatus(roomId, status);
    this.requestRoomListBroadcast();
  }

  private onMarkRead(ws: WebSocket, raw: unknown) {
    const att = this.getAtt(ws);
    const roomId = str(raw);
    const userId = att.agent?.agentId ?? att.visitor?.visitorId;
    if (!userId || !ROOM_ID_PATTERN.test(roomId)) return;

    // Agents may mark any existing room; visitors only the room they own.
    const allowed = att.agent ? !!this.store.getRoom(roomId) : !!this.store.getOwnedRoom(roomId, userId);
    if (!allowed) return;

    this.store.updateRoomRead(userId, roomId);
    if (att.agent) this.emit(ws, 'room-list', this.store.getRoomList(userId));
  }

  // Everything from validation to persistence is synchronous: no await, so "find or create room" and
  // "save message" cannot interleave with another event.
  private onSendMessage(ws: WebSocket, raw: unknown, id: number | null) {
    // Clients that did not ask for an ack (fire-and-forget) still learn about failures through an `error` event.
    const reply = (payload: Json) => {
      if (id !== null) this.ack(ws, id, payload);
      else if (payload.success === false) this.emit(ws, 'error', str(payload.error) || 'Send failed');
    };

    const att = this.getAtt(ws);
    const msg = isObj(raw) ? raw : {};
    const requestedRoomId = str(msg.roomId).trim();
    const type: 'text' | 'image' = msg.type === 'image' ? 'image' : 'text';
    const rawContent = str(msg.content);

    // One budget per visitor identity, shared by all of their tabs / sockets.
    if (att.role === 'visitor' && att.visitor && !this.visitorSendBucket(att.visitor.visitorId).take()) {
      reply({ success: false, error: 'Too many messages, please slow down', code: 'RATE_LIMITED' });
      return;
    }

    if (type === 'text' && !rawContent.trim()) {
      reply({ success: false, error: 'Empty message' });
      return;
    }
    if (rawContent.length > MAX_TEXT_CHARS) {
      reply({ success: false, error: `Message too long (max ${MAX_TEXT_CHARS} characters)`, code: 'TOO_LONG' });
      return;
    }

    // Image messages may only reference files produced by /api/upload (strict key format + upload_files lookup).
    let imageUrl: string | null = null;
    let uploadRoomId: string | null = null;
    if (type === 'image') {
      const rawImageUrl = str(msg.imageUrl).trim();
      const relative = rawImageUrl.replace(/^\/chatuploads\//, '');
      if (!rawImageUrl.startsWith('/chatuploads/') || relative.includes('..') || relative.includes('\\') || !UPLOAD_KEY_PATTERN.test(relative)) {
        reply({ success: false, error: 'Invalid image URL' });
        return;
      }
      const meta = this.store.getUploadMeta(relative);
      if (!meta) {
        reply({ success: false, error: 'Untrusted image URL' });
        return;
      }
      imageUrl = `/chatuploads/${relative}`;
      uploadRoomId = meta.roomId;
    }

    const m: OutgoingMessage = { requestedRoomId, type, content: type === 'image' ? '' : rawContent, imageUrl, uploadRoomId, senderName: str(msg.senderName) };

    if (att.role === 'agent' && att.agent) {
      this.sendAsAgent(att.agent, m, reply);
    } else if (att.role === 'visitor' && att.visitor) {
      this.sendAsVisitor(ws, att.visitor, m, reply);
    } else {
      securityLog('unauthenticated_send', null);
      reply({ success: false, error: 'Unauthenticated' });
    }
  }

  private sendAsAgent(agent: NonNullable<Attachment['agent']>, m: OutgoingMessage, reply: (p: Json) => void) {
    const room = m.requestedRoomId ? this.store.getRoom(m.requestedRoomId) : null;
    if (!room) {
      console.error(`Message rejected: room ${m.requestedRoomId} not found for agent`);
      reply({ success: false, error: 'Room not found' });
      return;
    }

    // The display name comes from the account, never from the client (an agent cannot sign as a colleague).
    const senderName = this.store.getAgentName(agent.agentId) || agent.username;
    this.persistAndBroadcast({ roomId: room.roomId, senderType: 'agent', senderId: agent.agentId, senderName, m }, reply, null);
  }

  private sendAsVisitor(ws: WebSocket, visitor: NonNullable<Attachment['visitor']>, m: OutgoingMessage, reply: (p: Json) => void) {
    const store = this.store;
    let room = null;

    if (m.requestedRoomId) {
      room = store.getOwnedRoom(m.requestedRoomId, visitor.visitorId);
      if (!room) {
        securityLog('visitor_foreign_room_send', null, { visitorId: visitor.visitorId, roomId: m.requestedRoomId });
        reply({ success: false, error: 'Unauthorized room' });
        return;
      }
    }

    // Reconnected clients may not know their room yet: reuse the latest active one.
    if (!room) room = store.getLatestRoomForVisitor(visitor.visitorId, true);

    const trimmedName = m.senderName.trim().slice(0, 80);
    const senderName = !trimmedName || trimmedName === 'Visitor' ? visitor.visitorName || room?.visitorName || '访客' : trimmedName;

    let roomId: string;
    let newRoom: NewRoom | null = null;

    if (!room) {
      try {
        const visitorName = visitor.visitorName || senderName;
        roomId = store.createRoomWithRetry({ visitorId: visitor.visitorId, visitorName, currentPage: visitor.currentPage });
        newRoom = { roomId, visitorId: visitor.visitorId, visitorName, currentPage: visitor.currentPage };
      } catch (err) {
        console.error('Failed to create room for visitor message:', err);
        reply({ success: false, error: 'Room create failed', code: 'ROOM_CREATE_FAILED' });
        return;
      }
    } else {
      roomId = room.roomId;
      const nextName = visitor.visitorName || room.visitorName;
      const nextPage = visitor.currentPage || room.currentPage;
      if (nextName !== room.visitorName || nextPage !== room.currentPage) {
        store.updateRoomVisitor(roomId, nextName, nextPage);
      }
    }

    this.bindVisitorRoom(visitor.visitorId, roomId);
    const fresh = this.getAtt(ws);
    if (fresh.visitor && fresh.visitor.roomId !== roomId) {
      fresh.visitor.roomId = roomId;
      this.setAtt(ws, fresh);
    }

    this.persistAndBroadcast({ roomId, senderType: 'visitor', senderId: visitor.visitorId, senderName, m }, reply, newRoom);
  }

  private persistAndBroadcast(
    p: { roomId: string; senderType: 'visitor' | 'agent'; senderId: string; senderName: string; m: OutgoingMessage },
    reply: (payload: Json) => void,
    newRoom: NewRoom | null
  ) {
    const messageId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const content = p.m.content; // stored as sent (text messages were validated non-empty)

    // An image can only be posted into the room it was uploaded for (no re-using another room's file).
    if (p.m.type === 'image' && p.m.uploadRoomId !== p.roomId) {
      reply({ success: false, error: 'Image does not belong to this room' });
      return;
    }
    try {
      this.store.saveMessage({
        messageId,
        roomId: p.roomId,
        senderType: p.senderType,
        senderId: p.senderId,
        senderName: p.senderName,
        content,
        type: p.m.type,
        imageUrl: p.m.imageUrl,
        timestamp
      });
    } catch (err) {
      console.error('Failed to save message:', err);
      reply({ success: false, error: 'Database error' });
      return;
    }

    const broadcast = {
      messageId,
      roomId: p.roomId,
      senderType: p.senderType,
      senderId: p.senderId,
      senderName: p.senderName,
      content,
      type: p.m.type,
      imageUrl: p.m.imageUrl,
      timestamp
    };

    this.emitToRoom(p.roomId, 'new-message', broadcast);
    this.emitToRoom(p.roomId, 'receive-message', broadcast);
    this.requestRoomListBroadcast();

    if (newRoom) {
      for (const ws of this.agentSockets()) this.emit(ws, 'new-visitor', newRoom);
    }

    if (p.senderType === 'visitor' && this.shouldPush(p.roomId)) {
      const preview = (content || '[图片]').slice(0, BARK_PREVIEW_CHARS);
      this.ctx.waitUntil(sendBark(this.env, '新访客消息', `${p.senderName}: ${preview}`, '客服消息'));
    }

    reply({ success: true, messageId, timestamp, roomId: p.roomId });
  }

  // At most one push notification per room every BARK_MIN_INTERVAL_MS (the unread badge / sound cover the rest).
  private shouldPush(roomId: string): boolean {
    const now = Date.now();
    const last = this.lastBark.get(roomId) ?? 0;
    if (now - last < BARK_MIN_INTERVAL_MS) return false;
    this.lastBark.set(roomId, now);
    if (this.lastBark.size > 2000) {
      for (const [key, ts] of this.lastBark) if (now - ts > BARK_MIN_INTERVAL_MS) this.lastBark.delete(key);
    }
    return true;
  }

  private visitorSendBucket(visitorId: string): Bucket {
    let bucket = this.visitorSendBuckets.get(visitorId);
    if (!bucket) {
      if (this.visitorSendBuckets.size > 5000) {
        const cutoff = Date.now() - 10 * 60 * 1000;
        for (const [key, b] of this.visitorSendBuckets) if (b.last < cutoff) this.visitorSendBuckets.delete(key);
      }
      bucket = new Bucket(10, 0.5);
      this.visitorSendBuckets.set(visitorId, bucket);
    }
    return bucket;
  }
}

interface OutgoingMessage {
  requestedRoomId: string;
  type: 'text' | 'image';
  content: string;
  imageUrl: string | null;
  uploadRoomId: string | null;
  senderName: string;
}
