require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  AuditLogEvent,
  REST,
  Routes
} = require('discord.js');

const {
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
} = require('./database');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

// As configurações abaixo do .env ficam apenas como compatibilidade com
// o servidor antigo. Novos servidores usam configurações próprias no SQLite.
const LEGACY_GUILD_ID = (process.env.GUILD_ID || '').trim();
const LEGACY_ADMIN_ROLE_ID = (process.env.ADMIN_ROLE_ID || '').trim();
const LEGACY_PONTO_CHANNEL_ID = (process.env.PONTO_CHANNEL_ID || '').trim();
const LEGACY_AFK_CHANNEL_ID = (process.env.AFK_CHANNEL_ID || '').trim();
const LEGACY_ALLOWED_VOICE_CHANNEL_IDS = (process.env.ALLOWED_VOICE_CHANNEL_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

const DEFAULT_VOICE_GRACE_SECONDS = Math.max(
  5,
  Number(process.env.VOICE_GRACE_SECONDS || 60)
);

const DEFAULT_PUBLIC_CLOSE_SECONDS = Math.max(
  10,
  Number(process.env.PUBLIC_CLOSE_SECONDS || 40)
);

// O aviso de início é temporário para não poluir o canal de ponto.
const START_NOTICE_SECONDS = 30;

if (!TOKEN || !CLIENT_ID) {
  console.error('❌ Preencha DISCORD_TOKEN e CLIENT_ID no arquivo .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

const activeStartInteractions = new Map();

// Mensagens públicas temporárias de "Ponto iniciado".
const activePublicStartMessages = new Map();

// Usuários fora das calls permitidas, mas ainda dentro dos 40s de tolerância.
const pendingVoiceLeaves = new Map();

// Ações recentes de ADM vistas no audit log.
// Usadas como melhor tentativa de correlacionar "desconectar/mover membro"
// com o VoiceStateUpdate.
const recentAdminVoiceActions = new Map();

function pointKey(guildId, userId) {
  return `${guildId}:${userId}`;
}


function getActivePublicStartMessage(guildId, userId) {
  return activePublicStartMessages.get(pointKey(guildId, userId)) || null;
}

function clearActivePublicStartMessage(guildId, userId) {
  const key = pointKey(guildId, userId);
  const current = activePublicStartMessages.get(key);
  if (current?.deleteTimer) clearTimeout(current.deleteTimer);
  activePublicStartMessages.delete(key);
}

async function deleteActivePublicStartMessage(guildId, userId) {
  const key = pointKey(guildId, userId);
  const current = activePublicStartMessages.get(key);
  if (!current?.message) {
    activePublicStartMessages.delete(key);
    return false;
  }

  if (current.deleteTimer) clearTimeout(current.deleteTimer);

  try {
    await current.message.delete().catch(() => {});
  } finally {
    activePublicStartMessages.delete(key);
  }

  return true;
}

function scheduleDeleteActivePublicStartMessage(guildId, userId, seconds) {
  const key = pointKey(guildId, userId);
  const current = activePublicStartMessages.get(key);
  if (!current?.message) return false;

  if (current.deleteTimer) clearTimeout(current.deleteTimer);

  current.deleteTimer = setTimeout(() => {
    current.message.delete().catch(() => {});
    activePublicStartMessages.delete(key);
  }, Math.max(1, seconds) * 1000);

  activePublicStartMessages.set(key, current);
  return true;
}

function fmtDuration(totalSeconds = 0) {
  totalSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}min`;
  if (minutes > 0) return `${minutes}min ${seconds}s`;
  return `${seconds}s`;
}

function fmtDate(ms) {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo'
  }).format(new Date(ms));
}

function fmtDay(ms) {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo'
  }).format(new Date(ms));
}

function getSaoPauloParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  }).formatToParts(date);

  const out = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

function localMidnightMs(year, month1Based, day) {
  return Date.UTC(year, month1Based - 1, day, 3, 0, 0, 0);
}

function normalizeYearMonth(year, month1Based) {
  const d = new Date(Date.UTC(year, month1Based - 1, 1, 12, 0, 0));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1
  };
}

function makeWeek(year, month, day) {
  // Descobre o dia da semana usando apenas a data do calendário local.
  // getUTCDay(): 0=domingo, 1=segunda, ..., 6=sábado.
  const calendarDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const daysSinceMonday = (calendarDate.getUTCDay() + 6) % 7;

  const monday = new Date(
    Date.UTC(year, month - 1, day - daysSinceMonday, 12, 0, 0)
  );
  const nextMonday = new Date(
    Date.UTC(
      monday.getUTCFullYear(),
      monday.getUTCMonth(),
      monday.getUTCDate() + 7,
      12,
      0,
      0
    )
  );

  return {
    startMs: localMidnightMs(
      monday.getUTCFullYear(),
      monday.getUTCMonth() + 1,
      monday.getUTCDate()
    ),
    endMs: localMidnightMs(
      nextMonday.getUTCFullYear(),
      nextMonday.getUTCMonth() + 1,
      nextMonday.getUTCDate()
    )
  };
}

function currentWeek() {
  const now = getSaoPauloParts();
  return makeWeek(now.year, now.month, now.day);
}

function previousWeek(period) {
  const previousDay = new Date(period.startMs - 24 * 60 * 60 * 1000);
  const parts = getSaoPauloParts(previousDay);
  return makeWeek(parts.year, parts.month, parts.day);
}

function buildWeekList(count = 12) {
  const periods = [];
  let current = currentWeek();

  for (let i = 0; i < count; i++) {
    periods.push(current);
    current = previousWeek(current);
  }

  return periods;
}

function periodLabel(period) {
  return `${fmtDay(period.startMs)} até ${fmtDay(period.endMs - 1000)}`;
}

function encodePeriod(period) {
  return `${period.startMs}:${period.endMs}`;
}

function decodePeriod(value) {
  const [start, end] = String(value).split(':').map(Number);

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }

  return {
    startMs: start,
    endMs: end
  };
}

function secondsInsidePeriod(point, startMs, endMs) {
  if (!point.ended_at) return 0;

  const clippedStart = Math.max(point.started_at, startMs);
  const clippedEnd = Math.min(point.ended_at, endMs);

  if (clippedEnd <= clippedStart) return 0;

  return Math.floor((clippedEnd - clippedStart) / 1000);
}

function reasonLabel(reason) {
  if (reason === 'left_voice') return 'Saiu da call autorizada';
  if (reason === 'admin_voice_action') return 'Entrou na call AFK';
  if (reason === 'afk_voice') return 'Entrou na call AFK';
  if (reason === 'unauthorized_voice') return 'Entrou em call não autorizada';
  if (reason === 'manual') return 'Encerrado manualmente';
  return reason || 'Encerrado';
}

function getGuildConfig(guildId) {
  const saved = getGuildSettings(guildId);

  return {
    adminRoleId: saved.admin_role_id || null,
    afkChannelId: saved.afk_channel_id || null,
    allowedVoiceChannelIds: new Set(saved.allowed_voice_channel_ids || []),
    voiceGraceSeconds: Math.max(
      5,
      Number(saved.voice_grace_seconds ?? DEFAULT_VOICE_GRACE_SECONDS)
    ),
    publicCloseSeconds: Math.max(
      10,
      Number(saved.public_close_seconds ?? DEFAULT_PUBLIC_CLOSE_SECONDS)
    )
  };
}

function isAdmin(member) {
  if (member?.permissions?.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const guildId = member?.guild?.id;
  if (!guildId) return false;

  const { adminRoleId } = getGuildConfig(guildId);

  return Boolean(
    adminRoleId &&
    member?.roles?.cache?.has(adminRoleId)
  );
}

function isAllowedVoiceChannel(guildId, channelId) {
  if (!guildId || !channelId) return false;

  const { allowedVoiceChannelIds } = getGuildConfig(guildId);
  return allowedVoiceChannelIds.has(channelId);
}

function getVoiceGraceSeconds(guildId) {
  return getGuildConfig(guildId).voiceGraceSeconds;
}

function getPublicCloseSeconds(guildId) {
  return getGuildConfig(guildId).publicCloseSeconds;
}

function migrateLegacyEnvSettings() {
  if (!LEGACY_GUILD_ID) return;

  const saved = getGuildSettings(LEGACY_GUILD_ID);

  if (!saved.admin_role_id && LEGACY_ADMIN_ROLE_ID) {
    setAdminRole(LEGACY_GUILD_ID, LEGACY_ADMIN_ROLE_ID);
  }

  if (!saved.afk_channel_id && LEGACY_AFK_CHANNEL_ID) {
    setAfkChannel(LEGACY_GUILD_ID, LEGACY_AFK_CHANNEL_ID);
  }

  if (saved.allowed_voice_channel_ids === null) {
    setAllowedVoiceChannels(
      LEGACY_GUILD_ID,
      LEGACY_ALLOWED_VOICE_CHANNEL_IDS.filter(
        id => !LEGACY_AFK_CHANNEL_ID || id !== LEGACY_AFK_CHANNEL_ID
      )
    );
  }

  if (saved.voice_grace_seconds === null) {
    setVoiceGraceSeconds(
      LEGACY_GUILD_ID,
      DEFAULT_VOICE_GRACE_SECONDS
    );
  }

  if (saved.public_close_seconds === null) {
    setPublicCloseSeconds(
      LEGACY_GUILD_ID,
      DEFAULT_PUBLIC_CLOSE_SECONDS
    );
  }

  if (!getPanelChannel(LEGACY_GUILD_ID) && LEGACY_PONTO_CHANNEL_ID) {
    setPanelChannel(LEGACY_GUILD_ID, LEGACY_PONTO_CHANNEL_ID);
  }
}

function buildPanelEmbed(guildId) {
  const config = getGuildConfig(guildId);
  const allowedCount = config.allowedVoiceChannelIds.size;
  const allowedText =
    allowedCount > 0
      ? `${allowedCount} call(s) autorizada(s)`
      : 'Nenhuma call autorizada configurada';

  return new EmbedBuilder()
    .setDescription(
      [
        '**O ponto inicia automaticamente ao entrar em uma call autorizada.**',
        '',
        `🔊 **Calls:** ${allowedText}`,
        `⏳ **Tolerância ao sair:** ${config.voiceGraceSeconds}s`,
        '📢 Ao sair da call, o aviso aparece publicamente neste canal.',
        '🟢 O botão Iniciar continua disponível como alternativa manual.',
        '🚪 Se voltar para uma call autorizada dentro da tolerância, o ponto continua.',
        '💤 AFK/call não autorizada encerra o ponto imediatamente.',
        '📁 Seu histórico é privado e separado por semana.'
      ].join('\n')
    )
    .setImage('attachment://painel.png')
    .setFooter({ text: 'Sistema de Ponto' });
}

function buildPanelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ponto_iniciar')
      .setLabel('Iniciar')
      .setEmoji('🟢')
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId('ponto_fechar')
      .setLabel('Terminar')
      .setEmoji('🔴')
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId('ponto_meu_historico')
      .setLabel('Meu histórico')
      .setEmoji('📁')
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId('ponto_info')
      .setLabel('Ver informações')
      .setEmoji('ℹ️')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('ponto_admin_historico')
      .setLabel('Histórico ADM')
      .setEmoji('🛡️')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildPeriodMenu(customId, selectedValue = null) {
  const periods = buildWeekList(12);

  const options = periods.map((period, index) => ({
    label:
      index === 0
        ? `Atual • ${periodLabel(period)}`
        : periodLabel(period),
    value: encodePeriod(period),
    description:
      index === 0
        ? 'Semana atual • segunda a domingo'
        : 'Semana completa • segunda a domingo',
    default: selectedValue === encodePeriod(period)
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Escolha a semana')
      .addOptions(options)
  );
}

function buildHistoryEmbed({
  guildId,
  userId,
  username,
  startMs,
  endMs,
  adminView = false
}) {
  const points = getClosedPointsInRange(
    guildId,
    userId,
    startMs,
    endMs
  );

  let totalSeconds = 0;

  const allLines = points.map((p, index) => {
    const seconds = secondsInsidePeriod(p, startMs, endMs);
    totalSeconds += seconds;

    return (
      `${index + 1}. **${fmtDate(p.started_at)}** → ` +
      `**${fmtDate(p.ended_at)}**\n` +
      `   ⏱️ ${fmtDuration(seconds)} • ` +
      `${p.voice_channel_name || 'Call não registrada'} • ` +
      `${reasonLabel(p.closed_reason)}`
    );
  });

  const visibleLines = allLines.slice(0, 18);

  if (allLines.length > visibleLines.length) {
    visibleLines.push(
      `… e mais ${allLines.length - visibleLines.length} registro(s).`
    );
  }

  return new EmbedBuilder()
    .setTitle(
      adminView
        ? `🛡️ Histórico de ponto — ${username}`
        : '📁 Meu histórico de ponto'
    )
    .setDescription(
      [
        `📅 **Período:** ${fmtDay(startMs)} até ${fmtDay(endMs - 1000)}`,
        `⏱️ **Total da semana:** ${fmtDuration(totalSeconds)}`,
        `🧾 **Pontos fechados:** ${points.length}`,
        '',
        points.length
          ? visibleLines.join('\n\n')
          : 'Nenhum ponto fechado nesta semana.'
      ].join('\n')
    )
    .setFooter({
      text: 'Períodos: segunda a domingo • Pontos abertos não entram no total'
    });
}


async function sendPublicStartMessage(guild, userId, point, voiceChannelName) {
  const channel = await getPointTextChannel(guild);
  if (!channel) return null;

  try {
    // Evita deixar aviso antigo do mesmo usuário no canal.
    await deleteActivePublicStartMessage(guild.id, userId);

    const message = await channel.send({
      content:
        `🟢 **Ponto iniciado!**\n` +
        `👤 <@${userId}>\n` +
        `🔊 Call: **${voiceChannelName || point.voice_channel_name || 'Call autorizada'}**\n` +
        `🕒 Entrada: **${fmtDate(point.started_at)}**`,
      allowedMentions: { users: [userId] }
    });

    const key = pointKey(guild.id, userId);
    const deleteTimer = setTimeout(() => {
      message.delete().catch(() => {});

      const current = activePublicStartMessages.get(key);
      if (current?.message?.id === message.id) {
        activePublicStartMessages.delete(key);
      }
    }, START_NOTICE_SECONDS * 1000);

    activePublicStartMessages.set(key, {
      message,
      deleteTimer
    });

    return message;
  } catch (error) {
    console.error('❌ Erro ao enviar aviso de ponto iniciado:', error);
    return null;
  }
}


async function sendTemporaryPublicClose(
  guild,
  userId,
  point,
  reason,
  extraText = null
) {
  const channel = await getPointTextChannel(guild);
  if (!channel) return null;

  const publicCloseSeconds = getPublicCloseSeconds(guild.id);

  try {
    const isAfk =
      reason === 'admin_voice_action' ||
      reason === 'afk_voice';

    const title = isAfk
      ? '🔴 O ponto foi encerrado'
      : '🔴 Ponto fechado automaticamente';

    const lines = [
      `👤 <@${userId}>`
    ];

    if (isAfk) {
      lines.push('💤 **Entrou na call AFK**');
    } else if (extraText) {
      lines.push(extraText);
    }

    lines.push(
      '',
      `📥 **Entrada:** ${fmtDate(point.started_at)}`,
      `📤 **Saída:** ${fmtDate(point.ended_at)}`,
      `⏱️ **Total:** ${fmtDuration(point.duration_seconds)}`,
      `📌 **Motivo:** ${reasonLabel(reason)}`,
      '',
      `🗑️ Esta mensagem será removida em ${publicCloseSeconds}s.`
    );

    const message = await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(title)
          .setDescription(lines.join('\n'))
      ]
    });

    setTimeout(() => {
      message.delete().catch(() => {});
    }, publicCloseSeconds * 1000);

    return message;
  } catch (error) {
    console.error('❌ Erro ao enviar aviso público:', error);
    return null;
  }
}

async function editPrivateStartAsClosed(guildId, userId, point, reason) {
  const key = pointKey(guildId, userId);
  const startInteraction = activeStartInteractions.get(key);

  if (!startInteraction) return;

  try {
    await startInteraction.editReply({
      content:
        `🔴 **Ponto fechado automaticamente!**\n` +
        `📥 Entrada: **${fmtDate(point.started_at)}**\n` +
        `📤 Saída: **${fmtDate(point.ended_at)}**\n` +
        `⏱️ Total: **${fmtDuration(point.duration_seconds)}**\n` +
        `📌 Motivo: **${reasonLabel(reason)}**`
    });
  } catch {
    // A interação pode ter expirado. O ponto já está salvo.
  }

  activeStartInteractions.delete(key);
}



async function getPointTextChannel(guild) {
  // Prioridade:
  // 1) canal onde /painel-ponto foi usado;
  // 2) PONTO_CHANNEL_ID do .env apenas como fallback.
  const savedChannelId = getPanelChannel(guild.id);
  const channelId =
    savedChannelId ||
    (guild.id === LEGACY_GUILD_ID ? LEGACY_PONTO_CHANNEL_ID : null);

  if (!channelId) {
    console.log(
      '⚠️ Nenhum canal de painel salvo. Use /painel-ponto no canal desejado.'
    );
    return null;
  }

  try {
    const channel = await guild.channels.fetch(channelId);

    if (!channel || !channel.isTextBased()) {
      console.log('⚠️ O canal salvo do painel não é um canal de texto válido.');
      return null;
    }

    return channel;
  } catch (error) {
    console.error('❌ Não consegui acessar o canal do painel:', error);
    return null;
  }
}

async function sendLeaveWarning(guild, userId, fromChannelName) {
  const channel = await getPointTextChannel(guild);
  if (!channel) return null;

  const voiceGraceSeconds = getVoiceGraceSeconds(guild.id);

  try {
    return await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('🟡 Saiu da call')
          .setDescription(
            [
              `👤 <@${userId}>`,
              `🔊 Call: **${fromChannelName || 'Call autorizada'}**`,
              '',
              `⏳ Você tem **${voiceGraceSeconds} segundos** para voltar`,
              'para qualquer call autorizada.',
              '',
              '✅ Se voltar a tempo, o ponto continuará aberto.',
              '🔴 Se não voltar, o ponto será fechado automaticamente.'
            ].join('\n')
          )
      ]
    });
  } catch (error) {
    console.error('❌ Erro ao enviar aviso de tolerância:', error);
    return null;
  }
}

async function showReturnedMessage(pending) {
  if (!pending.warningMessage) return;

  try {
    await pending.warningMessage.edit({
      embeds: [
        new EmbedBuilder()
          .setTitle('🟢 Voltou para a call')
          .setDescription(
            [
              `👤 <@${pending.userId}>`,
              '✅ Voltou para uma call autorizada dentro do tempo.',
              '',
              '**O ponto continua aberto normalmente.**'
            ].join('\n')
          )
      ]
    });

    setTimeout(() => {
      pending.warningMessage.delete().catch(() => {});
    }, 10000);
  } catch {
    // A mensagem pode ter sido apagada manualmente.
  }
}


function buildPublicClosedEmbed({
  guildId,
  userId,
  point,
  reason,
  channelName = null
}) {
  const publicCloseSeconds = getPublicCloseSeconds(guildId);

  const isAfk =
    reason === 'admin_voice_action' ||
    reason === 'afk_voice';

  const lines = [
    `👤 <@${userId}>`
  ];

  if (isAfk) {
    lines.push('💤 **Entrou na call AFK**');
  } else if (reason === 'unauthorized_voice') {
    lines.push(
      `🚫 Entrou em call não autorizada${
        channelName ? `: **${channelName}**` : ''
      }`
    );
  }

  lines.push(
    '',
    `📥 **Entrada:** ${fmtDate(point.started_at)}`,
    `📤 **Saída:** ${fmtDate(point.ended_at)}`,
    `⏱️ **Total:** ${fmtDuration(point.duration_seconds)}`,
    `📌 **Motivo:** ${reasonLabel(reason)}`,
    '',
    `🗑️ Esta mensagem será removida em ${publicCloseSeconds}s.`
  );

  return new EmbedBuilder()
    .setTitle(
      isAfk
        ? '🔴 O ponto foi encerrado'
        : '🔴 Ponto fechado automaticamente'
    )
    .setDescription(lines.join('\n'));
}

async function finalizePendingLeave(key, reason = 'left_voice') {
  const pending = pendingVoiceLeaves.get(key);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingVoiceLeaves.delete(key);

  const result = closePoint({
    guildId: pending.guildId,
    userId: pending.userId,
    reason,
    // A tolerância não é contabilizada como tempo trabalhado.
    endedAt: pending.leftAt
  });

  if (!result.ok) return false;

  await editPrivateStartAsClosed(
    pending.guildId,
    pending.userId,
    result.point,
    reason
  );

  // Em vez de criar duas mensagens públicas, reaproveita o aviso
  // "você tem 60 segundos" e transforma em "ponto fechado".
  if (pending.warningMessage) {
    try {
      await pending.warningMessage.edit({
        embeds: [
          buildPublicClosedEmbed({
            guildId: pending.guildId,
            userId: pending.userId,
            point: result.point,
            reason
          })
        ]
      });

      const publicCloseSeconds = getPublicCloseSeconds(pending.guildId);
      scheduleDeleteActivePublicStartMessage(
        pending.guildId,
        pending.userId,
        publicCloseSeconds
      );
      setTimeout(() => {
        pending.warningMessage.delete().catch(() => {});
      }, publicCloseSeconds * 1000);
    } catch (error) {
      console.error('⚠️ Não consegui atualizar o aviso de saída:', error);

      await sendTemporaryPublicClose(
        pending.guild,
        pending.userId,
        result.point,
        reason
      );
      scheduleDeleteActivePublicStartMessage(
        pending.guildId,
        pending.userId,
        getPublicCloseSeconds(pending.guildId)
      );
    }
  } else {
    await sendTemporaryPublicClose(
      pending.guild,
      pending.userId,
      result.point,
      reason
    );
    scheduleDeleteActivePublicStartMessage(
      pending.guildId,
      pending.userId,
      getPublicCloseSeconds(pending.guildId)
    );
  }

  console.log(
    `🔴 Ponto fechado para ${pending.userId}: ` +
    `${fmtDuration(result.point.duration_seconds)} (${reason})`
  );

  return true;
}

async function cancelPendingLeave(guildId, userId) {
  const key = pointKey(guildId, userId);
  const pending = pendingVoiceLeaves.get(key);

  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingVoiceLeaves.delete(key);

  await showReturnedMessage(pending);

  console.log(
    `🟢 ${userId} voltou para uma call autorizada dentro da tolerância.`
  );

  return true;
}


async function closeImmediatelyForUnauthorized({
  guild,
  guildId,
  userId,
  key,
  endedAt = Date.now(),
  channelName = null,
  reason = 'unauthorized_voice'
}) {
  const pending = pendingVoiceLeaves.get(key);

  if (pending) {
    clearTimeout(pending.timer);
    pendingVoiceLeaves.delete(key);
  }

  const result = closePoint({
    guildId,
    userId,
    reason,
    endedAt
  });

  if (!result.ok) return false;

  await editPrivateStartAsClosed(
    guildId,
    userId,
    result.point,
    reason
  );

  // Se já existia aviso de tolerância, transforma ele em fechamento.
  if (pending?.warningMessage) {
    try {
      await pending.warningMessage.edit({
        embeds: [
          buildPublicClosedEmbed({
            guildId,
            userId,
            point: result.point,
            reason,
            channelName
          })
        ]
      });

      const publicCloseSeconds = getPublicCloseSeconds(pending.guildId);
      scheduleDeleteActivePublicStartMessage(guildId, userId, publicCloseSeconds);
      setTimeout(() => {
        pending.warningMessage.delete().catch(() => {});
      }, publicCloseSeconds * 1000);
    } catch {
      await sendTemporaryPublicClose(
        guild,
        userId,
        result.point,
        reason,
        reason === 'unauthorized_voice' && channelName
          ? `🚫 Entrou em call não autorizada: **${channelName}**`
          : null
      );
      scheduleDeleteActivePublicStartMessage(guildId, userId, getPublicCloseSeconds(guildId));
    }
  } else {
    await sendTemporaryPublicClose(
      guild,
      userId,
      result.point,
      reason,
      reason === 'unauthorized_voice' && channelName
        ? `🚫 Entrou em call não autorizada: **${channelName}**`
        : null
    );
    scheduleDeleteActivePublicStartMessage(guildId, userId, getPublicCloseSeconds(guildId));
  }

  console.log(
    `🔴 Ponto fechado para ${userId}: ${reasonLabel(reason)}` +
    `${channelName ? ` (${channelName})` : ''}.`
  );

  return true;
}

function rememberAdminVoiceAction(guildId, data) {
  const arr = recentAdminVoiceActions.get(guildId) || [];
  const cutoff = Date.now() - 5000;

  const next = arr
    .filter(item => item.at >= cutoff)
    .concat(data)
    .slice(-10);

  recentAdminVoiceActions.set(guildId, next);
}

function getRecentAdminVoiceAction(guildId, maxAgeMs = 2500) {
  const arr = recentAdminVoiceActions.get(guildId) || [];
  const now = Date.now();

  return [...arr]
    .reverse()
    .find(item => now - item.at <= maxAgeMs) || null;
}


function parseBrDate(value, endOfRange = false) {
  if (!value) return null;

  const match = String(value).trim().match(
    /^(\d{2})-(\d{2})-(\d{4})$/
  );

  if (!match) return NaN;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  const test = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

  if (
    test.getUTCFullYear() !== year ||
    test.getUTCMonth() !== month - 1 ||
    test.getUTCDate() !== day
  ) {
    return NaN;
  }

  // 00:00 de São Paulo = 03:00 UTC.
  const start = Date.UTC(year, month - 1, day, 3, 0, 0, 0);

  if (!endOfRange) return start;

  const next = new Date(Date.UTC(year, month - 1, day + 1, 3, 0, 0, 0));
  return next.getTime();
}

function dataPeriodText(startMs, endMs) {
  if (startMs === null && endMs === null) {
    return 'Desde o primeiro registro';
  }

  if (startMs !== null && endMs !== null) {
    return `${fmtDay(startMs)} até ${fmtDay(endMs - 1000)}`;
  }

  if (startMs !== null) {
    return `A partir de ${fmtDay(startMs)}`;
  }

  return `Até ${fmtDay(endMs - 1000)}`;
}

function buildDataLogLines(points) {
  return points.map((p, index) => {
    if (p.status === 'open') {
      const liveSeconds = Math.max(
        0,
        Math.floor((Date.now() - p.started_at) / 1000)
      );

      return [
        `${index + 1}. 🟢 **ABERTO** • <@${p.user_id}>`,
        `   📥 ${fmtDate(p.started_at)} • ⏱️ ${fmtDuration(liveSeconds)}`,
        `   🔊 ${p.voice_channel_name || 'Call não registrada'}`
      ].join('\n');
    }

    return [
      `${index + 1}. 🔴 **FECHADO** • <@${p.user_id}>`,
      `   📥 ${fmtDate(p.started_at)} → 📤 ${fmtDate(p.ended_at)}`,
      `   ⏱️ ${fmtDuration(p.duration_seconds || 0)} • ${reasonLabel(p.closed_reason)}`
    ].join('\n');
  });
}

async function ensureDataChannel(interaction) {
  let dataChannelId = getDataChannel(interaction.guildId);

  // Se ainda não estiver configurado e o ADM estiver usando o canal
  // acompanhar-ponto, salva automaticamente.
  if (
    !dataChannelId &&
    interaction.channel?.name?.toLowerCase() === 'acompanhar-ponto'
  ) {
    setDataChannel(interaction.guildId, interaction.channelId);
    dataChannelId = interaction.channelId;
  }

  if (!dataChannelId) {
    await interaction.reply({
      content:
        '⚠️ O canal administrativo ainda não foi configurado.\n' +
        'Entre em **#acompanhar-ponto** e use `/config-dados`.',
      ephemeral: true
    });
    return false;
  }

  if (interaction.channelId !== dataChannelId) {
    await interaction.reply({
      content:
        `⚠️ Use este comando no canal <#${dataChannelId}>.`,
      ephemeral: true
    });
    return false;
  }

  return true;
}

