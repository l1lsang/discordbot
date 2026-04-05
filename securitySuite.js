import {
  AuditLogEvent,
  EmbedBuilder,
  PermissionsBitField,
  SlashCommandBuilder,
} from "discord.js";
import admin from "firebase-admin";

const DEFAULT_SECURITY_CONFIG = {
  logChannelId: null,
  antiRaidEnabled: true,
  antiRaidJoinThreshold: 5,
  antiRaidWindowSeconds: 15,
  antiRaidAccountAgeMinutes: 1440,
  antiRaidModeMinutes: 10,
  antiRaidAction: "kick",
  antiNukeEnabled: true,
  antiNukeActionThreshold: 3,
  antiNukeWindowSeconds: 20,
  antiNukePunishment: "restrict",
  trustedRoleIds: [],
  trustedUserIds: [],
};

const DANGEROUS_PERMISSION_FLAGS = [
  PermissionsBitField.Flags.Administrator,
  PermissionsBitField.Flags.ManageGuild,
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.ManageWebhooks,
  PermissionsBitField.Flags.BanMembers,
  PermissionsBitField.Flags.KickMembers,
  PermissionsBitField.Flags.ModerateMembers,
];

const RAID_ACTION_CHOICES = [
  { name: "강퇴", value: "kick" },
  { name: "영구 밴", value: "ban" },
  { name: "1시간 타임아웃", value: "timeout" },
];

const NUKE_ACTION_CHOICES = [
  { name: "권한 박탈 + 7일 타임아웃", value: "restrict" },
  { name: "7일 타임아웃", value: "timeout" },
  { name: "강퇴", value: "kick" },
  { name: "영구 밴", value: "ban" },
];

const joinHistory = new Map();
const raidModeState = new Map();
const antiNukeActivity = new Map();
const antiNukeLocks = new Map();
const processedAuditEntries = new Map();

function uniq(values = []) {
  return [...new Set(values.map((value) => `${value}`.trim()).filter(Boolean))];
}

function getAdminRoleIdsFromEnv() {
  return uniq(process.env.ADMIN_ROLE_IDS?.split(",") || []);
}

function securityConfigRef(db, guildId) {
  return db.collection("guilds").doc(guildId).collection("config").doc("security");
}

function warningsRef(db, guildId, userId) {
  return db.collection("guilds").doc(guildId).collection("warnings").doc(userId);
}

function normalizeConfig(data = {}) {
  return {
    ...DEFAULT_SECURITY_CONFIG,
    ...data,
    trustedRoleIds: uniq(data.trustedRoleIds || []),
    trustedUserIds: uniq(data.trustedUserIds || []),
  };
}

async function getConfig(db, guildId) {
  const snap = await securityConfigRef(db, guildId).get();
  return normalizeConfig(snap.exists ? snap.data() : {});
}

async function saveConfig(db, guildId, patch) {
  await securityConfigRef(db, guildId).set(patch, { merge: true });
  return getConfig(db, guildId);
}

function formatMinutes(totalMinutes) {
  if (totalMinutes < 60) return `${totalMinutes}분`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}시간 ${minutes}분` : `${hours}시간`;
}

function formatSeconds(totalSeconds) {
  if (totalSeconds < 60) return `${totalSeconds}초`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}분 ${seconds}초` : `${minutes}분`;
}

function activeRaidState(guildId) {
  const state = raidModeState.get(guildId);
  if (!state) return null;
  if (state.expiresAt <= Date.now()) {
    raidModeState.delete(guildId);
    return null;
  }
  return state;
}

function pruneTimestamps(items, windowMs, now = Date.now()) {
  return items.filter((value) => now - value <= windowMs);
}

function pruneMap(map, maxAgeMs) {
  const now = Date.now();
  for (const [key, value] of map.entries()) {
    const timestamp =
      typeof value === "number"
        ? value
        : value?.createdAt ?? value?.at ?? value?.expiresAt ?? 0;
    if (timestamp && now - timestamp > maxAgeMs) {
      map.delete(key);
    }
  }
}

function hasDangerousPermissions(permissions) {
  return DANGEROUS_PERMISSION_FLAGS.some((flag) => permissions.has(flag));
}

