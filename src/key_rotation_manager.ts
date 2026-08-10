// =============================================================================
// key_rotation_manager.ts — Durable Object for global key round-robin
// =============================================================================

import { DurableObject } from "cloudflare:workers";

export class KeyRotationManager extends DurableObject {
  async getNextIndex(keyName: string, length: number): Promise<number> {
    if (length <= 1) return 0;

    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS counters (key_name TEXT PRIMARY KEY, idx INTEGER NOT NULL DEFAULT 0)`);

    const row = sql.exec<{ idx: number }>("SELECT idx FROM counters WHERE key_name = ?", keyName).next().value;
    const cur = row ? Math.min(row.idx, length - 1) : 0;

    if (!row) sql.exec("INSERT INTO counters VALUES (?, 0)", keyName);

    const next = (cur + 1) % length;
    sql.exec("UPDATE counters SET idx = ? WHERE key_name = ?", next, keyName);

    return cur;
  }
}
