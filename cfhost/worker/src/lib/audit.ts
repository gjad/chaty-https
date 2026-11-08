// Audit trail writer: appends one row to the ChatHub's audit_log table. Runs after the response via waitUntil
// and never throws, so a logging problem can not break login or any other feature.
import type { Context } from 'hono';
import type { AppEnv } from './auth';
import type { AuditEntry } from '../types';
import { getHub } from './access';
import { requestInfo } from './log';

export type AuditInput = Omit<AuditEntry, 'ip' | 'country' | 'ua'>;

const clip = (value: string | null | undefined, max: number): string | null => (value ? value.slice(0, max) : null);

export function recordAudit(c: Context<AppEnv>, entry: AuditInput): void {
  const info = requestInfo(c.req.raw);
  const record: AuditEntry = {
    ...entry,
    actorId: clip(entry.actorId, 100),
    target: clip(entry.target, 200),
    detail: clip(entry.detail, 500),
    ip: info.ip,
    country: info.country ?? null,
    ua: info.ua ?? null
  };
  const env = c.env;
  c.executionCtx.waitUntil(
    (async () => {
      try {
        await getHub(env).audit(record);
      } catch (err) {
        console.error('Audit write failed:', err instanceof Error ? err.message : err);
      }
    })()
  );
}
