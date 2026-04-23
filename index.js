import {
  ActionRowBuilder,
  Client,
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

registerSecurityHandlers(client, db);

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
    .setDescription("서버 활동 랭킹 TOP 5를 확인합니다"),
new SlashCommandBuilder()
  .setName("상담신청")
  .setDescription("관리자에게 상담을 요청합니다"),

new SlashCommandBuilder()
  .setName("상담종료")
  .setDescription("현재 상담을 종료합니다 (관리자)"),
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
});

// =======================
// 💬 메시지 감시 & 레벨링 (Firebase)
// =======================
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const guildId = message.guild.id;
  const userId = message.author.id;

  const userRef = db
    .collection("guilds")
    .doc(guildId)
    .collection("users")
    .doc(userId);

  const snap = await userRef.get();

  const prev = snap.exists
    ? snap.data()
    : { count: 0, level: 1 };

  const count = prev.count + 1;
  const level = getLevel(count);

  if (level > prev.level) {
    message.channel.send(
      `🎉 ${message.member.displayName} 님이 **Lv.${level}** 달성!`
    );
  }

  await userRef.set({
    count,
    level,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
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
      : { count: 0, level: 1 };

    return interaction.reply({
      content: `📊 **${member.displayName}**\nLv.${stat.level} / 메시지 ${stat.count}`,
      ephemeral: true,
    });
  }

  // =======================
  // 🏆 /랭킹
  // =======================
  if (commandName === "랭킹") {
    const usersRef = db
      .collection("guilds")
      .doc(guild.id)
      .collection("users");

    const snap = await usersRef
      .orderBy("count", "desc")
      .limit(30)
      .get();

    if (snap.empty) {
      return interaction.reply("아직 활동 데이터가 없습니다 💤");
    }

    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
    let text = "🏆 **서버 활동 랭킹 TOP 5**\n\n";
    const staleRefs = [];

    let i = 0;
    for (const doc of snap.docs) {
      if (i >= medals.length) break;

      const m =
        guild.members.cache.get(doc.id) ||
        await guild.members.fetch(doc.id).catch((error) => {
          if (error?.code === 10007) {
            staleRefs.push(doc.ref);
            return null;
          }

          console.error("🚨 랭킹 멤버 조회 오류:", error);
          return null;
        });

      if (!m) continue;

      const data = doc.data();

      text += `${medals[i]} ${m.displayName} (Lv.${data.level}) — ${data.count}회\n`;
      i++;
    }

    if (staleRefs.length > 0) {
      const batch = db.batch();
      staleRefs.forEach((ref) => batch.delete(ref));
      await batch.commit().catch((error) => {
        console.error("⚠️ 탈퇴 멤버 데이터 정리 실패:", error);
      });
    }

    if (i === 0) {
      return interaction.reply(
        "표시할 활동 멤버가 없습니다. 잠시 후 다시 시도해주세요."
      );
    }

    return interaction.reply(text);
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
    .orderBy("count", "desc")
    .get();

  const data = snap.docs.map(doc => ({
    userId: doc.id,
    ...doc.data(),
  }));

  res.json(data);
});

// =======================
client.login(process.env.DISCORD_TOKEN);

app.listen(PORT, () => {
  console.log(`🌐 API 서버 실행중 → ${PORT}`);
});