function isTrustedActor(member, config) {
  if (!member) return false;
  if (member.id === member.guild.ownerId) return true;
  if (member.id === member.client.user.id) return true;
  if (config.trustedUserIds.includes(member.id)) return true;

  const trustedRoleIds = uniq([...getAdminRoleIdsFromEnv(), ...config.trustedRoleIds]);
  return member.roles.cache.some((role) => trustedRoleIds.includes(role.id));
}

async function resolveLogChannel(guild, config) {
  const channelId = config.logChannelId || guild.systemChannelId;
  if (!channelId) return null;

  const cached = guild.channels.cache.get(channelId);
  if (cached?.isTextBased()) return cached;

  const fetched = await guild.channels.fetch(channelId).catch(() => null);
  return fetched?.isTextBased() ? fetched : null;
}

async function sendLog(guild, config, title, description, severity = "info") {
  const channel = await resolveLogChannel(guild, config);
  if (!channel) return;

  const colors = {
    info: 0x4f8cff,
    success: 0x2fbf71,
    warning: 0xf5a524,
    danger: 0xf54d4d,
  };

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(colors[severity] || colors.info)
    .setTimestamp();

  await channel.send({ embeds: [embed] }).catch(() => null);
}

function blockByHierarchy(actorMember, targetMember, label) {
  if (!targetMember) return `❌ ${label}할 수 없는 대상입니다.`;
  if (targetMember.id === actorMember.id) return `❌ 자기 자신은 ${label}할 수 없습니다.`;
  if (targetMember.id === targetMember.guild.ownerId) return `❌ 서버 소유자는 ${label}할 수 없습니다.`;
  if (
    actorMember.id !== targetMember.guild.ownerId &&
    targetMember.roles.highest.position >= actorMember.roles.highest.position
  ) {
    return `❌ 본인보다 높거나 같은 역할의 멤버는 ${label}할 수 없습니다.`;
  }
  return null;
}

async function fetchTargetMember(guild, userId) {
  return guild.members.fetch(userId).catch(() => null);
}

async function applyPunishment(member, action, reason, timeoutMs = 60 * 60 * 1000) {
  if (action === "ban") {
    if (!member.bannable) return null;
    await member.ban({ reason, deleteMessageSeconds: 0 });
    return "영구 밴";
  }

  if (action === "kick") {
    if (!member.kickable) return null;
    await member.kick(reason);
    return "강퇴";
  }

  if (action === "timeout") {
    if (!member.moderatable) return null;
    await member.timeout(timeoutMs, reason);
    return `타임아웃 (${formatMinutes(Math.max(1, Math.round(timeoutMs / 60000)))})`;
  }

  return null;
}

async function applyNukePunishment(member, action, reason) {
  if (action !== "restrict") {
    return applyPunishment(member, action, reason, 7 * 24 * 60 * 60 * 1000);
  }

  const results = [];
  const removableRoles = member.roles.cache.filter(
    (role) =>
      role.id !== member.guild.id &&
      !role.managed &&
      role.editable &&
      hasDangerousPermissions(role.permissions)
  );

  if (removableRoles.size) {
    await member.roles.remove(removableRoles, reason).catch(() => null);
    results.push(`위험 권한 역할 ${removableRoles.size}개 제거`);
  }

  if (member.moderatable) {
    await member.timeout(7 * 24 * 60 * 60 * 1000, reason).catch(() => null);
    results.push("7일 타임아웃");
  }

  return results.length ? results.join(", ") : null;
}

async function getWarnings(db, guildId, userId) {
  const snap = await warningsRef(db, guildId, userId).get();
  if (!snap.exists) return { count: 0, items: [] };
  const data = snap.data();
  return {
    count: Number(data.count || 0),
    items: Array.isArray(data.items) ? data.items : [],
  };
}

