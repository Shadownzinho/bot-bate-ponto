const Database = require('better-sqlite3');

const db = new Database('ponto.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS pontos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  voice_channel_id TEXT,
  voice_channel_name TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_seconds INTEGER,
  closed_reason TEXT,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE INDEX IF NOT EXISTS idx_pontos_user_guild
ON pontos (guild_id, user_id);

CREATE INDEX IF NOT EXISTS idx_pontos_open
ON pontos (guild_id, user_id, status);

CREATE INDEX IF NOT EXISTS idx_pontos_period
ON pontos (guild_id, user_id, started_at, ended_at);

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  panel_channel_id TEXT,
  data_channel_id TEXT,
  admin_role_id TEXT,
  afk_channel_id TEXT,
  allowed_voice_channel_ids TEXT,
  voice_grace_seconds INTEGER,
  public_close_seconds INTEGER,
  updated_at INTEGER NOT NULL
);
`);


// Migração leve para versões antigas do banco.
const settingsColumns = db
  .prepare(`PRAGMA table_info(guild_settings)`)
  .all()
  .map(col => col.name);

const missingGuildSettingColumns = [
  ['data_channel_id', 'TEXT'],
  ['admin_role_id', 'TEXT'],
  ['afk_channel_id', 'TEXT'],
  ['allowed_voice_channel_ids', 'TEXT'],
  ['voice_grace_seconds', 'INTEGER'],
  ['public_close_seconds', 'INTEGER']
];

for (const [name, type] of missingGuildSettingColumns) {
  if (settingsColumns.length > 0 && !settingsColumns.includes(name)) {
    db.exec(`ALTER TABLE guild_settings ADD COLUMN ${name} ${type}`);
  }
}


function getOpenPoint(guildId, userId) {
  return db.prepare(`
    SELECT * FROM pontos
    WHERE guild_id = ? AND user_id = ? AND status = 'open'
    ORDER BY id DESC
    LIMIT 1
  `).get(guildId, userId);
}

function startPoint({ guildId, userId, username, voiceChannelId, voiceChannelName }) {
  const existing = getOpenPoint(guildId, userId);
  if (existing) return { ok: false, reason: 'already_open', point: existing };

  const startedAt = Date.now();

  const info = db.prepare(`
    INSERT INTO pontos (
      guild_id, user_id, username,
      voice_channel_id, voice_channel_name,
      started_at, status
    )
    VALUES (?, ?, ?, ?, ?, ?, 'open')
  `).run(
    guildId,
    userId,
    username,
    voiceChannelId,
    voiceChannelName,
    startedAt
  );

  return {
    ok: true,
    point: db.prepare(`SELECT * FROM pontos WHERE id = ?`).get(info.lastInsertRowid)
  };
}

function closePoint({
  guildId,
  userId,
  reason = 'manual',
  endedAt = Date.now()
}) {
  const point = getOpenPoint(guildId, userId);
  if (!point) return { ok: false, reason: 'not_open' };

  endedAt = Math.max(point.started_at, Number(endedAt) || Date.now());

  const durationSeconds = Math.max(
    0,
    Math.floor((endedAt - point.started_at) / 1000)
  );

  db.prepare(`
    UPDATE pontos
    SET ended_at = ?,
        duration_seconds = ?,
        closed_reason = ?,
        status = 'closed'
    WHERE id = ?
  `).run(endedAt, durationSeconds, reason, point.id);

  return {
    ok: true,
    point: db.prepare(`SELECT * FROM pontos WHERE id = ?`).get(point.id)
  };
}

function getAllOpenPoints(guildId) {
  return db.prepare(`
    SELECT * FROM pontos
    WHERE guild_id = ? AND status = 'open'
    ORDER BY started_at ASC
  `).all(guildId);
}

function getUserHistory(guildId, userId, limit = 20) {
  return db.prepare(`
    SELECT * FROM pontos
    WHERE guild_id = ? AND user_id = ?
    ORDER BY started_at DESC
    LIMIT ?
  `).all(guildId, userId, limit);
}

function getClosedPointsInRange(guildId, userId, startMs, endMs) {
  return db.prepare(`
    SELECT * FROM pontos
    WHERE guild_id = ?
      AND user_id = ?
      AND status = 'closed'
      AND ended_at IS NOT NULL
      AND ended_at > ?
      AND started_at < ?
    ORDER BY started_at ASC
  `).all(guildId, userId, startMs, endMs);
}


function ensureGuildSettings(guildId) {
  db.prepare(`
    INSERT INTO guild_settings (guild_id, updated_at)
    VALUES (?, ?)
    ON CONFLICT(guild_id) DO NOTHING
  `).run(guildId, Date.now());
}

function getGuildSettings(guildId) {
  const row = db.prepare(`
    SELECT *
    FROM guild_settings
    WHERE guild_id = ?
  `).get(guildId);

  if (!row) {
    return {
      guild_id: guildId,
      panel_channel_id: null,
      data_channel_id: null,
      admin_role_id: null,
      afk_channel_id: null,
      allowed_voice_channel_ids: null,
      voice_grace_seconds: null,
      public_close_seconds: null,
      updated_at: null
    };
  }

  let allowed = null;

  if (row.allowed_voice_channel_ids !== null && row.allowed_voice_channel_ids !== undefined) {
    try {
      const parsed = JSON.parse(row.allowed_voice_channel_ids);
      allowed = Array.isArray(parsed)
        ? parsed.map(String).filter(Boolean)
        : [];
    } catch {
      allowed = String(row.allowed_voice_channel_ids)
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);
    }
  }

  return {
    ...row,
    allowed_voice_channel_ids: allowed
  };
}

function setGuildSetting(guildId, column, value) {
  const allowedColumns = new Set([
    'panel_channel_id',
    'data_channel_id',
    'admin_role_id',
    'afk_channel_id',
    'allowed_voice_channel_ids',
    'voice_grace_seconds',
    'public_close_seconds'
  ]);

  if (!allowedColumns.has(column)) {
    throw new Error(`Configuração inválida: ${column}`);
  }

  ensureGuildSettings(guildId);

  db.prepare(`
    UPDATE guild_settings
    SET ${column} = ?, updated_at = ?
    WHERE guild_id = ?
  `).run(value, Date.now(), guildId);
}

function setAdminRole(guildId, roleId) {
  setGuildSetting(guildId, 'admin_role_id', roleId || null);
}

function setAfkChannel(guildId, channelId) {
  setGuildSetting(guildId, 'afk_channel_id', channelId || null);
}

function setAllowedVoiceChannels(guildId, channelIds) {
  const unique = [...new Set((channelIds || []).map(String).filter(Boolean))];
  setGuildSetting(guildId, 'allowed_voice_channel_ids', JSON.stringify(unique));
}

function addAllowedVoiceChannel(guildId, channelId) {
  const settings = getGuildSettings(guildId);
  const current = settings.allowed_voice_channel_ids || [];

  if (current.includes(channelId)) return false;

  setAllowedVoiceChannels(guildId, [...current, channelId]);
  return true;
}

function removeAllowedVoiceChannel(guildId, channelId) {
  const settings = getGuildSettings(guildId);
  const current = settings.allowed_voice_channel_ids || [];

  if (!current.includes(channelId)) return false;

  setAllowedVoiceChannels(
    guildId,
    current.filter(id => id !== channelId)
  );
  return true;
}

function setVoiceGraceSeconds(guildId, seconds) {
  setGuildSetting(guildId, 'voice_grace_seconds', Number(seconds));
}

function setPublicCloseSeconds(guildId, seconds) {
  setGuildSetting(guildId, 'public_close_seconds', Number(seconds));
}

function setPanelChannel(guildId, channelId) {
  setGuildSetting(guildId, 'panel_channel_id', channelId || null);
}

function getPanelChannel(guildId) {
  return db.prepare(`
    SELECT panel_channel_id
    FROM guild_settings
    WHERE guild_id = ?
  `).get(guildId)?.panel_channel_id || null;
}


function setDataChannel(guildId, channelId) {
  setGuildSetting(guildId, 'data_channel_id', channelId || null);
}

function getDataChannel(guildId) {
  return db.prepare(`
    SELECT data_channel_id
    FROM guild_settings
    WHERE guild_id = ?
  `).get(guildId)?.data_channel_id || null;
}

function getUserLifetimeStats(guildId, userId) {
  const closed = db.prepare(`
    SELECT
      COUNT(*) AS closed_count,
      COALESCE(SUM(duration_seconds), 0) AS total_seconds,
      MIN(started_at) AS first_started_at,
      MAX(ended_at) AS last_ended_at
    FROM pontos
    WHERE guild_id = ?
      AND user_id = ?
      AND status = 'closed'
  `).get(guildId, userId);

  const all = db.prepare(`
    SELECT
      COUNT(*) AS total_count,
      MIN(started_at) AS first_any_started_at
    FROM pontos
    WHERE guild_id = ?
      AND user_id = ?
  `).get(guildId, userId);

  const open = getOpenPoint(guildId, userId);

  return {
    closed_count: Number(closed.closed_count || 0),
    total_seconds: Number(closed.total_seconds || 0),
    first_started_at:
      closed.first_started_at ||
      all.first_any_started_at ||
      null,
    last_ended_at: closed.last_ended_at || null,
    total_count: Number(all.total_count || 0),
    open
  };
}

function getServerLifetimeStats(guildId) {
  const closed = db.prepare(`
    SELECT
      COUNT(*) AS closed_count,
      COUNT(DISTINCT user_id) AS users_count,
      COALESCE(SUM(duration_seconds), 0) AS total_seconds,
      MIN(started_at) AS first_started_at,
      MAX(ended_at) AS last_ended_at
    FROM pontos
    WHERE guild_id = ?
      AND status = 'closed'
  `).get(guildId);

  const open = db.prepare(`
    SELECT COUNT(*) AS open_count
    FROM pontos
    WHERE guild_id = ?
      AND status = 'open'
  `).get(guildId);

  return {
    closed_count: Number(closed.closed_count || 0),
    users_count: Number(closed.users_count || 0),
    total_seconds: Number(closed.total_seconds || 0),
    first_started_at: closed.first_started_at || null,
    last_ended_at: closed.last_ended_at || null,
    open_count: Number(open.open_count || 0)
  };
}

function getPointsFiltered({
  guildId,
  userId = null,
  status = null,
  startMs = null,
  endMs = null,
  limit = 25
}) {
  const where = [`guild_id = ?`];
  const params = [guildId];

  if (userId) {
    where.push(`user_id = ?`);
    params.push(userId);
  }

  if (status) {
    where.push(`status = ?`);
    params.push(status);
  }

  if (startMs !== null) {
    // Um ponto fechado entra no período se terminou depois do começo.
    // Um ponto aberto entra se começou depois do começo.
    where.push(`
      (
        (ended_at IS NOT NULL AND ended_at >= ?)
        OR
        (ended_at IS NULL AND started_at >= ?)
      )
    `);
    params.push(startMs, startMs);
  }

  if (endMs !== null) {
    where.push(`started_at < ?`);
    params.push(endMs);
  }

  params.push(limit);

  return db.prepare(`
    SELECT *
    FROM pontos
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE WHEN status = 'open' THEN 0 ELSE 1 END,
      started_at DESC
    LIMIT ?
  `).all(...params);
}

function countPointsFiltered({
  guildId,
  userId = null,
  status = null,
  startMs = null,
  endMs = null
}) {
  const where = [`guild_id = ?`];
  const params = [guildId];

  if (userId) {
    where.push(`user_id = ?`);
    params.push(userId);
  }

  if (status) {
    where.push(`status = ?`);
    params.push(status);
  }

  if (startMs !== null) {
    where.push(`
      (
        (ended_at IS NOT NULL AND ended_at >= ?)
        OR
        (ended_at IS NULL AND started_at >= ?)
      )
    `);
    params.push(startMs, startMs);
  }

  if (endMs !== null) {
    where.push(`started_at < ?`);
    params.push(endMs);
  }

  return Number(
    db.prepare(`
      SELECT COUNT(*) AS total
      FROM pontos
      WHERE ${where.join(' AND ')}
    `).get(...params).total || 0
  );
}

function getClosedSecondsInRange({
  guildId,
  userId,
  startMs = null,
  endMs = null
}) {
  const where = [
    `guild_id = ?`,
    `user_id = ?`,
    `status = 'closed'`,
    `ended_at IS NOT NULL`
  ];
  const params = [guildId, userId];

  if (startMs !== null) {
    where.push(`ended_at >= ?`);
    params.push(startMs);
  }

  if (endMs !== null) {
    where.push(`started_at < ?`);
    params.push(endMs);
  }

  const rows = db.prepare(`
    SELECT started_at, ended_at
    FROM pontos
    WHERE ${where.join(' AND ')}
  `).all(...params);

  let total = 0;

  for (const point of rows) {
    const clippedStart =
      startMs !== null
        ? Math.max(point.started_at, startMs)
        : point.started_at;

    const clippedEnd =
      endMs !== null
        ? Math.min(point.ended_at, endMs)
        : point.ended_at;

    if (clippedEnd > clippedStart) {
      total += Math.floor((clippedEnd - clippedStart) / 1000);
    }
  }

  return total;
}

module.exports = {
  db,
  getOpenPoint,
  getAllOpenPoints,
  startPoint,
  closePoint,
  getUserHistory,
  getClosedPointsInRange,
  setPanelChannel,
  getPanelChannel,
  setDataChannel,
  getDataChannel,
  ensureGuildSettings,
  getGuildSettings,
  setAdminRole,
  setAfkChannel,
  setAllowedVoiceChannels,
  addAllowedVoiceChannel,
  removeAllowedVoiceChannel,
  setVoiceGraceSeconds,
  setPublicCloseSeconds,
  getUserLifetimeStats,
  getServerLifetimeStats,
  getPointsFiltered,
  countPointsFiltered,
  getClosedSecondsInRange
};
