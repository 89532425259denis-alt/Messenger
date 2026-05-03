-- DEVO+ messenger schema (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  avatar_key    TEXT,
  bio           TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('direct','group')),
  title       TEXT,
  avatar_key  TEXT,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  last_message_id TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id   TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  joined_at INTEGER NOT NULL,
  last_read_message_id TEXT,
  PRIMARY KEY (chat_id, user_id),
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  chat_id      TEXT NOT NULL,
  sender_id    TEXT NOT NULL,
  body         TEXT,
  kind         TEXT NOT NULL DEFAULT 'text'
                  CHECK (kind IN ('text','image','file','voice','system')),
  attachment_key  TEXT,
  attachment_meta TEXT,
  reply_to_id  TEXT,
  edited_at    INTEGER,
  deleted_at   INTEGER,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (chat_id)   REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);

CREATE TABLE IF NOT EXISTS contacts (
  user_id    TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, contact_id),
  FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Read-receipt aggregation: who has read up to which message in each chat.
CREATE TABLE IF NOT EXISTS read_state (
  chat_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id),
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