async function handleDadosCommand(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({
      content: '⛔ Este comando é exclusivo da administração.',
      ephemeral: true
    });
  }

  if (!(await ensureDataChannel(interaction))) return;

  const targetUser = interaction.options.getUser('usuario');
  const view = interaction.options.getString('view') || 'resumo';
  const startText = interaction.options.getString('start_date');
  const endText = interaction.options.getString('end_date');

  const startMs = startText
    ? parseBrDate(startText, false)
    : null;

  const endMs = endText
    ? parseBrDate(endText, true)
    : null;

  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return interaction.reply({
      content:
        '❌ Data inválida. Use o formato **DD-MM-YYYY**.\n' +
        'Exemplo: `01-09-2026`.',
      ephemeral: true
    });
  }

  if (
    startMs !== null &&
    endMs !== null &&
    endMs <= startMs
  ) {
    return interaction.reply({
      content: '❌ A data final precisa ser igual ou posterior à data inicial.',
      ephemeral: true
    });
  }

  const userId = targetUser?.id || null;
  const periodText = dataPeriodText(startMs, endMs);

  if (view === 'resumo') {
    if (targetUser) {
      const stats = getUserLifetimeStats(
        interaction.guildId,
        targetUser.id
      );

      const periodSeconds = getClosedSecondsInRange({
        guildId: interaction.guildId,
        userId: targetUser.id,
        startMs,
        endMs
      });

      const open = stats.open;

      const embed = new EmbedBuilder()
        .setTitle(`📊 Dados de ponto — ${targetUser.username}`)
        .setDescription(
          [
            `👤 <@${targetUser.id}>`,
            '',
            '### Total desde o início',
            `⏱️ **Horas acumuladas:** ${fmtDuration(stats.total_seconds)}`,
            `🧾 **Pontos fechados:** ${stats.closed_count}`,
            `📚 **Registros totais:** ${stats.total_count}`,
            `📅 **Primeiro registro:** ${
              stats.first_started_at
                ? fmtDate(stats.first_started_at)
                : 'Nenhum'
            }`,
            '',
            '### Período consultado',
            `📆 **${periodText}**`,
            `⏱️ **Total no período:** ${fmtDuration(periodSeconds)}`,
            '',
            open
              ? [
                  '### Ponto aberto agora',
                  `🟢 Desde **${fmtDate(open.started_at)}**`,
                  `🔊 ${open.voice_channel_name || 'Call não registrada'}`,
                  `⏱️ ${fmtDuration(
                    Math.floor((Date.now() - open.started_at) / 1000)
                  )}`
                ].join('\n')
              : '⚪ **Nenhum ponto aberto agora.**'
          ].join('\n')
        );

      return interaction.reply({
        embeds: [embed],
        ephemeral: true
      });
    }

    const stats = getServerLifetimeStats(interaction.guildId);

    const embed = new EmbedBuilder()
      .setTitle('📊 Resumo geral do sistema de ponto')
      .setDescription(
        [
          `⏱️ **Total de horas registradas:** ${fmtDuration(stats.total_seconds)}`,
          `🧾 **Pontos fechados:** ${stats.closed_count}`,
          `🟢 **Pontos abertos agora:** ${stats.open_count}`,
          `👥 **Usuários com ponto fechado:** ${stats.users_count}`,
          `📅 **Primeiro registro:** ${
            stats.first_started_at
              ? fmtDate(stats.first_started_at)
              : 'Nenhum'
          }`
        ].join('\n')
      );

    return interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  }

  const status =
    view === 'abertos'
      ? 'open'
      : view === 'fechados'
        ? 'closed'
        : null;

  const totalMatches = countPointsFiltered({
    guildId: interaction.guildId,
    userId,
    status,
    startMs,
    endMs
  });

  const points = getPointsFiltered({
    guildId: interaction.guildId,
    userId,
    status,
    startMs,
    endMs,
    limit: 25
  });

  const viewLabel =
    view === 'abertos'
      ? 'Pontos abertos'
      : view === 'fechados'
        ? 'Pontos fechados'
        : 'Logs de ponto';

  const lines = buildDataLogLines(points);

  const embed = new EmbedBuilder()
    .setTitle(`🧾 ${viewLabel}`)
    .setDescription(
      [
        targetUser
          ? `👤 Usuário: <@${targetUser.id}>`
          : '👥 Usuário: **Todos**',
        `📆 Período: **${periodText}**`,
        `🔎 Registros encontrados: **${totalMatches}**`,
        totalMatches > 25
          ? '📌 Mostrando os **25 mais recentes**.'
          : '',
        '',
        lines.length
          ? lines.join('\n\n').slice(0, 3900)
          : 'Nenhum registro encontrado.'
      ].filter(Boolean).join('\n')
    );

  return interaction.reply({
    embeds: [embed],
    ephemeral: true
  });
}



function buildSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName('painel-ponto')
      .setDescription('Envia o painel do sistema de ponto neste canal.'),

    new SlashCommandBuilder()
      .setName('config-dados')
      .setDescription('Define este canal como o canal administrativo acompanhar-ponto.'),

    new SlashCommandBuilder()
      .setName('config-ponto')
      .setDescription('Configura o sistema de ponto deste servidor.')
      .addSubcommand(subcommand =>
        subcommand
          .setName('status')
          .setDescription('Mostra a configuração atual deste servidor.')
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('adicionar-call')
          .setDescription('Autoriza uma call para iniciar/manter o ponto.')
          .addChannelOption(option =>
            option
              .setName('canal')
              .setDescription('Call que será autorizada.')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
          )
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('remover-call')
          .setDescription('Remove uma call da lista autorizada.')
          .addChannelOption(option =>
            option
              .setName('canal')
              .setDescription('Call que deixará de ser autorizada.')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
          )
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('limpar-calls')
          .setDescription('Remove todas as calls autorizadas deste servidor.')
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('afk')
          .setDescription('Define a call AFK que encerra o ponto imediatamente.')
          .addChannelOption(option =>
            option
              .setName('canal')
              .setDescription('Call AFK.')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
          )
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('limpar-afk')
          .setDescription('Remove a call AFK configurada.')
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('cargo-admin')
          .setDescription('Define um cargo extra com acesso administrativo ao ponto.')
          .addRoleOption(option =>
            option
              .setName('cargo')
              .setDescription('Cargo administrativo do sistema de ponto.')
              .setRequired(true)
          )
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('limpar-cargo-admin')
          .setDescription('Remove o cargo administrativo extra do sistema de ponto.')
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('tolerancia')
          .setDescription('Define quantos segundos a pessoa pode ficar fora da call.')
          .addIntegerOption(option =>
            option
              .setName('segundos')
              .setDescription('Entre 5 e 600 segundos.')
              .setRequired(true)
              .setMinValue(5)
              .setMaxValue(600)
          )
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('aviso-publico')
          .setDescription('Define por quanto tempo o aviso de fechamento fica no chat.')
          .addIntegerOption(option =>
            option
              .setName('segundos')
              .setDescription('Entre 10 e 600 segundos.')
              .setRequired(true)
              .setMinValue(10)
              .setMaxValue(600)
          )
      ),

    new SlashCommandBuilder()
      .setName('dados')
      .setDescription('Consulta dados e logs do sistema de ponto.')
      .addUserOption(option =>
        option
          .setName('usuario')
          .setDescription('Especificar um usuário.')
          .setRequired(false)
      )
      .addStringOption(option =>
        option
          .setName('view')
          .setDescription('Tipo de visualização.')
          .setRequired(false)
          .addChoices(
            {
              name: 'Resumo / total de horas',
              value: 'resumo'
            },
            {
              name: 'Todos os logs',
              value: 'logs'
            },
            {
              name: 'Somente pontos abertos',
              value: 'abertos'
            },
            {
              name: 'Somente pontos fechados',
              value: 'fechados'
            }
          )
      )
      .addStringOption(option =>
        option
          .setName('start_date')
          .setDescription('Data de início no formato DD-MM-YYYY.')
          .setRequired(false)
      )
      .addStringOption(option =>
        option
          .setName('end_date')
          .setDescription('Data de fim no formato DD-MM-YYYY.')
          .setRequired(false)
      )
  ].map(command => command.toJSON());
}

