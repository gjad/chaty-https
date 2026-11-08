// Schema for the ChatHub Durable Object's built-in SQLite database.
// Append new migrations to the END of the list; applied versions are tracked in `_schema`.
// Each migration is a list of single statements (executed inside one transaction).
//
// Note: no FOREIGN KEY constraints on purpose - the app enforces relations, which keeps
// bulk imports (see /api/admin/import) independent of insertion order.

export const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE agents (
      agentId TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      passwordHash TEXT NOT NULL,
      name TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE rooms (
      roomId TEXT PRIMARY KEY,
      visitorId TEXT NOT NULL,
      visitorName TEXT,
      currentPage TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      isActive BOOLEAN DEFAULT 1,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'done')),
      doneAt DATETIME
    )`,
    `CREATE TABLE messages (
      messageId TEXT PRIMARY KEY,
      roomId TEXT NOT NULL,
      senderType TEXT CHECK(senderType IN ('visitor', 'agent')) NOT NULL,
      senderId TEXT NOT NULL,
      senderName TEXT,
      content TEXT,
      type TEXT CHECK(type IN ('text', 'image')) DEFAULT 'text',
      imageUrl TEXT,
      isRead BOOLEAN DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE room_reads (
      userId TEXT NOT NULL,
      roomId TEXT NOT NULL,
      lastReadTimestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (userId, roomId)
    )`,
    `CREATE TABLE agent_sessions (
      sessionId TEXT PRIMARY KEY,
      agentId TEXT NOT NULL,
      deviceType TEXT NOT NULL CHECK(deviceType IN ('pc', 'mobile')),
      userAgent TEXT,
      lastActiveAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE upload_files (
      filename TEXT PRIMARY KEY,
      roomId TEXT NOT NULL,
      uploaderType TEXT CHECK(uploaderType IN ('visitor', 'agent')) NOT NULL,
      uploaderId TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE knowledge_entries (
      entryId INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      categoryOrder INTEGER DEFAULT 0,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      sortOrder INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    // messages(roomId, timestamp) serves history paging, last-message lookups and unread counts.
    `CREATE INDEX idx_messages_room_ts ON messages(roomId, timestamp)`,
    `CREATE INDEX idx_rooms_visitor ON rooms(visitorId, createdAt)`,
    `CREATE INDEX idx_rooms_list ON rooms(isActive, status, doneAt)`,
    `CREATE INDEX idx_upload_files_room ON upload_files(roomId)`,
    `CREATE INDEX idx_agent_sessions_agent ON agent_sessions(agentId, deviceType)`,
    `CREATE INDEX idx_knowledge_category ON knowledge_entries(category, sortOrder, entryId)`
  ],
  // v2: small key/value table (knowledge-base version for optimistic locking) and one timestamp format.
  // Older rows were written with CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS"); everything is compared as plain
  // strings, so they are rewritten to ISO-8601 ("YYYY-MM-DDTHH:MM:SS.sssZ"). All new writes are ISO already.
  [
    `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `INSERT OR IGNORE INTO meta (key, value) VALUES ('knowledge_version', '0')`,
    ...[
      ['rooms', 'createdAt'],
      ['rooms', 'doneAt'],
      ['messages', 'timestamp'],
      ['room_reads', 'lastReadTimestamp'],
      ['agent_sessions', 'lastActiveAt'],
      ['agent_sessions', 'createdAt'],
      ['upload_files', 'createdAt']
    ].map(
      ([table, column]) =>
        `UPDATE ${table} SET ${column} = strftime('%Y-%m-%dT%H:%M:%fZ', ${column})
         WHERE ${column} IS NOT NULL AND ${column} NOT LIKE '%T%' AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS NOT NULL`
    )
  ],
  // v3: append-only audit trail (logins, password changes, knowledge-base edits, admin calls). Capped by the store.
  [
    `CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      actorType TEXT NOT NULL,
      actorId TEXT,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      ip TEXT,
      country TEXT,
      ua TEXT,
      target TEXT,
      detail TEXT
    )`,
    `CREATE INDEX idx_audit_ts ON audit_log(ts)`,
    `CREATE INDEX idx_audit_action ON audit_log(action, id)`,
    `CREATE INDEX idx_audit_actor ON audit_log(actorId, id)`
  ]
];

export function migrate(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS _schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)');
  const row = sql.exec('SELECT version FROM _schema WHERE id = 1').toArray()[0];
  const current = row ? Number(row.version) : 0;

  for (let i = current; i < MIGRATIONS.length; i += 1) {
    storage.transactionSync(() => {
      for (const statement of MIGRATIONS[i]) sql.exec(statement);
      sql.exec('INSERT INTO _schema (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version', i + 1);
    });
  }
}