async function addWarning(db, guildId, targetUser, moderator, reason) {
  const current = await getWarnings(db, guildId, targetUser.id);
  const next = {
    count: current.count + 1,
    items: [
      ...current.items,
      {
        reason,
        moderatorId: moderator.id,
        moderatorTag: moderator.tag,
        createdAt: new Date().toISOString(),
      },
    ].slice(-20),
  };

  await warningsRef(db, guildId, targetUser.id).set(
    {
      ...next,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return next;
}

async function clearWarnings(db, guildId, userId) {
  await warningsRef(db, guildId, userId).set(
    {
      count: 0,
      items: [],
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

function formatWarnings(data) {
  if (!data.items.length) return "경고 기록이 없습니다.";
  return data.items
    .slice(-5)
    .reverse()
    .map((item, index) => {
      const createdAt = item.createdAt
        ? new Date(item.createdAt).toLocaleString("ko-KR")
        : "시간 정보 없음";
      return `${index + 1}. ${item.reason} | ${item.moderatorTag} | ${createdAt}`;
    })
    .join("\n");
}

function securitySummary(config, guild) {
  const trustedRoles = uniq([...getAdminRoleIdsFromEnv(), ...config.trustedRoleIds]);
  const raidState = activeRaidState(guild.id);
  return [
    `로그 채널: ${config.logChannelId ? `<#${config.logChannelId}>` : "미설정"}`,
    `Anti-Raid: ${config.antiRaidEnabled ? "ON" : "OFF"}`,
    `- 감지 기준: ${formatSeconds(config.antiRaidWindowSeconds)} 안에 ${config.antiRaidJoinThreshold}명`,
    `- 유지 시간: ${formatMinutes(config.antiRaidModeMinutes)}`,
    `- 새 계정 기준: ${config.antiRaidAccountAgeMinutes ? formatMinutes(config.antiRaidAccountAgeMinutes) : "제한 없음"}`,
    `- 대응 방식: ${config.antiRaidAction}`,
    `- 현재 Raid Mode: ${
      raidState
        ? `활성 (약 ${formatMinutes(Math.max(1, Math.ceil((raidState.expiresAt - Date.now()) / 60000)))})`
        : "비활성"
    }`,
    `Anti-Nuke: ${config.antiNukeEnabled ? "ON" : "OFF"}`,
    `- 감지 기준: ${formatSeconds(config.antiNukeWindowSeconds)} 안에 ${config.antiNukeActionThreshold}회`,
    `- 대응 방식: ${config.antiNukePunishment}`,
    `신뢰 역할: ${trustedRoles.length ? trustedRoles.map((id) => `<@&${id}>`).join(", ") : "없음"}`,
    `신뢰 유저: ${config.trustedUserIds.length ? config.trustedUserIds.map((id) => `<@${id}>`).join(", ") : "없음"}`,
  ].join("\n");
}

export const securityCommandBuilders = [
  new SlashCommandBuilder()
    .setName("킥")
    .setDescription("유저를 서버에서 강퇴합니다")
    .addUserOption((option) => option.setName("대상").setDescription("강퇴할 유저").setRequired(true))
    .addStringOption((option) => option.setName("reason").setDescription("강퇴 사유").setRequired(false))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.KickMembers),
  new SlashCommandBuilder()
    .setName("타임아웃")
    .setDescription("유저를 일정 시간 동안 타임아웃합니다")
    .addUserOption((option) => option.setName("대상").setDescription("타임아웃할 유저").setRequired(true))
    .addIntegerOption((option) =>
      option.setName("분").setDescription("타임아웃 시간(분)").setRequired(true).setMinValue(1).setMaxValue(40320)
    )
    .addStringOption((option) => option.setName("reason").setDescription("타임아웃 사유").setRequired(false))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
  new SlashCommandBuilder()
    .setName("타임아웃해제")
    .setDescription("유저의 타임아웃을 해제합니다")
    .addUserOption((option) => option.setName("대상").setDescription("타임아웃을 해제할 유저").setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
  new SlashCommandBuilder()
    .setName("경고")
    .setDescription("유저에게 경고를 부여합니다")
    .addUserOption((option) => option.setName("대상").setDescription("경고할 유저").setRequired(true))
    .addStringOption((option) => option.setName("reason").setDescription("경고 사유").setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
  new SlashCommandBuilder()
    .setName("경고확인")
    .setDescription("유저의 경고 내역을 확인합니다")
    .addUserOption((option) => option.setName("대상").setDescription("확인할 유저").setRequired(false)),
  new SlashCommandBuilder()
    .setName("경고초기화")
    .setDescription("유저의 경고 내역을 초기화합니다")
    .addUserOption((option) => option.setName("대상").setDescription("초기화할 유저").setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
  new SlashCommandBuilder()
    .setName("보안설정")
    .setDescription("Anti-Raid / Anti-Nuke / 로그 채널을 설정합니다")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addSubcommand((sub) => sub.setName("보기").setDescription("현재 보안 설정을 확인합니다"))
    .addSubcommand((sub) =>
      sub
        .setName("로그채널")
        .setDescription("보안 로그 채널을 설정합니다")
        .addChannelOption((option) => option.setName("채널").setDescription("보안 로그 채널").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("안티레이드")
        .setDescription("Anti-Raid 설정을 변경합니다")
        .addBooleanOption((option) => option.setName("활성화").setDescription("활성화 여부").setRequired(false))
        .addIntegerOption((option) => option.setName("탐지개수").setDescription("감지 입장 수").setRequired(false).setMinValue(2).setMaxValue(20))
        .addIntegerOption((option) => option.setName("시간초").setDescription("감지 시간 범위").setRequired(false).setMinValue(5).setMaxValue(300))
        .addIntegerOption((option) => option.setName("계정나이분").setDescription("새 계정 기준").setRequired(false).setMinValue(0).setMaxValue(40320))
        .addIntegerOption((option) => option.setName("유지분").setDescription("Raid Mode 유지 시간").setRequired(false).setMinValue(1).setMaxValue(180))
        .addStringOption((option) => option.setName("액션").setDescription("자동 대응 방식").setRequired(false).addChoices(...RAID_ACTION_CHOICES))
    )
    .addSubcommand((sub) =>
      sub
        .setName("안티누크")
        .setDescription("Anti-Nuke 설정을 변경합니다")
        .addBooleanOption((option) => option.setName("활성화").setDescription("활성화 여부").setRequired(false))
        .addIntegerOption((option) => option.setName("탐지개수").setDescription("감지 액션 수").setRequired(false).setMinValue(2).setMaxValue(20))
        .addIntegerOption((option) => option.setName("시간초").setDescription("감지 시간 범위").setRequired(false).setMinValue(5).setMaxValue(300))
        .addStringOption((option) => option.setName("액션").setDescription("자동 대응 방식").setRequired(false).addChoices(...NUKE_ACTION_CHOICES))
    )
    .addSubcommand((sub) =>
      sub
        .setName("허용역할추가")
        .setDescription("Anti-Nuke 제외 역할을 추가합니다")
        .addRoleOption((option) => option.setName("역할").setDescription("신뢰할 역할").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("허용역할제거")
        .setDescription("Anti-Nuke 제외 역할을 제거합니다")
        .addRoleOption((option) => option.setName("역할").setDescription("제거할 역할").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("허용유저추가")
        .setDescription("Anti-Nuke 제외 유저를 추가합니다")
        .addUserOption((option) => option.setName("유저").setDescription("신뢰할 유저").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("허용유저제거")
        .setDescription("Anti-Nuke 제외 유저를 제거합니다")
        .addUserOption((option) => option.setName("유저").setDescription("제거할 유저").setRequired(true))
    ),
];

async function fetchRecentAuditEntry(guild, auditType, targetId) {
  await new Promise((resolve) => setTimeout(resolve, 1200));
  pruneMap(processedAuditEntries, 60 * 60 * 1000);

  const logs = await guild.fetchAuditLogs({ type: auditType, limit: 6 }).catch(() => null);
  if (!logs) return null;

  const now = Date.now();
  for (const entry of logs.entries.values()) {
    if (!entry.id || !entry.executorId) continue;
    if (processedAuditEntries.has(entry.id)) continue;
    if (targetId && entry.targetId && `${entry.targetId}` !== `${targetId}`) continue;
    if (now - entry.createdTimestamp > 15000) continue;

    processedAuditEntries.set(entry.id, now);
    return entry;
  }

  return null;
}

async function handleAntiRaid(member, db) {
  if (!member.guild || member.user.bot) return;

  const config = await getConfig(db, member.guild.id);
  if (!config.antiRaidEnabled) return;

  const now = Date.now();
  const history = pruneTimestamps(
    joinHistory.get(member.guild.id) || [],
    config.antiRaidWindowSeconds * 1000,
    now
  );

  history.push(now);
  joinHistory.set(member.guild.id, history);

  if (history.length >= config.antiRaidJoinThreshold) {
    raidModeState.set(member.guild.id, {
      createdAt: now,
      expiresAt: now + config.antiRaidModeMinutes * 60 * 1000,
    });

    await sendLog(
      member.guild,
      config,
      "Anti-Raid 발동",
      [
        `${formatSeconds(config.antiRaidWindowSeconds)} 안에 ${history.length}명이 입장했습니다.`,
        `Raid Mode 유지 시간: ${formatMinutes(config.antiRaidModeMinutes)}`,
        `대응 방식: ${config.antiRaidAction}`,
      ].join("\n"),
      "warning"
    );
  }

  if (!activeRaidState(member.guild.id)) return;

  const accountAgeMinutes = Math.floor((now - member.user.createdTimestamp) / 60000);
  const suspicious =
    config.antiRaidAccountAgeMinutes === 0 ||
    accountAgeMinutes <= config.antiRaidAccountAgeMinutes;

  if (!suspicious) return;

  const result = await applyPunishment(
    member,
    config.antiRaidAction,
    `Anti-raid 보호: ${history.length}명의 연속 입장 감지`,
    60 * 60 * 1000
  );

  await sendLog(
    member.guild,
    config,
    result ? "Anti-Raid 조치 완료" : "Anti-Raid 경고",
    result
      ? [`대상: <@${member.id}>`, `계정 생성 후 경과 시간: ${Math.max(accountAgeMinutes, 0)}분`, `조치: ${result}`].join("\n")
      : [`대상: <@${member.id}>`, "권한 또는 역할 우선순위 문제로 자동 조치를 하지 못했습니다."].join("\n"),
    result ? "danger" : "warning"
  );
}

async function handleAntiNuke(guild, meta, db) {
  const config = await getConfig(db, guild.id);
  if (!config.antiNukeEnabled) return;

  const entry = await fetchRecentAuditEntry(guild, meta.auditType, meta.targetId);
  if (!entry) return;

  const executor = await guild.members.fetch(entry.executorId).catch(() => null);
  if (!executor || isTrustedActor(executor, config)) return;

  const key = `${guild.id}:${executor.id}`;
  const now = Date.now();
  const history = (antiNukeActivity.get(key) || []).filter(
    (item) => now - item.at <= config.antiNukeWindowSeconds * 1000
  );

  history.push({ at: now, label: meta.label });
  antiNukeActivity.set(key, history);

  if (history.length < config.antiNukeActionThreshold) {
    if (history.length === config.antiNukeActionThreshold - 1) {
      await sendLog(
        guild,
        config,
        "Anti-Nuke 사전 경고",
        [
          `실행자: <@${executor.id}>`,
          `최근 액션: ${history.map((item) => item.label).join(", ")}`,
          "다음 위험 액션이 감지되면 자동 제재가 실행됩니다.",
        ].join("\n"),
        "warning"
      );
    }
    return;
  }

  pruneMap(antiNukeLocks, 10 * 60 * 1000);
  if (antiNukeLocks.has(key) && now - antiNukeLocks.get(key) < 10 * 60 * 1000) {
    return;
  }

  antiNukeLocks.set(key, now);

  const result = await applyNukePunishment(
    executor,
    config.antiNukePunishment,
    `Anti-nuke 보호: 짧은 시간 안에 ${history.length}회 위험 액션 감지`
  );

  await sendLog(
    guild,
    config,
    result ? "Anti-Nuke 조치 완료" : "Anti-Nuke 경고",
    result
      ? [`실행자: <@${executor.id}>`, `감지된 액션: ${history.map((item) => item.label).join(", ")}`, `조치: ${result}`].join("\n")
      : [`실행자: <@${executor.id}>`, "위험 액션은 감지했지만 자동 제재에 실패했습니다."].join("\n"),
    result ? "danger" : "warning"
  );
}

export function registerSecurityHandlers(client, db) {
  client.on("guildMemberAdd", async (member) => {
    try {
      await handleAntiRaid(member, db);
    } catch (error) {
      console.error("🚨 Anti-Raid 처리 오류:", error);
    }
  });

  client.on("channelDelete", async (channel) => {
    if (!channel.guild) return;
    try {
      await handleAntiNuke(
        channel.guild,
        { auditType: AuditLogEvent.ChannelDelete, targetId: channel.id, label: `채널 삭제 (${channel.name})` },
        db
      );
    } catch (error) {
      console.error("🚨 channelDelete Anti-Nuke 오류:", error);
    }
  });

  client.on("channelCreate", async (channel) => {
    if (!channel.guild) return;
    try {
      await handleAntiNuke(
        channel.guild,
        { auditType: AuditLogEvent.ChannelCreate, targetId: channel.id, label: `채널 생성 (${channel.name})` },
        db
      );
    } catch (error) {
      console.error("🚨 channelCreate Anti-Nuke 오류:", error);
    }
  });

  client.on("roleDelete", async (role) => {
    try {
      await handleAntiNuke(
        role.guild,
        { auditType: AuditLogEvent.RoleDelete, targetId: role.id, label: `역할 삭제 (${role.name})` },
        db
      );
    } catch (error) {
      console.error("🚨 roleDelete Anti-Nuke 오류:", error);
    }
  });

  client.on("roleCreate", async (role) => {
    try {
      await handleAntiNuke(
        role.guild,
        { auditType: AuditLogEvent.RoleCreate, targetId: role.id, label: `역할 생성 (${role.name})` },
        db
      );
    } catch (error) {
      console.error("🚨 roleCreate Anti-Nuke 오류:", error);
    }
  });

  client.on("guildBanAdd", async (ban) => {
    try {
      await handleAntiNuke(
        ban.guild,
        { auditType: AuditLogEvent.MemberBanAdd, targetId: ban.user.id, label: `멤버 밴 (${ban.user.tag})` },
        db
      );
    } catch (error) {
      console.error("🚨 guildBanAdd Anti-Nuke 오류:", error);
    }
  });
}

export async function handleSecurityCommand({ interaction, guild, member, db }) {
  switch (interaction.commandName) {
    case "킥": {
      await interaction.deferReply({ ephemeral: true });
      if (!member.permissions.has(PermissionsBitField.Flags.KickMembers)) {
        await interaction.editReply("⛔ 강퇴 권한이 있는 관리자만 사용할 수 있습니다.");
        return true;
      }

      const targetUser = interaction.options.getUser("대상", true);
      const reason = interaction.options.getString("reason")?.trim() || "사유 미입력";
      const targetMember = await fetchTargetMember(guild, targetUser.id);

      if (!targetMember) {
        await interaction.editReply("❌ 현재 서버에 없는 유저입니다.");
        return true;
      }

      const blocked = blockByHierarchy(member, targetMember, "강퇴");
      if (blocked) {
        await interaction.editReply(blocked);
        return true;
      }

      if (!targetMember.kickable) {
        await interaction.editReply("❌ 봇 권한 또는 역할 우선순위 때문에 강퇴할 수 없습니다.");
        return true;
      }

      await targetMember.kick(`${reason} | 처리자: ${interaction.user.tag} (${interaction.user.id})`);
      await interaction.editReply(`👢 ${targetUser.tag} 님을 강퇴했습니다.\n사유: ${reason}`);
      return true;
    }

    case "타임아웃": {
      await interaction.deferReply({ ephemeral: true });
      if (!member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        await interaction.editReply("⛔ 타임아웃 권한이 있는 관리자만 사용할 수 있습니다.");
        return true;
      }

      const targetUser = interaction.options.getUser("대상", true);
      const minutes = interaction.options.getInteger("분", true);
      const reason = interaction.options.getString("reason")?.trim() || "사유 미입력";
      const targetMember = await fetchTargetMember(guild, targetUser.id);

      if (!targetMember) {
        await interaction.editReply("❌ 현재 서버에 없는 유저입니다.");
        return true;
      }

      const blocked = blockByHierarchy(member, targetMember, "타임아웃");
      if (blocked) {
        await interaction.editReply(blocked);
        return true;
      }

      if (!targetMember.moderatable) {
        await interaction.editReply("❌ 봇 권한 또는 역할 우선순위 때문에 타임아웃할 수 없습니다.");
        return true;
      }

      await targetMember.timeout(
        minutes * 60 * 1000,
        `${reason} | 처리자: ${interaction.user.tag} (${interaction.user.id})`
      );
      await interaction.editReply(`⏳ ${targetUser.tag} 님을 ${formatMinutes(minutes)} 동안 타임아웃했습니다.\n사유: ${reason}`);
      return true;
    }

    case "타임아웃해제": {
      await interaction.deferReply({ ephemeral: true });
      if (!member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        await interaction.editReply("⛔ 타임아웃 해제 권한이 있는 관리자만 사용할 수 있습니다.");
        return true;
      }

      const targetUser = interaction.options.getUser("대상", true);
      const targetMember = await fetchTargetMember(guild, targetUser.id);

      if (!targetMember) {
        await interaction.editReply("❌ 현재 서버에 없는 유저입니다.");
        return true;
      }

      const blocked = blockByHierarchy(member, targetMember, "타임아웃 해제");
      if (blocked) {
        await interaction.editReply(blocked);
        return true;
      }

      if (!targetMember.moderatable) {
        await interaction.editReply("❌ 봇 권한 또는 역할 우선순위 때문에 타임아웃을 해제할 수 없습니다.");
        return true;
      }

      await targetMember.timeout(null, `처리자: ${interaction.user.tag} (${interaction.user.id})`);
      await interaction.editReply(`✅ ${targetUser.tag} 님의 타임아웃을 해제했습니다.`);
      return true;
    }

    case "경고": {
      await interaction.deferReply({ ephemeral: true });
      if (!member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        await interaction.editReply("⛔ 경고를 부여할 권한이 없습니다.");
        return true;
      }

      const targetUser = interaction.options.getUser("대상", true);
      const reason = interaction.options.getString("reason", true).trim();
      const targetMember = await fetchTargetMember(guild, targetUser.id);

      if (targetMember) {
        const blocked = blockByHierarchy(member, targetMember, "경고");
        if (blocked) {
          await interaction.editReply(blocked);
          return true;
        }
      }

      const warnings = await addWarning(db, guild.id, targetUser, interaction.user, reason);
      await interaction.editReply(`⚠️ ${targetUser.tag} 님에게 경고를 부여했습니다.\n누적 경고: ${warnings.count}회\n사유: ${reason}`);
      return true;
    }

    case "경고확인": {
      const targetUser = interaction.options.getUser("대상") || interaction.user;
      if (
        targetUser.id !== interaction.user.id &&
        !member.permissions.has(PermissionsBitField.Flags.ModerateMembers)
      ) {
        await interaction.reply({
          content: "⛔ 다른 유저의 경고 내역은 관리자만 확인할 수 있습니다.",
          ephemeral: true,
        });
        return true;
      }

      const warnings = await getWarnings(db, guild.id, targetUser.id);
      await interaction.reply({
        content: [`⚠️ **${targetUser.tag}**`, `누적 경고: ${warnings.count}회`, "", formatWarnings(warnings)].join("\n"),
        ephemeral: true,
      });
      return true;
    }

    case "경고초기화": {
      await interaction.deferReply({ ephemeral: true });
      if (!member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        await interaction.editReply("⛔ 경고 초기화 권한이 없습니다.");
        return true;
      }

      const targetUser = interaction.options.getUser("대상", true);
      const targetMember = await fetchTargetMember(guild, targetUser.id);

      if (targetMember) {
        const blocked = blockByHierarchy(member, targetMember, "경고 초기화");
        if (blocked) {
          await interaction.editReply(blocked);
          return true;
        }
      }

      await clearWarnings(db, guild.id, targetUser.id);
      await interaction.editReply(`🧹 ${targetUser.tag} 님의 경고 내역을 초기화했습니다.`);
      return true;
    }

    case "보안설정": {
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === "보기") {
        const config = await getConfig(db, guild.id);
        await interaction.reply({
          content: `🛡️ **현재 보안 설정**\n${securitySummary(config, guild)}`,
          ephemeral: true,
        });
        return true;
      }

      if (subcommand === "로그채널") {
        const channel = interaction.options.getChannel("채널", true);
        if (!channel.isTextBased()) {
          await interaction.reply({
            content: "❌ 텍스트 채널만 로그 채널로 지정할 수 있습니다.",
            ephemeral: true,
          });
          return true;
        }

        const config = await saveConfig(db, guild.id, { logChannelId: channel.id });
        await interaction.reply({
          content: `✅ 보안 로그 채널을 ${channel} 로 설정했습니다.\n\n${securitySummary(config, guild)}`,
          ephemeral: true,
        });
        return true;
      }

      if (subcommand === "안티레이드") {
        const patch = {};
        const enabled = interaction.options.getBoolean("활성화");
        const threshold = interaction.options.getInteger("탐지개수");
        const windowSeconds = interaction.options.getInteger("시간초");
        const accountAgeMinutes = interaction.options.getInteger("계정나이분");
        const modeMinutes = interaction.options.getInteger("유지분");
        const action = interaction.options.getString("액션");

        if (enabled !== null) patch.antiRaidEnabled = enabled;
        if (threshold !== null) patch.antiRaidJoinThreshold = threshold;
        if (windowSeconds !== null) patch.antiRaidWindowSeconds = windowSeconds;
        if (accountAgeMinutes !== null) patch.antiRaidAccountAgeMinutes = accountAgeMinutes;
        if (modeMinutes !== null) patch.antiRaidModeMinutes = modeMinutes;
        if (action) patch.antiRaidAction = action;

        if (!Object.keys(patch).length) {
          await interaction.reply({ content: "ℹ️ 변경할 값을 하나 이상 입력해주세요.", ephemeral: true });
          return true;
        }

        const config = await saveConfig(db, guild.id, patch);
        await interaction.reply({
          content: `✅ Anti-Raid 설정을 저장했습니다.\n\n${securitySummary(config, guild)}`,
          ephemeral: true,
        });
        return true;
      }

      if (subcommand === "안티누크") {
        const patch = {};
        const enabled = interaction.options.getBoolean("활성화");
        const threshold = interaction.options.getInteger("탐지개수");
        const windowSeconds = interaction.options.getInteger("시간초");
        const action = interaction.options.getString("액션");

        if (enabled !== null) patch.antiNukeEnabled = enabled;
        if (threshold !== null) patch.antiNukeActionThreshold = threshold;
        if (windowSeconds !== null) patch.antiNukeWindowSeconds = windowSeconds;
        if (action) patch.antiNukePunishment = action;

        if (!Object.keys(patch).length) {
          await interaction.reply({ content: "ℹ️ 변경할 값을 하나 이상 입력해주세요.", ephemeral: true });
          return true;
        }

        const config = await saveConfig(db, guild.id, patch);
        await interaction.reply({
          content: `✅ Anti-Nuke 설정을 저장했습니다.\n\n${securitySummary(config, guild)}`,
          ephemeral: true,
        });
        return true;
      }

      if (subcommand === "허용역할추가" || subcommand === "허용역할제거") {
        const role = interaction.options.getRole("역할", true);
        const current = await getConfig(db, guild.id);
        const trustedRoleIds =
          subcommand === "허용역할추가"
            ? uniq([...current.trustedRoleIds, role.id])
            : current.trustedRoleIds.filter((roleId) => roleId !== role.id);

        const config = await saveConfig(db, guild.id, { trustedRoleIds });
        await interaction.reply({
          content: `✅ 신뢰 역할 목록을 업데이트했습니다.\n\n${securitySummary(config, guild)}`,
          ephemeral: true,
        });
        return true;
      }

      if (subcommand === "허용유저추가" || subcommand === "허용유저제거") {
        const user = interaction.options.getUser("유저", true);
        const current = await getConfig(db, guild.id);
        const trustedUserIds =
          subcommand === "허용유저추가"
            ? uniq([...current.trustedUserIds, user.id])
            : current.trustedUserIds.filter((userId) => userId !== user.id);

        const config = await saveConfig(db, guild.id, { trustedUserIds });
        await interaction.reply({
          content: `✅ 신뢰 유저 목록을 업데이트했습니다.\n\n${securitySummary(config, guild)}`,
          ephemeral: true,
        });
        return true;
      }

      return true;
    }

    default:
      return false;
  }
}
