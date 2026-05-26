import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionsBitField,
  SlashCommandBuilder,
  REST,
  Routes,
  StringSelectMenuBuilder,
} from "discord.js";
import express from "express";
import cors from "cors";
import "dotenv/config";

import admin from "firebase-admin";
import {
  handleSecurityCommand,
  registerSecurityHandlers,
  securityCommandBuilders,
} from "./securitySuite.js";

// =======================
// 🔥 Firebase 초기화 (Render 환경변수)
// =======================
const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// =======================
// 🌐 Express API 서버
// =======================
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

// =======================
// 🤖 Discord Bot
// =======================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const CONSULT_TYPE_OPTIONS = [
  "학업 · 진로",
  "인간관계",
  "연애 · 가족",
  "감정 기복 · 번아웃",
  "기타",
];

const DEFAULT_LEAVE_LOG_MESSAGE = "{user} 님이 서버를 떠났습니다.";
const USER_MENTION_TOKEN_PATTERN =
  /\{(?:user|mention|tag|username|displayName)\}/;

registerSecurityHandlers(client, db);

const VOICE_SCORE_UNIT_MS = 60 * 1000;
const RANKING_PAGE_SIZE = 10;
const RANKING_TYPES = new Set(["activity", "voice", "bump"]);
const DISBOARD_BOT_IDS = new Set(
  (process.env.DISBOARD_BOT_IDS ||
    process.env.DISBOARD_BOT_ID ||
    "302050872383242240")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);
const BUMP_CLAIM_WINDOW_MINUTES = Math.max(
  1,
  toNumber(process.env.BUMP_CLAIM_WINDOW_MINUTES, 10)
);
const BUMP_CLAIM_WINDOW_MS = BUMP_CLAIM_WINDOW_MINUTES * 60 * 1000;
const BUMP_CLAIM_BUTTON_PREFIX = "bump-claim:";
const activeVoiceSessions = new Map();

function getVoiceSessionKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function leaveLogConfigRef(guildId) {
  return db
    .collection("guilds")
    .doc(guildId)
    .collection("config")
    .doc("leaveLog");
}

function normalizeLeaveLogConfig(data = {}) {
  const message =
    typeof data.message === "string" && data.message.trim()
      ? data.message.trim()
      : DEFAULT_LEAVE_LOG_MESSAGE;

  return {
    channelId: data.channelId || null,
    message,
  };
}

async function getLeaveLogConfig(guildId) {
  const snap = await leaveLogConfigRef(guildId).get();
  return normalizeLeaveLogConfig(snap.exists ? snap.data() : {});
}

async function saveLeaveLogConfig(guildId, patch) {
  await leaveLogConfigRef(guildId).set(patch, { merge: true });
  return getLeaveLogConfig(guildId);
}

async function resolveLeaveLogChannel(guild, channelId) {
  if (!channelId) return null;

  const cached = guild.channels.cache.get(channelId);
  if (cached?.isTextBased()) return cached;

  const fetched = await guild.channels.fetch(channelId).catch(() => null);
  return fetched?.isTextBased() ? fetched : null;
}

function replaceAllText(text, search, replacement) {
  return text.split(search).join(replacement);
}

function formatLeaveLogMessage(template, member) {
  const mention = `<@${member.id}>`;
  const joinedAt = member.joinedTimestamp
    ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`
    : "알 수 없음";

  let message = template.trim() || DEFAULT_LEAVE_LOG_MESSAGE;
  const hasUserMarker =
    USER_MENTION_TOKEN_PATTERN.test(message) || message.includes("@님");

  const replacements = {
    "{user}": mention,
    "{mention}": mention,
    "{tag}": member.user.tag,
    "{username}": member.user.username,
    "{displayName}": member.displayName || member.user.username,
    "{server}": member.guild.name,
    "{memberCount}": `${member.guild.memberCount}`,
    "{joinedAt}": joinedAt,
  };

  message = replaceAllText(message, "@님", `${mention}님`);

  for (const [token, value] of Object.entries(replacements)) {
    message = replaceAllText(message, token, value);
  }

  return hasUserMarker ? message : `${mention} ${message}`;
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function timestampToMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value.seconds === "number") {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1000000);
  }
  return null;
}

function getActivityScore(count, voiceMs) {
  return toNumber(count) + Math.floor(toNumber(voiceMs) / VOICE_SCORE_UNIT_MS);
}

function getEffectiveVoiceMs(data, guildId, userId, now = Date.now()) {
  const voiceMs = toNumber(data?.voiceMs);
  const sessionKey = getVoiceSessionKey(guildId, userId);
  const memoryStartedAt = activeVoiceSessions.get(sessionKey);
  const storedStartedAt = timestampToMillis(data?.voiceSessionStartedAt);
  const startedAt = memoryStartedAt || storedStartedAt;

  if (!startedAt) return voiceMs;
  return voiceMs + Math.max(0, now - startedAt);
}

function formatDuration(ms) {
  const totalMinutes = Math.floor(toNumber(ms) / 60000);

  if (totalMinutes <= 0) {
    return "1분 미만";
  }

  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}일 ${hours}시간 ${minutes}분`;
  }

  if (hours > 0) {
    return `${hours}시간 ${minutes}분`;
  }

  return `${minutes}분`;
}

function formatDiscordRelativeTime(value) {
  const millis = timestampToMillis(value);
  if (!millis) return null;

  return `<t:${Math.floor(millis / 1000)}:R>`;
}

function getMessageSearchText(message) {
  const embedTexts = message.embeds.flatMap((embed) => [
    embed.title,
    embed.description,
    embed.author?.name,
    embed.footer?.text,
    ...(embed.fields?.flatMap((field) => [field.name, field.value]) || []),
  ]);

  return [message.content, ...embedTexts].filter(Boolean).join("\n");
}

function isDisboardBumpDoneMessage(message) {
  if (!message.guild || !DISBOARD_BOT_IDS.has(message.author.id)) {
    return false;
  }

  const text = getMessageSearchText(message).toLowerCase();

  return (
    /\bbump done\b/.test(text) ||
    /\bsuccessfully bumped\b/.test(text) ||
    /\bbumped successfully\b/.test(text) ||
    /\bthanks for bumping\b/.test(text)
  );
}

function resolveInteractionMetadataUserId(metadata) {
  let current = metadata;

  while (current) {
    if (current.user?.id) {
      return current.user.id;
    }

    current = current.triggeringInteractionMetadata;
  }

  return null;
}

async function resolveReplyAuthorId(message) {
  const repliedUser = message.mentions.repliedUser;

  if (repliedUser && !repliedUser.bot && repliedUser.id !== message.author.id) {
    return repliedUser.id;
  }

  if (!message.reference?.messageId) {
    return null;
  }

  const referencedMessage = await message.fetchReference().catch((error) => {
    console.warn("⚠️ DISBOARD bump 답장 원본 조회 실패:", error);
    return null;
  });

  const author = referencedMessage?.author;
  return author && !author.bot && author.id !== message.author.id
    ? author.id
    : null;
}