const rest = new REST({ version: '10' }).setToken(TOKEN);
const slashCommands = buildSlashCommands();

async function registerCommandsForGuild(guildId) {
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, guildId),
    { body: slashCommands }
  );
}

async function recoverOpenPointsForGuild(guild) {
  const guildId = guild.id;
  const openPoints = getAllOpenPoints(guildId);
  const voiceGraceSeconds = getVoiceGraceSeconds(guildId);

  for (const point of openPoints) {
    const member = await guild.members.fetch(point.user_id).catch(() => null);
    if (!member) continue;

    const currentVoiceId = member.voice?.channelId || null;

    if (isAllowedVoiceChannel(guildId, currentVoiceId)) {
      continue;
    }

    const key = pointKey(guildId, point.user_id);
    if (pendingVoiceLeaves.has(key)) continue;

    if (currentVoiceId && !isAllowedVoiceChannel(guildId, currentVoiceId)) {
      await closeImmediatelyForUnauthorized({
        guild,
        guildId,
        userId: point.user_id,
        key,
        endedAt: Date.now(),
        channelName: member.voice?.channel?.name || null
      });
      continue;
    }

    const leftAt = Date.now();
    const warningMessage = await sendLeaveWarning(
      guild,
      point.user_id,
      'call autorizada'
    );

    const timer = setTimeout(() => {
      finalizePendingLeave(key, 'left_voice').catch(error => {
        console.error('❌ Erro na recuperação de ponto aberto:', error);
      });
    }, voiceGraceSeconds * 1000);

    pendingVoiceLeaves.set(key, {
      guildId,
      userId: point.user_id,
      guild,
      leftAt,
      fromChannelId: point.voice_channel_id,
      fromChannelName: point.voice_channel_name,
      warningMessage,
      timer
    });

    console.log(
      `🟡 Recuperação [${guild.name}]: ponto aberto de ${point.user_id} está fora de voz.`
    );
  }
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`✅ Bot online como ${readyClient.user.tag}`);

  migrateLegacyEnvSettings();

  for (const guild of readyClient.guilds.cache.values()) {
    const config = getGuildConfig(guild.id);

    console.log(
      `🏠 ${guild.name} (${guild.id}) | ` +
      `${config.allowedVoiceChannelIds.size} call(s) | ` +
      `tolerância ${config.voiceGraceSeconds}s`
    );

    try {
      await registerCommandsForGuild(guild.id);
      console.log(`✅ Comandos registrados em ${guild.name}.`);
    } catch (error) {
      console.error(`❌ Erro ao registrar comandos em ${guild.name}:`, error);
    }

    try {
      await recoverOpenPointsForGuild(guild);
    } catch (error) {
      console.error(`⚠️ Falha ao recuperar pontos em ${guild.name}:`, error);
    }
  }
});

