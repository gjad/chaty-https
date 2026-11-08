import type { ChatHub } from './hub';
import type { RateLimiter } from './rate-limiter';

export interface Env {
  UPLOADS: R2Bucket;
  HUB: DurableObjectNamespace<ChatHub>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;

  // secrets
  JWT_SECRET: string;
  COOKIE_SECRET?: string;
  GOOGLE_TRANSLATE_API_KEY?: string;
  BARK_URLS?: string;
  // Enables /api/admin/* (agent creation, bulk import from the self-hosted database). Leave unset to disable.
  ADMIN_TOKEN?: string;
  // Cloudflare Turnstile secret for the agent login page. Unset = server-side check skipped.
  TURNSTILE_SECRET?: string;

  // vars
  APP_VERSION: string;
  APP_URL?: string;
  // Sites allowed to use the embed widget (comma separated, see lib/origin.ts). Empty = nobody (fail closed).
  ALLOWED_ORIGINS?: string;
  // Local development only: "true" disables every Origin check.
  ALLOW_ANY_ORIGIN?: string;
  BARK_ENABLED?: string;
  HUB_LOCATION_HINT?: string;
}

export type DeviceType = 'pc' | 'mobile';

export interface AuditEntry {
  actorType: 'agent' | 'admin' | 'visitor' | 'system';
  actorId?: string | null;
  action: string;
  result: 'ok' | 'fail';
  ip?: string | null;
  country?: string | null;
  ua?: string | null;
  target?: string | null;
  detail?: string | null;
}

export interface AuditRow extends AuditEntry {
  id: number;
  ts: string;
  actorName?: string | null;
}

export interface AgentIdentity {
  agentId: string;
  username: string;
}

export interface RoomRow {
  roomId: string;
  visitorId: string;
  visitorName: string | null;
  currentPage: string | null;
  createdAt: string;
  isActive: number;
  status: 'active' | 'done';
  doneAt: string | null;
}

export interface MessageRow {
  messageId: string;
  roomId: string;
  senderType: 'visitor' | 'agent';
  senderId: string;
  senderName: string | null;
  content: string | null;
  type: 'text' | 'image';
  imageUrl: string | null;
  isRead: number;
  timestamp: string;
}

export const cookieSecret = (env: Env): string => env.COOKIE_SECRET || env.JWT_SECRET;