async function resolveDisboardBumperId(message) {
  const replyAuthorId = await resolveReplyAuthorId(message);

  if (replyAuthorId) {
    return replyAuthorId;
  }

  const interactionUserId =
    resolveInteractionMetadataUserId(message.interactionMetadata) ||
    message.interaction?.user?.id;

  if (interactionUserId && interactionUserId !== message.author.id) {
    return interactionUserId;
  }

  const mentionedUser = message.mentions.users.find(
    (user) => !user.bot && user.id !== message.author.id
  );

  if (mentionedUser) {
    return mentionedUser.id;
  }

  const mentionMatch = getMessageSearchText(message).match(/<@!?(\d{17,20})>/);
  return mentionMatch?.[1] || null;
}

function bumpEventsRef(guildId) {
  return db
    .collection("guilds")
    .doc(guildId)
    .collection("bumpEvents");
}

function bumpEventRef(guildId, bumpMessageId) {
  return bumpEventsRef(guildId).doc(bumpMessageId);
}

function createBumpEventPatch(message) {
  const messageCreatedAtMs = message.createdTimestamp || Date.now();

  return {
    bumpMessageId: message.id,
    channelId: message.channelId,
    disboardBotId: message.author.id,
    referenceMessageId: message.reference?.messageId || null,
    referenceChannelId: message.reference?.channelId || null,
    bumpMessageCreatedAt:
      admin.firestore.Timestamp.fromMillis(messageCreatedAtMs),
    claimExpiresAt:
      admin.firestore.Timestamp.fromMillis(
        messageCreatedAtMs + BUMP_CLAIM_WINDOW_MS
      ),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function isBumpEventExpired(data, now = Date.now()) {
  const expiresAt = timestampToMillis(data?.claimExpiresAt);

  if (expiresAt) {
    return now > expiresAt;
  }

  const createdAt =
    timestampToMillis(data?.bumpMessageCreatedAt) ||
    timestampToMillis(data?.createdAt);

  return createdAt ? now - createdAt > BUMP_CLAIM_WINDOW_MS : false;
}

function buildBumpClaimRow(bumpMessageId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BUMP_CLAIM_BUTTON_PREFIX}${bumpMessageId}`)
      .setLabel("내 bump로 기록")
      .setEmoji("🚀")
      .setStyle(ButtonStyle.Primary)
  );
}

async function recordBumpForMember(message, member, source) {
  const eventRef = bumpEventRef(message.guild.id, message.id);
  const userRef = db
    .collection("guilds")
    .doc(message.guild.id)
    .collection("users")
    .doc(member.id);

  let result = {
    recorded: false,
    alreadyRecorded: false,
    bumpCount: 0,
    bumperId: null,
  };

  await db.runTransaction(async (transaction) => {
    const eventSnap = await transaction.get(eventRef);
    const eventData = eventSnap.exists ? eventSnap.data() : {};

    if (eventData.status === "recorded") {
      result = {
        recorded: false,
        alreadyRecorded: true,
        bumpCount: 0,
        bumperId: eventData.bumperId || null,
      };
      return;
    }

    const userSnap = await transaction.get(userRef);
    const prev = userSnap.exists ? userSnap.data() : {};
    const bumpCount = toNumber(prev.bumpCount) + 1;
    const eventPatch = {
      ...createBumpEventPatch(message),
      status: "recorded",
      bumperId: member.id,
      recordedBy: source,
      recordedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!eventSnap.exists) {
      eventPatch.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }

    transaction.set(
      userRef,
      {
        bumpCount,
        lastBumpedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastBumpMessageId: message.id,
        lastBumpChannelId: message.channelId,
        bumpUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    transaction.set(eventRef, eventPatch, { merge: true });

    result = {
      recorded: true,
      alreadyRecorded: false,
      bumpCount,
      bumperId: member.id,
    };
  });

  return result;
}

async function registerPendingDisboardBump(message) {
  const eventRef = bumpEventRef(message.guild.id, message.id);
  let shouldSendPrompt = false;

  await db.runTransaction(async (transaction) => {
    const eventSnap = await transaction.get(eventRef);
    const eventData = eventSnap.exists ? eventSnap.data() : {};

    if (eventData.status === "recorded" || eventData.status === "pending") {
      return;
    }

    const eventPatch = {
      ...createBumpEventPatch(message),
      status: "pending",
      pendingReason: "missing_bumper",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    transaction.set(eventRef, eventPatch, { merge: true });
    shouldSendPrompt = true;
  });

  if (!shouldSendPrompt) {
    return false;
  }

  const prompt = await message
    .reply({
      content:
        "🚀 DISBOARD bump 성공은 확인했는데 누가 bump했는지 자동으로 못 찾았어요.\n" +
        `방금 bump한 분은 ${BUMP_CLAIM_WINDOW_MINUTES}분 안에 아래 버튼을 눌러 기록해 주세요.`,
      components: [buildBumpClaimRow(message.id)],
      allowedMentions: { repliedUser: false },
    })
    .catch((error) => {
      console.warn("⚠️ DISBOARD bump 인증 버튼 전송 실패:", error);
      return null;
    });

  if (prompt) {
    await eventRef.set(
      {
        claimPromptMessageId: prompt.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  return true;
}

async function expireBumpEventRefs(refs) {
  let batch = db.batch();
  let writes = 0;

  for (const ref of refs) {
    batch.set(
      ref,
      {
        status: "expired",
        expiredAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    writes++;

    if (writes === 500) {
      await batch.commit();
      batch = db.batch();
      writes = 0;
    }
  }

  if (writes > 0) {
    await batch.commit();
  }
}

async function findLatestPendingBumpEvent(guildId, channelId) {
  const snap = await bumpEventsRef(guildId)
    .where("status", "==", "pending")
    .get();

  const now = Date.now();
  const expiredRefs = [];
  const candidates = [];

  for (const doc of snap.docs) {
    const data = doc.data();

    if (isBumpEventExpired(data, now)) {
      expiredRefs.push(doc.ref);
      continue;
    }

    if (data.channelId === channelId) {
      candidates.push({ id: doc.id, data });
    }
  }

  await expireBumpEventRefs(expiredRefs).catch((error) => {
    console.error("⚠️ 만료된 bump 인증 정리 실패:", error);
  });

  candidates.sort((a, b) => {
    return (
      toNumber(timestampToMillis(b.data.bumpMessageCreatedAt)) -
      toNumber(timestampToMillis(a.data.bumpMessageCreatedAt))
    );
  });

  return candidates[0] || null;
}

async function claimPendingDisboardBump(guild, userId, bumpMessageId) {
  const member =
    guild.members.cache.get(userId) ||
    await guild.members.fetch(userId).catch(() => null);

  if (!member || member.user.bot) {
    return { status: "invalid-member" };
  }

  const eventRef = bumpEventRef(guild.id, bumpMessageId);
  const userRef = db
    .collection("guilds")
    .doc(guild.id)
    .collection("users")
    .doc(member.id);

  let result = { status: "missing" };

  await db.runTransaction(async (transaction) => {
    const eventSnap = await transaction.get(eventRef);

    if (!eventSnap.exists) {
      result = { status: "missing" };
      return;
    }

    const eventData = eventSnap.data();

    if (eventData.status === "recorded") {
      result = {
        status: "already-recorded",
        bumperId: eventData.bumperId || null,
      };
      return;
    }

    if (eventData.status !== "pending") {
      result = { status: "unavailable" };
      return;
    }

    if (isBumpEventExpired(eventData)) {
      transaction.set(
        eventRef,
        {
          status: "expired",
          expiredAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      result = { status: "expired" };
      return;
    }

    const userSnap = await transaction.get(userRef);
    const userData = userSnap.exists ? userSnap.data() : {};
    const bumpCount = toNumber(userData.bumpCount) + 1;

    transaction.set(
      userRef,
      {
        bumpCount,
        lastBumpedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastBumpMessageId: bumpMessageId,
        lastBumpChannelId: eventData.channelId || null,
        bumpUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    transaction.set(
      eventRef,
      {
        status: "recorded",
        bumperId: member.id,
        recordedBy: "claim",
        recordedAt: admin.firestore.FieldValue.serverTimestamp(),
        claimedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    result = {
      status: "recorded",
      bumpCount,
      bumperId: member.id,
    };
  });

  if (result.status === "recorded") {
    console.log(
      `🚀 DISBOARD bump 인증 기록: ${guild.name} / ${member.user.tag} (${result.bumpCount}회)`
    );
  }

  return result;
}

function formatBumpClaimResult(result, user) {
  if (result.status === "recorded") {
    return `✅ ${user}님의 DISBOARD bump를 기록했어요. 현재 ${result.bumpCount}회입니다.`;
  }

  if (result.status === "already-recorded") {
    if (result.bumperId === user.id) {
      return "ℹ️ 이미 내 bump로 기록된 성공 메시지예요.";
    }

    return result.bumperId
      ? `ℹ️ 이미 <@${result.bumperId}> 님의 bump로 기록된 성공 메시지예요.`
      : "ℹ️ 이미 기록된 DISBOARD bump 성공 메시지예요.";
  }

  if (result.status === "expired") {
    return `⏰ bump 인증 가능 시간이 지났어요. 성공 메시지 생성 후 ${BUMP_CLAIM_WINDOW_MINUTES}분 안에 인증해 주세요.`;
  }

  if (result.status === "invalid-member") {
    return "❌ 서버 멤버만 DISBOARD bump를 인증할 수 있어요.";
  }

  return "❌ 인증할 수 있는 DISBOARD bump 성공 메시지를 찾지 못했어요.";
}

async function recordDisboardBump(message) {
  if (!isDisboardBumpDoneMessage(message)) {
    return false;
  }

  const bumperId = await resolveDisboardBumperId(message);

  if (!bumperId) {
    console.warn("⚠️ DISBOARD bump 유저를 찾지 못했습니다:", message.id);
    await registerPendingDisboardBump(message);
    return true;
  }

  const member =
    message.guild.members.cache.get(bumperId) ||
    await message.guild.members.fetch(bumperId).catch(() => null);

  if (!member) {
    console.warn("⚠️ DISBOARD bump 멤버를 조회하지 못했습니다:", bumperId);
    await registerPendingDisboardBump(message);
    return true;
  }

  if (member.user.bot) {
    return false;
  }

  const result = await recordBumpForMember(message, member, "auto");

  if (result.recorded) {
    console.log(
      `🚀 DISBOARD bump 기록: ${message.guild.name} / ${member.user.tag} (${result.bumpCount}회)`
    );
  }

  return true;
}

async function resetBumpStats(guildId) {
  const usersRef = db
    .collection("guilds")
    .doc(guildId)
    .collection("users");

  const snap = await usersRef.get();
  let batch = db.batch();
  let writes = 0;
  let resetCount = 0;

  for (const doc of snap.docs) {
    const data = doc.data();

    if (
      toNumber(data.bumpCount) <= 0 &&
      !data.lastBumpedAt &&
      !data.lastBumpMessageId
    ) {
      continue;
    }

    batch.set(
      doc.ref,
      {
        bumpCount: 0,
        lastBumpedAt: admin.firestore.FieldValue.delete(),
        lastBumpMessageId: admin.firestore.FieldValue.delete(),
        lastBumpChannelId: admin.firestore.FieldValue.delete(),
        bumpUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    writes++;
    resetCount++;

    if (writes === 500) {
      await batch.commit();
      batch = db.batch();
      writes = 0;
    }
  }

  if (writes > 0) {
    await batch.commit();
  }

  const eventsSnap = await bumpEventsRef(guildId).get();
  batch = db.batch();
  writes = 0;

  for (const doc of eventsSnap.docs) {
    batch.delete(doc.ref);
    writes++;

    if (writes === 500) {
      await batch.commit();
      batch = db.batch();
      writes = 0;
    }
  }

  if (writes > 0) {
    await batch.commit();
  }

  return resetCount;
}

async function startVoiceSession(guildId, userId, startedAtMs = Date.now()) {
  const sessionKey = getVoiceSessionKey(guildId, userId);

  activeVoiceSessions.set(sessionKey, startedAtMs);

  await db
    .collection("guilds")
    .doc(guildId)
    .collection("users")
    .doc(userId)
    .set(
      {
        voiceSessionStartedAt: admin.firestore.Timestamp.fromMillis(startedAtMs),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}

async function endVoiceSession(guildId, userId, endedAtMs = Date.now()) {
  const sessionKey = getVoiceSessionKey(guildId, userId);
  const memoryStartedAt = activeVoiceSessions.get(sessionKey);

  activeVoiceSessions.delete(sessionKey);

  const userRef = db
    .collection("guilds")
    .doc(guildId)
    .collection("users")
    .doc(userId);

  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(userRef);
    const data = snap.exists ? snap.data() : {};
    const storedStartedAt = timestampToMillis(data.voiceSessionStartedAt);
    const startedAt = memoryStartedAt || storedStartedAt || endedAtMs;
    const sessionMs = Math.max(0, endedAtMs - startedAt);
    const count = toNumber(data.count);
    const voiceMs = toNumber(data.voiceMs) + sessionMs;
    const activityScore = getActivityScore(count, voiceMs);

    transaction.set(
      userRef,
      {
        count,
        voiceMs,
        activityScore,
        level: getLevel(activityScore),
        voiceSessionStartedAt: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

async function trackCurrentVoiceSessionsForGuild(guild, startedAtMs = Date.now()) {
  let batch = db.batch();
  let writes = 0;

  for (const voiceState of guild.voiceStates.cache.values()) {
    if (!voiceState.channelId) continue;
    if (voiceState.member?.user?.bot) continue;

    const sessionKey = getVoiceSessionKey(guild.id, voiceState.id);
    activeVoiceSessions.set(sessionKey, startedAtMs);

    const userRef = db
      .collection("guilds")
      .doc(guild.id)
      .collection("users")
      .doc(voiceState.id);

    batch.set(
      userRef,
      {
        voiceSessionStartedAt: admin.firestore.Timestamp.fromMillis(startedAtMs),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    writes++;

    if (writes === 500) {
      await batch.commit();
      batch = db.batch();
      writes = 0;
    }
  }

  if (writes > 0) {
    await batch.commit();
  }
}

function clearGuildVoiceSessions(guildId) {
  for (const sessionKey of activeVoiceSessions.keys()) {
    if (sessionKey.startsWith(`${guildId}:`)) {
      activeVoiceSessions.delete(sessionKey);
    }
  }
}

function getRankLabel(rank) {
  if (rank === 1) return "🥇 1위";
  if (rank === 2) return "🥈 2위";
  if (rank === 3) return "🥉 3위";
  return `${rank}위`;
}

async function deleteStaleUserRefs(staleRefs) {
  if (staleRefs.length === 0) return;

  let batch = db.batch();
  let writes = 0;

  for (const ref of staleRefs) {
    batch.delete(ref);
    writes++;

    if (writes === 500) {
      await batch.commit();
      batch = db.batch();
      writes = 0;
    }
  }

  if (writes > 0) {
    await batch.commit();
  }
}

function buildRankingButtons(type, page, totalPages) {
  const previousPage = Math.max(0, page - 1);
  const nextPage = Math.min(totalPages - 1, page + 1);

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ranking:${type}:${previousPage}`)
        .setLabel("이전")
        .setEmoji("⬅️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`ranking:${type}:${nextPage}`)
        .setLabel("다음")
        .setEmoji("➡️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1)
    ),
  ];
}