client.on(Events.GuildCreate, async guild => {
  try {
    await registerCommandsForGuild(guild.id);
    console.log(`✅ Novo servidor conectado: ${guild.name}. Comandos registrados.`);
  } catch (error) {
    console.error(`❌ Erro ao registrar comandos no novo servidor ${guild.name}:`, error);
  }
});

// Tenta identificar ações administrativas de mover/desconectar membros.
// O audit log de voz do Discord não identifica de forma confiável o alvo
// em todos os casos; por isso a correlação é feita por tempo e só fecha
// imediatamente quando existe UM único ponto pendente recente naquele servidor.
client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
  try {
    if (
      entry.action !== AuditLogEvent.MemberDisconnect &&
      entry.action !== AuditLogEvent.MemberMove
    ) {
      return;
    }

    if (!entry.executorId) return;

    const executorMember = await guild.members
      .fetch(entry.executorId)
      .catch(() => null);

    if (!isAdmin(executorMember)) return;

    rememberAdminVoiceAction(guild.id, {
      at: Date.now(),
      action: entry.action,
      executorId: entry.executorId
    });

    const candidates = [...pendingVoiceLeaves.entries()].filter(
      ([, pending]) =>
        pending.guildId === guild.id &&
        Date.now() - pending.leftAt <= 6000
    );

    // Evita adivinhar o usuário se houver vários saindo ao mesmo tempo.
    if (candidates.length === 1) {
      const [key] = candidates[0];
      await finalizePendingLeave(key, 'admin_voice_action');
    }
  } catch (error) {
    console.error('⚠️ Falha ao processar audit log de voz:', error);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'painel-ponto') {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({
            content: '❌ Apenas administradores podem criar o painel.',
            ephemeral: true
          });
        }

        await interaction.channel.send({
          embeds: [buildPanelEmbed(interaction.guildId)],
          components: [buildPanelButtons()],
          files: [
            {
              attachment: './assets/painel.png',
              name: 'painel.png'
            }
          ]
        });

        // Salva automaticamente este canal como o canal oficial do ponto.
        setPanelChannel(interaction.guildId, interaction.channelId);

        return interaction.reply({
          content:
            `✅ Painel de ponto criado.\n` +
            `📌 Este canal agora é o canal oficial dos avisos de ponto.`,
          ephemeral: true
        });
      }


      if (interaction.commandName === 'config-dados') {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({
            content: '⛔ Apenas administradores podem configurar este canal.',
            ephemeral: true
          });
        }

        setDataChannel(interaction.guildId, interaction.channelId);

        return interaction.reply({
          content:
            `✅ <#${interaction.channelId}> agora é o canal **acompanhar-ponto** ` +
            `para consultas administrativas.\n` +
            `Use \`/dados\` aqui para pesquisar.`,
          ephemeral: true
        });
      }

      if (interaction.commandName === 'config-ponto') {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({
            content: '⛔ Apenas administradores podem configurar o sistema de ponto.',
            ephemeral: true
          });
        }

        const guildId = interaction.guildId;
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'status') {
          const config = getGuildConfig(guildId);
          const settings = getGuildSettings(guildId);
          const panelChannelId = getPanelChannel(guildId);
          const dataChannelId = getDataChannel(guildId);
          const calls = [...config.allowedVoiceChannelIds];

          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setTitle('⚙️ Configuração do sistema de ponto')
                .setDescription(
                  [
                    `🏠 **Servidor:** ${interaction.guild.name}`,
                    `📌 **Canal do painel:** ${panelChannelId ? `<#${panelChannelId}>` : 'Não configurado'}`,
                    `📊 **Canal de dados:** ${dataChannelId ? `<#${dataChannelId}>` : 'Não configurado'}`,
                    `🛡️ **Cargo ADM extra:** ${config.adminRoleId ? `<@&${config.adminRoleId}>` : 'Nenhum'}`,
                    `💤 **Call AFK:** ${config.afkChannelId ? `<#${config.afkChannelId}>` : 'Não configurada'}`,
                    `⏳ **Tolerância:** ${config.voiceGraceSeconds}s`,
                    `🗑️ **Aviso de fechamento:** ${config.publicCloseSeconds}s`,
                    '',
                    `🔊 **Calls autorizadas (${calls.length}):**`,
                    calls.length
                      ? calls.map(id => `• <#${id}>`).join('\n')
                      : 'Nenhuma call autorizada. O ponto automático fica aguardando configuração.',
                    '',
                    settings.updated_at
                      ? `🕒 Última alteração: ${fmtDate(settings.updated_at)}`
                      : '🆕 Este servidor ainda está usando as configurações padrão.'
                  ].join('\n')
                )
            ],
            ephemeral: true
          });
        }

        if (subcommand === 'adicionar-call') {
          const channel = interaction.options.getChannel('canal', true);
          const config = getGuildConfig(guildId);

          if (config.afkChannelId === channel.id) {
            return interaction.reply({
              content: '⚠️ Essa call está configurada como **AFK**. Escolha outra call ou altere a AFK primeiro.',
              ephemeral: true
            });
          }

          const added = addAllowedVoiceChannel(guildId, channel.id);

          return interaction.reply({
            content: added
              ? `✅ ${channel} foi adicionada às **calls autorizadas**.`
              : `ℹ️ ${channel} já estava na lista de calls autorizadas.`,
            ephemeral: true
          });
        }

        if (subcommand === 'remover-call') {
          const channel = interaction.options.getChannel('canal', true);
          const removed = removeAllowedVoiceChannel(guildId, channel.id);

          return interaction.reply({
            content: removed
              ? `✅ ${channel} foi removida das calls autorizadas.`
              : `ℹ️ ${channel} não estava na lista de calls autorizadas.`,
            ephemeral: true
          });
        }

        if (subcommand === 'limpar-calls') {
          setAllowedVoiceChannels(guildId, []);

          return interaction.reply({
            content:
              '✅ Todas as calls autorizadas foram removidas.\n' +
              '⚠️ Enquanto nenhuma call for adicionada, novos pontos não iniciarão automaticamente.',
            ephemeral: true
          });
        }

        if (subcommand === 'afk') {
          const channel = interaction.options.getChannel('canal', true);

          // Uma call AFK não pode ao mesmo tempo ser considerada de serviço.
          removeAllowedVoiceChannel(guildId, channel.id);
          setAfkChannel(guildId, channel.id);

          return interaction.reply({
            content:
              `✅ ${channel} agora é a **call AFK**.\n` +
              'Entrar nela encerra o ponto imediatamente.',
            ephemeral: true
          });
        }

        if (subcommand === 'limpar-afk') {
          setAfkChannel(guildId, null);

          return interaction.reply({
            content: '✅ A call AFK foi removida.',
            ephemeral: true
          });
        }

        if (subcommand === 'cargo-admin') {
          const role = interaction.options.getRole('cargo', true);

          if (role.id === interaction.guild.id) {
            return interaction.reply({
              content: '⚠️ O cargo **@everyone** não pode ser usado como cargo administrativo.',
              ephemeral: true
            });
          }

          setAdminRole(guildId, role.id);

          return interaction.reply({
            content:
              `✅ ${role} agora também possui acesso às funções administrativas do sistema de ponto.`,
            ephemeral: true
          });
        }

        if (subcommand === 'limpar-cargo-admin') {
          setAdminRole(guildId, null);

          return interaction.reply({
            content:
              '✅ Cargo ADM extra removido. Usuários com permissão **Administrador** continuam com acesso.',
            ephemeral: true
          });
        }

        if (subcommand === 'tolerancia') {
          const seconds = interaction.options.getInteger('segundos', true);
          setVoiceGraceSeconds(guildId, seconds);

          return interaction.reply({
            content: `✅ Tolerância deste servidor alterada para **${seconds} segundos**.`,
            ephemeral: true
          });
        }

        if (subcommand === 'aviso-publico') {
          const seconds = interaction.options.getInteger('segundos', true);
          setPublicCloseSeconds(guildId, seconds);

          return interaction.reply({
            content: `✅ Avisos de fechamento ficarão no chat por **${seconds} segundos**.`,
            ephemeral: true
          });
        }
      }

      if (interaction.commandName === 'dados') {
        return handleDadosCommand(interaction);
      }
    }

    if (interaction.isUserSelectMenu()) {
      if (interaction.customId !== 'ponto_admin_select_user') return;

      if (!isAdmin(interaction.member)) {
        return interaction.reply({
          content: '⛔ Este histórico é exclusivo da administração.',
          ephemeral: true
        });
      }

      const targetUserId = interaction.values[0];
      const targetMember = await interaction.guild.members
        .fetch(targetUserId)
        .catch(() => null);

      const period = currentWeek();
      const username =
        targetMember?.displayName ||
        targetMember?.user?.username ||
        `ID ${targetUserId}`;

      const embed = buildHistoryEmbed({
        guildId: interaction.guildId,
        userId: targetUserId,
        username,
        startMs: period.startMs,
        endMs: period.endMs,
        adminView: true
      });

      return interaction.update({
        content: `🛡️ Consultando <@${targetUserId}>`,
        embeds: [embed],
        components: [
          buildPeriodMenu(
            `ponto_admin_period:${targetUserId}`,
            encodePeriod(period)
          )
        ]
      });
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'ponto_self_period') {
        const period = decodePeriod(interaction.values[0]);

        if (!period) {
          return interaction.update({
            content: '❌ Período inválido.',
            embeds: [],
            components: []
          });
        }

        const member = await interaction.guild.members
          .fetch(interaction.user.id)
          .catch(() => null);

        const embed = buildHistoryEmbed({
          guildId: interaction.guildId,
          userId: interaction.user.id,
          username:
            member?.displayName ||
            interaction.user.username,
          startMs: period.startMs,
          endMs: period.endMs,
          adminView: false
        });

        return interaction.update({
          embeds: [embed],
          components: [
            buildPeriodMenu(
              'ponto_self_period',
              interaction.values[0]
            )
          ]
        });
      }

      if (interaction.customId.startsWith('ponto_admin_period:')) {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({
            content: '⛔ Este histórico é exclusivo da administração.',
            ephemeral: true
          });
        }

        const targetUserId =
          interaction.customId.split(':')[1];

        const period = decodePeriod(interaction.values[0]);

        if (!period) {
          return interaction.update({
            content: '❌ Período inválido.',
            embeds: [],
            components: []
          });
        }

        const targetMember = await interaction.guild.members
          .fetch(targetUserId)
          .catch(() => null);

        const username =
          targetMember?.displayName ||
          targetMember?.user?.username ||
          `ID ${targetUserId}`;

        const embed = buildHistoryEmbed({
          guildId: interaction.guildId,
          userId: targetUserId,
          username,
          startMs: period.startMs,
          endMs: period.endMs,
          adminView: true
        });

        return interaction.update({
          content: `🛡️ Consultando <@${targetUserId}>`,
          embeds: [embed],
          components: [
            buildPeriodMenu(
              `ponto_admin_period:${targetUserId}`,
              interaction.values[0]
            )
          ]
        });
      }

      return;
    }

    if (!interaction.isButton()) return;

    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    const key = pointKey(guildId, userId);

    if (interaction.customId === 'ponto_iniciar') {
      const member = await interaction.guild.members.fetch(userId);
      const voiceChannel = member.voice?.channel;

      if (!voiceChannel) {
        return interaction.reply({
          content:
            '❌ Você precisa estar conectado em uma call para iniciar o ponto.',
          ephemeral: true
        });
      }

      if (!isAllowedVoiceChannel(guildId, voiceChannel.id)) {
        return interaction.reply({
          content:
            `⛔ A call **${voiceChannel.name}** não é autorizada para bater ponto.`,
          ephemeral: true
        });
      }

      const result = startPoint({
        guildId,
        userId,
        username: interaction.user.username,
        voiceChannelId: voiceChannel.id,
        voiceChannelName: voiceChannel.name
      });

      if (!result.ok && result.reason === 'already_open') {
        return interaction.reply({
          content:
            `⚠️ Você já possui um ponto aberto desde ` +
            `**${fmtDate(result.point.started_at)}**.`,
          ephemeral: true
        });
      }

      await interaction.reply({
        content:
          `🟢 **Ponto iniciado!**\n` +
          `🔊 Call: **${voiceChannel.name}**\n` +
          `🕒 Entrada: **${fmtDate(result.point.started_at)}**`,
        ephemeral: true
      });

      activeStartInteractions.set(key, interaction);
      return;
    }

    if (interaction.customId === 'ponto_fechar') {
      const open = getOpenPoint(guildId, userId);

      if (!open) {
        return interaction.reply({
          content: '⚠️ Você não possui nenhum ponto aberto.',
          ephemeral: true
        });
      }

      const pending = pendingVoiceLeaves.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        pendingVoiceLeaves.delete(key);
      }

      const result = closePoint({
        guildId,
        userId,
        reason: 'manual'
      });

      activeStartInteractions.delete(key);

      const publicCloseSeconds = getPublicCloseSeconds(guildId);

      if (pending?.warningMessage) {
        pending.warningMessage.edit({
          embeds: [
            new EmbedBuilder()
              .setTitle('🔴 Ponto fechado manualmente')
              .setDescription(
                [
                  `👤 <@${userId}>`,
                  `📥 **Entrada:** ${fmtDate(result.point.started_at)}`,
                  `📤 **Saída:** ${fmtDate(result.point.ended_at)}`,
                  `⏱️ **Total:** ${fmtDuration(result.point.duration_seconds)}`,
                  '',
                  `🗑️ Esta mensagem será removida em ${publicCloseSeconds}s.`
                ].join('\n')
              )
          ]
        }).then(msg => {
          setTimeout(() => msg.delete().catch(() => {}), publicCloseSeconds * 1000);
        }).catch(() => {});
      }

      return interaction.reply({
        content:
          `🔴 **Ponto fechado!**\n` +
          `📥 Entrada: **${fmtDate(result.point.started_at)}**\n` +
          `📤 Saída: **${fmtDate(result.point.ended_at)}**\n` +
          `⏱️ Total: **${fmtDuration(result.point.duration_seconds)}**`,
        ephemeral: true
      });
    }

    if (interaction.customId === 'ponto_info') {
      const member = await interaction.guild.members.fetch(userId);
      const open = getOpenPoint(guildId, userId);
      const pending = pendingVoiceLeaves.get(key);

      if (open) {
        const liveSeconds = Math.max(
          0,
          Math.floor((Date.now() - open.started_at) / 1000)
        );

        let status = '🟢 Em serviço';

        if (pending) {
          const remaining = Math.max(
            0,
            getVoiceGraceSeconds(guildId) -
              Math.floor((Date.now() - pending.leftAt) / 1000)
          );

          status =
            `🟡 Fora da call autorizada — ` +
            `${remaining}s para voltar`;
        }

        return interaction.reply({
          content:
            `ℹ️ **Informações do ponto**\n` +
            `Status: ${status}\n` +
            `📥 Entrada: **${fmtDate(open.started_at)}**\n` +
            `🔊 Call de início: **${open.voice_channel_name || 'Não registrada'}**\n` +
            `🔊 Call atual: **${member.voice?.channel?.name || 'Nenhuma'}**\n` +
            `⏱️ Tempo atual: **${fmtDuration(liveSeconds)}**`,
          ephemeral: true
        });
      }

      const last = getUserHistory(guildId, userId, 1)[0];

      let content =
        `ℹ️ **Informações do ponto**\n` +
        `Status: ⚪ Sem ponto aberto\n`;

      if (last && last.status === 'closed') {
        content +=
          `\n🔴 **Último ponto fechado**\n` +
          `📥 Entrada: **${fmtDate(last.started_at)}**\n` +
          `📤 Saída: **${fmtDate(last.ended_at)}**\n` +
          `⏱️ Total: **${fmtDuration(last.duration_seconds)}**\n` +
          `📌 Motivo: **${reasonLabel(last.closed_reason)}**`;
      } else {
        content += '\nNenhum ponto registrado ainda.';
      }

      return interaction.reply({
        content,
        ephemeral: true
      });
    }

    if (interaction.customId === 'ponto_meu_historico') {
      const period = currentWeek();
      const member = await interaction.guild.members
        .fetch(userId)
        .catch(() => null);

      const embed = buildHistoryEmbed({
        guildId,
        userId,
        username:
          member?.displayName ||
          interaction.user.username,
        startMs: period.startMs,
        endMs: period.endMs,
        adminView: false
      });

      return interaction.reply({
        embeds: [embed],
        components: [
          buildPeriodMenu(
            'ponto_self_period',
            encodePeriod(period)
          )
        ],
        ephemeral: true
      });
    }

    if (interaction.customId === 'ponto_admin_historico') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({
          content: '⛔ Este histórico é exclusivo da administração.',
          ephemeral: true
        });
      }

      const select = new UserSelectMenuBuilder()
        .setCustomId('ponto_admin_select_user')
        .setPlaceholder('Selecione o membro')
        .setMinValues(1)
        .setMaxValues(1);

      return interaction.reply({
        content:
          '🛡️ **Histórico administrativo**\n' +
          'Selecione o membro que deseja consultar:',
        components: [
          new ActionRowBuilder().addComponents(select)
        ],
        ephemeral: true
      });
    }
  } catch (error) {
    console.error('❌ Erro em interação:', error);

    if (interaction.isRepliable()) {
      const payload = {
        content: '❌ Ocorreu um erro ao processar essa ação.',
        ephemeral: true
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  }
});


