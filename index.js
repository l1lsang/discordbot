import {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  SlashCommandBuilder,
  REST,
  Routes,
} from "discord.js";
import express from "express";
import cors from "cors";
import "dotenv/config";

import admin from "firebase-admin";

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
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// =======================
// 🔢 레벨 계산 함수 (Lv.1 ~ Lv.20)
// =======================
function getLevel(count) {
  if (count >= 1000) return 20;
  if (count >= 900) return 19;
  if (count >= 820) return 18;
  if (count >= 750) return 17;
  if (count >= 690) return 16;
  if (count >= 630) return 15;
  if (count >= 580) return 14;
  if (count >= 530) return 13;
  if (count >= 490) return 12;
  if (count >= 450) return 11;
  if (count >= 410) return 10;
  if (count >= 370) return 9;
  if (count >= 330) return 8;
  if (count >= 290) return 7;
  if (count >= 250) return 6;
  if (count >= 210) return 5;
  if (count >= 150) return 4;
  if (count >= 70) return 3;
  if (count >= 30) return 2;
  if (count >= 5) return 1;
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
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, member } = interaction;

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
    const snap = await db
      .collection("guilds")
      .doc(guild.id)
      .collection("users")
      .orderBy("count", "desc")
      .limit(5)
      .get();

    if (snap.empty) {
      return interaction.reply("아직 활동 데이터가 없습니다 💤");
    }

    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
    let text = "🏆 **서버 활동 랭킹 TOP 5**\n\n";

    let i = 0;
    for (const doc of snap.docs) {
      const m = await guild.members.fetch(doc.id);
      const data = doc.data();

      text += `${medals[i]} ${m.displayName} (Lv.${data.level}) — ${data.count}회\n`;
      i++;
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