async function getRankedUsers(guild, type) {
  const usersRef = db
    .collection("guilds")
    .doc(guild.id)
    .collection("users");

  const snap = await usersRef.get();

  if (snap.empty) {
    return {
      rankedUsers: [],
      emptyMessage:
        type === "voice"
          ? "아직 음성방 활동 데이터가 없습니다 💤"
          : type === "bump"
            ? "아직 DISBOARD bump 기록이 없습니다 💤"
          : "아직 활동 데이터가 없습니다 💤",
    };
  }

  const now = Date.now();
  const staleRefs = [];
  const rankedUsers = snap.docs
    .map((doc) => {
      const data = doc.data();
      const count = toNumber(data.count);
      const voiceMs = getEffectiveVoiceMs(data, guild.id, doc.id, now);
      const activityScore = getActivityScore(count, voiceMs);
      const bumpCount = toNumber(data.bumpCount);

      return {
        doc,
        count,
        voiceMs,
        activityScore,
        level: getLevel(activityScore),
        bumpCount,
        lastBumpedAt: data.lastBumpedAt,
      };
    })
    .filter((user) => {
      if (type === "voice") return user.voiceMs > 0;
      if (type === "bump") return user.bumpCount > 0;
      return user.count > 0 || user.voiceMs > 0;
    })
    .sort((a, b) => {
      if (type === "voice") {
        return b.voiceMs - a.voiceMs;
      }

      if (type === "bump") {
        if (b.bumpCount !== a.bumpCount) {
          return b.bumpCount - a.bumpCount;
        }

        return (
          toNumber(timestampToMillis(b.lastBumpedAt)) -
          toNumber(timestampToMillis(a.lastBumpedAt))
        );
      }

      if (b.activityScore !== a.activityScore) {
        return b.activityScore - a.activityScore;
      }

      if (b.voiceMs !== a.voiceMs) {
        return b.voiceMs - a.voiceMs;
      }

      return b.count - a.count;
    });

  const visibleUsers = [];

  for (const rankedUser of rankedUsers) {
    const member =
      guild.members.cache.get(rankedUser.doc.id) ||
      await guild.members.fetch(rankedUser.doc.id).catch((error) => {
        if (error?.code === 10007) {
          staleRefs.push(rankedUser.doc.ref);
          return null;
        }

        console.error("🚨 랭킹 멤버 조회 오류:", error);
        return null;
      });

    if (!member) continue;

    visibleUsers.push({
      ...rankedUser,
      member,
    });
  }

  await deleteStaleUserRefs(staleRefs).catch((error) => {
    console.error("⚠️ 탈퇴 멤버 데이터 정리 실패:", error);
  });

  return {
    rankedUsers: visibleUsers,
    emptyMessage:
      type === "voice"
        ? "아직 음성방 활동 데이터가 없습니다 💤"
        : type === "bump"
          ? "아직 DISBOARD bump 기록이 없습니다 💤"
        : "아직 활동 데이터가 없습니다 💤",
  };
}