client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const userId = oldState.id || newState.id;
    const guildId = oldState.guild.id;
    const key = pointKey(guildId, userId);
    const config = getGuildConfig(guildId);
    const voiceGraceSeconds = config.voiceGraceSeconds;
    const afkChannelId = config.afkChannelId;

    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    const oldAllowed = isAllowedVoiceChannel(guildId, oldChannelId);
    const newAllowed = isAllowedVoiceChannel(guildId, newChannelId);

    let open = getOpenPoint(guildId, userId);

    // 0) Entrou em uma call autorizada sem ponto aberto.
    // Inicia o ponto automaticamente. O teste !oldAllowed evita
    // criar ponto ao apenas trocar de uma call autorizada para outra.
    if (!open && newAllowed && !oldAllowed) {
      const member = newState.member;

      // Bots não devem gerar registros de ponto.
      if (member?.user?.bot) return;

      const voiceChannel = newState.channel;
      if (!voiceChannel) return;

      const result = startPoint({
        guildId,
        userId,
        username:
          member?.user?.username ||
          member?.displayName ||
          `ID ${userId}`,
        voiceChannelId: voiceChannel.id,
        voiceChannelName: voiceChannel.name
      });

      if (result.ok) {
        console.log(
          `🟢 Ponto iniciado automaticamente para ${userId} ao entrar em ${voiceChannel.name}.`
        );

        await sendPublicStartMessage(
          newState.guild,
          userId,
          result.point,
          voiceChannel.name
        );
      }

      return;
    }

    // Sem ponto aberto e sem nova entrada em call autorizada: não há nada a fazer.
    if (!open) return;

    // 1) Entrou/voltou para uma call autorizada.
    // Se havia tolerância em andamento, cancela e mantém o ponto.
    if (newAllowed) {
      await cancelPendingLeave(guildId, userId);
      return;
    }

    // 2) Entrou na call AFK configurada.
    // Fecha imediatamente e publica "Entrou na call AFK".
    if (
      newChannelId &&
      afkChannelId &&
      newChannelId === afkChannelId
    ) {
      await closeImmediatelyForUnauthorized({
        guild: newState.guild,
        guildId,
        userId,
        key,
        endedAt: Date.now(),
        channelName: newState.channel?.name || 'AFK',
        reason: 'afk_voice'
      });
      return;
    }

    // 3) Está em uma call, mas ela NÃO é autorizada.
    // Fecha imediatamente, sem tolerância.
    // Vale tanto para mudança voluntária quanto para movimento por ADM.
    if (newChannelId && !newAllowed) {
      await closeImmediatelyForUnauthorized({
        guild: newState.guild,
        guildId,
        userId,
        key,
        endedAt: Date.now(),
        channelName: newState.channel?.name || null,
        reason: 'unauthorized_voice'
      });
      return;
    }

    // 4) Saiu completamente da call autorizada.
    // Aí sim começa a tolerância configurada para este servidor.
    if (oldAllowed && !newChannelId) {
      const existing = pendingVoiceLeaves.get(key);

      if (existing) {
        clearTimeout(existing.timer);
      }

      const leftAt = Date.now();

      const warningMessage = await sendLeaveWarning(
        oldState.guild,
        userId,
        oldState.channel?.name || 'Call autorizada'
      );

      const timer = setTimeout(() => {
        finalizePendingLeave(key, 'left_voice').catch(error => {
          console.error('❌ Erro ao fechar ponto após tolerância:', error);
        });
      }, voiceGraceSeconds * 1000);

      pendingVoiceLeaves.set(key, {
        guildId,
        userId,
        guild: oldState.guild,
        leftAt,
        fromChannelId: oldChannelId,
        fromChannelName: oldState.channel?.name || null,
        warningMessage,
        timer
      });

      console.log(
        `🟡 ${userId} saiu da call autorizada. ` +
        `Tolerância de ${voiceGraceSeconds}s iniciada.`
      );

      // Caso o audit log tenha chegado alguns ms antes do voiceState.
      const recentAdminAction = getRecentAdminVoiceAction(guildId);

      const sameGuildCandidates =
        [...pendingVoiceLeaves.entries()].filter(
          ([, pending]) =>
            pending.guildId === guildId &&
            Date.now() - pending.leftAt <= 6000
        );

      if (recentAdminAction && sameGuildCandidates.length === 1) {
        await finalizePendingLeave(
          key,
          'admin_voice_action'
        );
      }

      return;
    }

    // 5) Se já estava fora e continua fora, mantém o estado atual.
  } catch (error) {
    console.error('❌ Erro no VoiceStateUpdate:', error);
  }
});

client.login(TOKEN);