async function buildRankingPage(guild, type, page) {
  const { rankedUsers, emptyMessage } = await getRankedUsers(guild, type);

  if (rankedUsers.length === 0) {
    return {
      content: emptyMessage,
      components: [],
    };
  }

  const totalPages = Math.ceil(rankedUsers.length / RANKING_PAGE_SIZE);
  const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
  const startIndex = currentPage * RANKING_PAGE_SIZE;
  const pageUsers = rankedUsers.slice(
    startIndex,
    startIndex + RANKING_PAGE_SIZE
  );
  const startRank = startIndex + 1;
  const endRank = startIndex + pageUsers.length;

  let text;

  if (type === "voice") {
    text = `🎙️ **음성방 체류 시간 ${startRank}-${endRank}위**\n`;
  } else if (type === "bump") {
    text = `🚀 **DISBOARD bump 랭킹 ${startRank}-${endRank}위**\n`;
  } else {
    text = `🏆 **서버 활동 랭킹 ${startRank}-${endRank}위**\n`;
  }

  if (type === "activity") {
    text += "채팅 1회 + 음성 1분 = 1점\n";
  }

  text += `페이지 ${currentPage + 1}/${totalPages}\n\n`;

  pageUsers.forEach((rankedUser, index) => {
    const rank = startIndex + index + 1;

    if (type === "voice") {
      const isActive =
        activeVoiceSessions.has(
          getVoiceSessionKey(guild.id, rankedUser.doc.id)
        ) || Boolean(rankedUser.member.voice?.channelId);

      text += `${getRankLabel(rank)} ${rankedUser.member.displayName} — ${formatDuration(rankedUser.voiceMs)}${isActive ? " · 접속 중" : ""}\n`;
      return;
    }

    if (type === "bump") {
      const lastBumped = formatDiscordRelativeTime(rankedUser.lastBumpedAt);
      text += `${getRankLabel(rank)} ${rankedUser.member.displayName} — ${rankedUser.bumpCount}회${lastBumped ? ` · 최근 ${lastBumped}` : ""}\n`;
      return;
    }

    text += `${getRankLabel(rank)} ${rankedUser.member.displayName} (Lv.${rankedUser.level}) — ${rankedUser.activityScore}점 · 채팅 ${rankedUser.count}회 · 음성 ${formatDuration(rankedUser.voiceMs)}\n`;
  });

  return {
    content: text,
    components: totalPages > 1
      ? buildRankingButtons(type, currentPage, totalPages)
      : [],
  };
}

// =======================
// 🔢 레벨 계산 함수 (Lv.1 ~ Lv.20)
// =======================
function getLevel(count) {
  const base = 30;      
  const multiplier = 1.5;
  const maxLevel = 20;

  if (count < base) return 1;

  let level = 2;
  let required = base;

  while (count >= required && level < maxLevel) {
    required *= multiplier;
    level++;
  }

  return level;
}


// =======================
// 📌 슬래시 커맨드 정의
// =======================
const commands = [
  new SlashCommandBuilder()
    .setName("내레벨")
    .setDescription("이 서버에서 나의 활동 레벨을 확인합니다"),

  new SlashCommandBuilder()
    .setName("랭킹")
    .setDescription("서버 활동 랭킹을 확인합니다"),

  new SlashCommandBuilder()
    .setName("음성방랭킹")
    .setDescription("음성방 체류 시간 랭킹을 확인합니다"),

  new SlashCommandBuilder()
    .setName("범프랭킹")
    .setDescription("DISBOARD bump 횟수 랭킹을 확인합니다"),

  new SlashCommandBuilder()
    .setName("범프인증")
    .setDescription("자동 인식이 안 된 DISBOARD bump를 내 기록으로 인증합니다"),

  new SlashCommandBuilder()
    .setName("범프초기화")
    .setDescription("DISBOARD bump 기록을 초기화합니다 (관리자 전용)")
    .setDefaultMemberPermissions(
      PermissionsBitField.Flags.Administrator
    ),

  new SlashCommandBuilder()
    .setName("상담신청")
    .setDescription("관리자에게 상담을 요청합니다"),

  new SlashCommandBuilder()
    .setName("상담종료")
    .setDescription("현재 상담을 종료합니다 (관리자)"),

  new SlashCommandBuilder()
    .setName("퇴장로그")
    .setDescription("퇴장 로그 채널과 로그멘트를 설정합니다")
    .addChannelOption((option) =>
      option
        .setName("채널")
        .setDescription("퇴장 로그를 보낼 채널")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("로그멘트")
        .setDescription("예: {user} 님이 서버를 떠났습니다")
        .setRequired(true)
        .setMaxLength(500)
    )
    .setDefaultMemberPermissions(
      PermissionsBitField.Flags.Administrator
    ),
  new SlashCommandBuilder()
    .setName("영구밴")
    .setDescription("유저 ID로 서버에서 영구 밴합니다")
    .addStringOption((option) =>
      option
        .setName("user_id")
        .setDescription("밴할 디스코드 유저 ID")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("밴 사유")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(
      PermissionsBitField.Flags.BanMembers
    ),
  ...securityCommandBuilders,
  new SlashCommandBuilder()
    .setName("활동초기화")
    .setDescription("서버 활동 데이터를 초기화합니다 (관리자 전용)"),
].map(cmd => cmd.toJSON());

// =======================
// 🚀 봇 준비 완료
// =======================
client.on("ready", async () => {
  console.log(`🤖 봇 로그인 완료: ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(
    process.env.DISCORD_TOKEN
  );

  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: commands }
  );

  console.log("✅ 슬래시 커맨드 등록 완료");

  client.user.setPresence({
    activities: [
      {
        name: "서버 활동 랭킹 ▶ https://quokkabot.vercel.app",
        type: 0,
      },
    ],
    status: "online",
  });

  for (const guild of client.guilds.cache.values()) {
    await trackCurrentVoiceSessionsForGuild(guild).catch((error) => {
      console.error("⚠️ 현재 음성방 세션 동기화 실패:", error);
    });
  }
});

// =======================
// 💬 메시지 감시 & 레벨링 (Firebase)
// =======================
client.on("messageUpdate", async (oldMessage, newMessage) => {
  const message = newMessage.partial
    ? await newMessage.fetch().catch(() => null)
    : newMessage;

  if (!message?.guild || !DISBOARD_BOT_IDS.has(message.author?.id)) {
    return;
  }

  await recordDisboardBump(message).catch((error) => {
    console.error("🚨 DISBOARD bump 수정 메시지 기록 오류:", error);
  });
});

client.on("messageCreate", async (message) => {
  if (message.guild && DISBOARD_BOT_IDS.has(message.author.id)) {
    await recordDisboardBump(message).catch((error) => {
      console.error("🚨 DISBOARD bump 기록 오류:", error);
    });
    return;
  }

  if (message.author.bot) return;
  if (!message.guild) return;

  const guildId = message.guild.id;
  const userId = message.author.id;

  const userRef = db
    .collection("guilds")
    .doc(guildId)
    .collection("users")
    .doc(userId);

  let count = 0;
  let level = 1;
  let levelUp = false;

  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(userRef);
    const prev = snap.exists
      ? snap.data()
      : { count: 0, level: 1, voiceMs: 0 };

    count = toNumber(prev.count) + 1;
    const voiceMs = toNumber(prev.voiceMs);
    const activityScore = getActivityScore(count, voiceMs);
    level = getLevel(activityScore);
    levelUp = level > toNumber(prev.level, 1);

    transaction.set(
      userRef,
      {
        count,
        voiceMs,
        activityScore,
        level,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  if (levelUp) {
    message.channel.send(
      `🎉 ${message.member.displayName} 님이 **Lv.${level}** 달성!`
    );
  }
});

// =======================
// 🎙️ 음성방 체류 시간 측정
// =======================
client.on("voiceStateUpdate", async (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  const guildId = newState.guild.id;
  const userId = member.id;
  const joinedVoice = !oldState.channelId && Boolean(newState.channelId);
  const leftVoice = Boolean(oldState.channelId) && !newState.channelId;

  try {
    if (joinedVoice) {
      await startVoiceSession(guildId, userId);
      return;
    }

    if (leftVoice) {
      await endVoiceSession(guildId, userId);
    }
  } catch (error) {
    console.error("🚨 음성방 시간 기록 오류:", error);
  }
});

// =======================
// 🚪 퇴장 로그 카드
// =======================
client.on("guildMemberRemove", async (member) => {
  try {
    const config = await getLeaveLogConfig(member.guild.id);
    if (!config.channelId) return;

    const channel = await resolveLeaveLogChannel(
      member.guild,
      config.channelId
    );

    if (!channel) return;

    const avatarUrl = member.user.displayAvatarURL({
      extension: "png",
      size: 256,
    });
    const joinedAt = member.joinedTimestamp
      ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`
      : "알 수 없음";
    const message = formatLeaveLogMessage(config.message, member);

    const embed = new EmbedBuilder()
      .setColor(0xf54d4d)
      .setAuthor({
        name: `${member.user.tag} 퇴장`,
        iconURL: avatarUrl,
      })
      .setTitle("멤버 퇴장 로그")
      .setDescription(message)
      .setThumbnail(avatarUrl)
      .addFields(
        {
          name: "유저",
          value: `${member.user.tag}\n${member.id}`,
          inline: true,
        },
        {
          name: "서버 인원",
          value: `${member.guild.memberCount}명`,
          inline: true,
        },
        {
          name: "가입일",
          value: joinedAt,
          inline: true,
        }
      )
      .setFooter({ text: member.guild.name })
      .setTimestamp();

    await channel.send({
      embeds: [embed],
      allowedMentions: {
        users: [member.id],
        roles: [],
        parse: [],
      },
    });
  } catch (error) {
    console.error("🚨 퇴장 로그 전송 오류:", error);
  }
});

// =======================
// 🧠 슬래시 커맨드 처리
// =======================
client.on("interactionCreate", async (interaction) => {
  if (
    interaction.isStringSelectMenu() &&
    interaction.customId.startsWith("consult-type:")
  ) {
    const [, requesterId] = interaction.customId.split(":");

    if (interaction.user.id !== requesterId) {
      return interaction.reply({
        content: "❌ 상담을 신청한 사용자만 상담 유형을 선택할 수 있습니다.",
        ephemeral: true,
      });
    }

    const selectedType = interaction.values[0];

    const disabledMenu = new StringSelectMenuBuilder()
      .setCustomId(interaction.customId)
      .setPlaceholder("상담 유형이 선택되었습니다")
      .setDisabled(true)
      .addOptions(
        CONSULT_TYPE_OPTIONS.map((label) => ({
          label,
          value: label,
          default: label === selectedType,
        }))
      );

    const row = new ActionRowBuilder().addComponents(disabledMenu);

    await interaction.update({
      content: `어떤 유형의 상담을 받고 싶은가요??\n선택된 상담 유형: **${selectedType}**`,
      components: [row],
    });

    return interaction.followUp({
      content: `# ${selectedType} 형식의 상담입니다`,
    });
  }

  if (
    interaction.isButton() &&
    interaction.customId.startsWith(BUMP_CLAIM_BUTTON_PREFIX)
  ) {
    if (!interaction.guild) {
      return interaction.reply({
        content: "❌ 서버 안에서만 사용할 수 있는 버튼입니다.",
        ephemeral: true,
      });
    }

    const bumpMessageId = interaction.customId.slice(
      BUMP_CLAIM_BUTTON_PREFIX.length
    );

    if (!/^\d{17,20}$/.test(bumpMessageId)) {
      return interaction.reply({
        content: "❌ 알 수 없는 bump 인증 버튼입니다.",
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await claimPendingDisboardBump(
        interaction.guild,
        interaction.user.id,
        bumpMessageId
      );

      return interaction.editReply(
        formatBumpClaimResult(result, interaction.user)
      );
    } catch (error) {
      console.error("🚨 DISBOARD bump 인증 버튼 처리 오류:", error);
      return interaction.editReply(
        "❌ bump 인증 처리 중 오류가 발생했습니다."
      );
    }
  }

  if (
    interaction.isButton() &&
    interaction.customId.startsWith("ranking:")
  ) {
    if (!interaction.guild) {
      return interaction.reply({
        content: "❌ 서버 안에서만 사용할 수 있는 버튼입니다.",
        ephemeral: true,
      });
    }

    const [, type, pageText] = interaction.customId.split(":");

    if (!RANKING_TYPES.has(type)) {
      return interaction.reply({
        content: "❌ 알 수 없는 랭킹 버튼입니다.",
        ephemeral: true,
      });
    }

    const page = Math.max(0, Number.parseInt(pageText, 10) || 0);

    try {
      await interaction.deferUpdate();

      const payload = await buildRankingPage(
        interaction.guild,
        type,
        page
      );

      return interaction.editReply(payload);
    } catch (error) {
      console.error("🚨 랭킹 페이지 버튼 처리 오류:", error);

      const errorPayload = {
        content: "❌ 랭킹 페이지를 불러오는 중 오류가 발생했습니다.",
        ephemeral: true,
      };

      if (interaction.deferred || interaction.replied) {
        return interaction.followUp(errorPayload);
      }

      return interaction.reply(errorPayload);
    }
  }

  if (!interaction.isChatInputCommand()) return;

  if (!interaction.guild) {
    return interaction.reply({
      content: "❌ 서버 안에서만 사용할 수 있는 명령어입니다.",
      ephemeral: true,
    });
  }

  const liveMember = await interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);

  if (!liveMember) {
    return interaction.reply({
      content: "❌ 멤버 정보를 불러오지 못했습니다.",
      ephemeral: true,
    });
  }

  try {
    const handledBySecuritySuite = await handleSecurityCommand({
      interaction,
      guild: interaction.guild,
      member: liveMember,
      db,
    });

    if (handledBySecuritySuite) {
      return;
    }
  } catch (error) {
    console.error("🚨 보안 명령 처리 오류:", error);

    if (interaction.deferred || interaction.replied) {
      return interaction
        .editReply("❌ 보안 명령 처리 중 오류가 발생했습니다.")
        .catch(() => null);
    }

    return interaction.reply({
      content: "❌ 보안 명령 처리 중 오류가 발생했습니다.",
      ephemeral: true,
    });
  }

  const { commandName, guild } = interaction;
  const member = liveMember;

  // =======================
  // 🚪 /퇴장로그
  // =======================
  if (commandName === "퇴장로그") {
    if (
      !member.permissions.has(
        PermissionsBitField.Flags.Administrator
      )
    ) {
      return interaction.reply({
        content: "⛔ 관리자만 퇴장 로그를 설정할 수 있습니다.",
        ephemeral: true,
      });
    }

    const channel = interaction.options.getChannel("채널", true);
    const message = interaction.options
      .getString("로그멘트", true)
      .trim();

    if (!channel.isTextBased()) {
      return interaction.reply({
        content: "❌ 텍스트 채널만 퇴장 로그 채널로 지정할 수 있습니다.",
        ephemeral: true,
      });
    }

    if (!message) {
      return interaction.reply({
        content: "❌ 로그멘트를 입력해주세요.",
        ephemeral: true,
      });
    }

    const botMember =
      guild.members.me || await guild.members.fetchMe();
    const botPermissions = channel.permissionsFor(botMember);

    if (
      !botPermissions?.has(PermissionsBitField.Flags.ViewChannel) ||
      !botPermissions.has(PermissionsBitField.Flags.SendMessages) ||
      !botPermissions.has(PermissionsBitField.Flags.EmbedLinks)
    ) {
      return interaction.reply({
        content:
          "❌ 봇이 해당 채널에 카드 로그를 보낼 수 없습니다. `채널 보기`, `메시지 보내기`, `링크 임베드` 권한을 확인해주세요.",
        ephemeral: true,
      });
    }

    const config = await saveLeaveLogConfig(guild.id, {
      channelId: channel.id,
      message,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: interaction.user.id,
    });

    const preview = formatLeaveLogMessage(config.message, member);

    return interaction.reply({
      content: [
        `✅ 퇴장 로그 채널을 ${channel} 로 설정했습니다.`,
        `로그멘트 미리보기: ${preview}`,
        "사용 가능 치환값: `{user}`, `{tag}`, `{username}`, `{displayName}`, `{server}`, `{memberCount}`, `{joinedAt}`",
      ].join("\n"),
      ephemeral: true,
    });
  }
// =======================
// 🎫 /상담신청
// =======================
if (commandName === "상담신청") {

  try {

    const guild = interaction.guild;

    if (!guild || !member) {
      console.log("❌ guild 또는 member 없음");
      return;
    }

    const CONSULT_CATEGORY_IDS =
      process.env.CONSULT_CATEGORY_IDS
        ?.split(",")
        .map(id => id.trim()) || [];

    const ADMIN_ROLE_IDS =
      process.env.ADMIN_ROLE_IDS
        ?.split(",")
        .map(id => id.trim()) || [];

    console.log("📂 카테고리 목록:", CONSULT_CATEGORY_IDS);
    console.log("🛠 관리자 역할:", ADMIN_ROLE_IDS);

    if (CONSULT_CATEGORY_IDS.length === 0) {
      console.log("❌ 카테고리 환경변수 없음");
      return interaction.reply({
        content: "❌ 상담 카테고리가 설정되지 않았습니다.",
        ephemeral: true,
      });
    }

    // 카테고리 랜덤 선택
    const categoryId =
      CONSULT_CATEGORY_IDS[
        Math.floor(Math.random() * CONSULT_CATEGORY_IDS.length)
      ];

    console.log("🎯 선택된 카테고리:", categoryId);

    const category = guild.channels.cache.get(categoryId);

    if (!category) {
      console.log("❌ 카테고리를 찾을 수 없음:", categoryId);

      console.log(
        "📋 서버 채널 목록:",
        guild.channels.cache.map(c => ({
          id: c.id,
          name: c.name,
          type: c.type
        }))
      );

      return interaction.reply({
        content: "❌ 상담 카테고리를 찾을 수 없습니다.",
        ephemeral: true,
      });
    }

    console.log("✅ 카테고리 확인:", category.name);

    // 관리자 권한 배열 생성
    const adminPermissions = ADMIN_ROLE_IDS
      .map(id => guild.roles.cache.get(id))
      .filter(role => role)
      .map(role => ({
        id: role.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
        ],
      }));

    console.log("🔐 관리자 권한 설정:", adminPermissions);

    const channel = await guild.channels.create({
      name: `상담-${member.user.username}`,
      type: 0,
      parent: category.id,

      permissionOverwrites: [
        {
          id: guild.id,
          deny: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id: member.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
          ],
        },
        ...adminPermissions,
      ],
    });

    console.log("✅ 상담 채널 생성:", channel.id);

    // 관리자 멘션 문자열
    const adminMentions = ADMIN_ROLE_IDS
      .map(id => `<@&${id}>`)
      .join(" ");

    await channel.send(
`📩 **새 상담이 시작되었습니다**

👤 신청자: <@${member.id}>

${adminMentions} 상담 요청이 들어왔습니다 🙏`
    );

    const consultTypeMenu = new StringSelectMenuBuilder()
      .setCustomId(`consult-type:${member.id}`)
      .setPlaceholder("상담 유형을 선택해주세요")
      .addOptions(
        CONSULT_TYPE_OPTIONS.map((label) => ({
          label,
          value: label,
        }))
      );

    const consultTypeRow = new ActionRowBuilder().addComponents(
      consultTypeMenu
    );

    await channel.send({
      content: "어떤 유형의 상담을 받고 싶은가요??",
      components: [consultTypeRow],
    });

    console.log("📨 상담 시작 메시지 전송");

    return interaction.reply({
      content: `✅ 상담 채널이 생성되었습니다 → ${channel}`,
      ephemeral: true,
    });

  } catch (error) {

    console.error("🚨 상담 채널 생성 오류:", error);

    return interaction.reply({
      content: "❌ 상담 채널 생성 중 오류가 발생했습니다.",
      ephemeral: true,
    });
  }
}
// =======================
// 🧹 /상담종료
// =======================
if (commandName === "상담종료") {

  const ADMIN_ROLE_IDS =
    process.env.ADMIN_ROLE_IDS?.split(",").map(id => id.trim()).filter(Boolean) || [];

  const memberRoles = member.roles.cache;

  const isAdmin =
    member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    ADMIN_ROLE_IDS.some(roleId => memberRoles.has(roleId));

  if (!isAdmin) {
    return interaction.reply({
      content: "⛔ 관리자만 상담을 종료할 수 있습니다.",
      ephemeral: true,
    });
  }

  const channel = interaction.channel;

  if (!channel.name.startsWith("상담-")) {
    return interaction.reply({
      content: "❌ 상담 채널에서만 사용할 수 있습니다.",
      ephemeral: true,
    });
  }

  await interaction.reply("🧹 상담을 종료합니다. 채널을 삭제합니다.");

  setTimeout(() => {
    channel.delete();
  }, 3000);
}
  // =======================
  // 🔨 /영구밴
  // =======================
  if (commandName === "영구밴") {
    await interaction.deferReply({ ephemeral: true });

    if (
      !member.permissions.has(
        PermissionsBitField.Flags.BanMembers
      )
    ) {
      return interaction.editReply(
        "⛔ 밴 권한이 있는 관리자만 사용할 수 있습니다."
      );
    }

    const botMember =
      guild.members.me || await guild.members.fetchMe();

    if (
      !botMember.permissions.has(
        PermissionsBitField.Flags.BanMembers
      )
    ) {
      return interaction.editReply(
        "❌ 봇에 밴 권한이 없습니다. 봇 역할에 `멤버 차단하기` 권한을 주세요."
      );
    }

    const targetUserId = interaction.options
      .getString("user_id", true)
      .trim();

    const reasonInput = interaction.options
      .getString("reason")
      ?.trim();

    if (!/^\d{17,20}$/.test(targetUserId)) {
      return interaction.editReply(
        "❌ 올바른 디스코드 유저 ID를 입력해주세요."
      );
    }

    if (targetUserId === interaction.user.id) {
      return interaction.editReply(
        "❌ 자기 자신은 밴할 수 없습니다."
      );
    }

    if (targetUserId === guild.ownerId) {
      return interaction.editReply(
        "❌ 서버 소유자는 밴할 수 없습니다."
      );
    }

    const existingBan = await guild.bans
      .fetch(targetUserId)
      .catch(() => null);

    if (existingBan) {
      return interaction.editReply(
        `ℹ️ <@${targetUserId}> 님은 이미 밴된 상태입니다.`
      );
    }

    const targetMember = await guild.members
      .fetch(targetUserId)
      .catch(() => null);

    if (targetMember) {
      if (targetMember.id === botMember.id) {
        return interaction.editReply(
          "❌ 봇 자신은 밴할 수 없습니다."
        );
      }

      if (
        member.id !== guild.ownerId &&
        targetMember.roles.highest.position >=
          member.roles.highest.position
      ) {
        return interaction.editReply(
          "❌ 본인보다 높거나 같은 역할의 멤버는 밴할 수 없습니다."
        );
      }

      if (!targetMember.bannable) {
        return interaction.editReply(
          "❌ 이 유저는 현재 밴할 수 없습니다. 봇 역할이 더 높고 권한이 충분한지 확인해주세요."
        );
      }
    }

    const reason = reasonInput
      ? `${reasonInput} | 처리자: ${interaction.user.tag} (${interaction.user.id})`
      : `처리자: ${interaction.user.tag} (${interaction.user.id})`;

    try {
      await guild.members.ban(targetUserId, {
        reason,
        deleteMessageSeconds: 0,
      });

      return interaction.editReply(
        `🔨 <@${targetUserId}> 님을 영구 밴했습니다.${reasonInput ? `\n사유: ${reasonInput}` : ""}`
      );
    } catch (error) {
      console.error("🚨 영구 밴 오류:", error);

      return interaction.editReply(
        "❌ 영구 밴 처리 중 오류가 발생했습니다. 봇 권한과 유저 ID를 다시 확인해주세요."
      );
    }
  }
  // =======================
  // 📊 /내레벨
  // =======================
  if (commandName === "내레벨") {
    const userRef = db
      .collection("guilds")
      .doc(guild.id)
      .collection("users")
      .doc(member.id);

    const snap = await userRef.get();
    const stat = snap.exists
      ? snap.data()
      : { count: 0, level: 1, voiceMs: 0 };
    const voiceMs = getEffectiveVoiceMs(stat, guild.id, member.id);
    const count = toNumber(stat.count);
    const activityScore = getActivityScore(count, voiceMs);
    const level = getLevel(activityScore);

    return interaction.reply({
      content: `📊 **${member.displayName}**\nLv.${level} / 활동점수 ${activityScore}점\n채팅 ${count}회 · 음성 ${formatDuration(voiceMs)}`,
      ephemeral: true,
    });
  }

  // =======================
  // 🏆 /랭킹
  // =======================
  if (commandName === "랭킹") {
    await interaction.deferReply();
    const payload = await buildRankingPage(guild, "activity", 0);
    return interaction.editReply(payload);
  }

  // =======================
  // 🎙️ /음성방랭킹
  // =======================
  if (commandName === "음성방랭킹") {
    await interaction.deferReply();
    const payload = await buildRankingPage(guild, "voice", 0);
    return interaction.editReply(payload);
  }

  // =======================
  // 🚀 /범프랭킹
  // =======================
  if (commandName === "범프랭킹") {
    await interaction.deferReply();
    const payload = await buildRankingPage(guild, "bump", 0);
    return interaction.editReply(payload);
  }

  // =======================
  // 🚀 /범프인증
  // =======================
  if (commandName === "범프인증") {
    await interaction.deferReply({ ephemeral: true });

    try {
      const pendingEvent = await findLatestPendingBumpEvent(
        guild.id,
        interaction.channelId
      );

      if (!pendingEvent) {
        return interaction.editReply(
          `❌ 이 채널에서 인증 대기 중인 DISBOARD bump를 찾지 못했어요. 성공 메시지 후 ${BUMP_CLAIM_WINDOW_MINUTES}분 안에 사용해 주세요.`
        );
      }

      const result = await claimPendingDisboardBump(
        guild,
        interaction.user.id,
        pendingEvent.id
      );

      return interaction.editReply(
        formatBumpClaimResult(result, interaction.user)
      );
    } catch (error) {
      console.error("🚨 DISBOARD bump 인증 명령어 처리 오류:", error);
      return interaction.editReply(
        "❌ bump 인증 처리 중 오류가 발생했습니다."
      );
    }
  }

  // =======================
  // 🧹 /범프초기화
  // =======================
  if (commandName === "범프초기화") {
    if (
      !member.permissions.has(
        PermissionsBitField.Flags.Administrator
      )
    ) {
      return interaction.reply({
        content: "⛔ 관리자만 사용할 수 있습니다.",
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });
    const resetCount = await resetBumpStats(guild.id);

    return interaction.editReply(
      `🧹 DISBOARD bump 기록을 초기화했습니다. (${resetCount}명)`
    );
  }

  // =======================
  // 🧹 /활동초기화
  // =======================
  if (commandName === "활동초기화") {
    if (
      !member.permissions.has(
        PermissionsBitField.Flags.Administrator
      ) 
    ) {
      return interaction.reply({
        content: "⛔ 관리자만 사용할 수 있습니다.",
        ephemeral: true,
      });
    }

    const usersRef = db
      .collection("guilds")
      .doc(guild.id)
      .collection("users");

    const snap = await usersRef.get();
    const batch = db.batch();

    snap.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    clearGuildVoiceSessions(guild.id);
    await trackCurrentVoiceSessionsForGuild(guild);

    return interaction.reply(
      "🧹 서버 활동 데이터가 초기화되었습니다."
    );
  }
});

// =======================
// 🌐 API (외부 랭킹 조회용)
// =======================
app.get("/api/stats/:guildId", async (req, res) => {
  const { guildId } = req.params;

  const snap = await db
    .collection("guilds")
    .doc(guildId)
    .collection("users")
    .get();

  const now = Date.now();
  const data = snap.docs
    .map((doc) => {
      const rawData = doc.data();
      const count = toNumber(rawData.count);
      const voiceMs = getEffectiveVoiceMs(rawData, guildId, doc.id, now);
      const activityScore = getActivityScore(count, voiceMs);
      const bumpCount = toNumber(rawData.bumpCount);

      return {
        userId: doc.id,
        ...rawData,
        count,
        bumpCount,
        voiceMs,
        voiceTime: formatDuration(voiceMs),
        activityScore,
        level: getLevel(activityScore),
      };
    })
    .sort((a, b) => {
      if (b.activityScore !== a.activityScore) {
        return b.activityScore - a.activityScore;
      }

      return b.voiceMs - a.voiceMs;
    });

  res.json(data);
});

// =======================
client.login(process.env.DISCORD_TOKEN);

app.listen(PORT, () => {
  console.log(`🌐 API 서버 실행중 → ${PORT}`);
});
