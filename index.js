import {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
} from "discord.js";
import express from "express";
import cors from "cors";
import "dotenv/config";

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

// Map<guildId, Map<userId, { count, level }>>
const userStats = new Map();

// =======================
// 🔢 레벨 계산 함수
// =======================
function getLevel(count) {
  if (count >= 100) return 5;
  if (count >= 60) return 4;
  if (count >= 30) return 3;
  if (count >= 10) return 2;
  return 1;
}

// =======================
// 🚀 봇 준비 완료
// =======================
client.on("ready", () => {
  console.log(`🤖 봇 로그인 완료: ${client.user.tag}`);

  const activity = {
    name: "서버 활동 랭킹 ▶ https://quokkabot.vercel.app",
    type: 0, // PLAYING
  };

  client.user.setPresence({
    activities: [activity],
    status: "online",
  });
});

// =======================
// 💬 메시지 감시 & 레벨링
// =======================
client.on("messageCreate", (message) => {
  if (message.author.bot) return;
  if (!message.guild) return; // DM 제외

  const guildId = message.guild.id;
  const userId = message.author.id;

  // 서버 데이터 없으면 생성
  if (!userStats.has(guildId)) {
    userStats.set(guildId, new Map());
  }

  const guildStats = userStats.get(guildId);
  const prev = guildStats.get(userId) || { count: 0, level: 1 };

  const count = prev.count + 1;
  const level = getLevel(count);

  // 🎉 레벨업 알림
  if (level > prev.level) {
    message.channel.send(
      `🎉 ${message.author} 이 서버에서 **Lv.${level}** 달성!`
    );
  }

  guildStats.set(userId, { count, level });

  // 📊 개인 레벨 확인
  if (message.content === "!내레벨") {
    message.reply(
      `📊 이 서버 기준 → Lv.${level} / 메시지 ${count}`
    );
  }

  // 🧹 관리자 전용 활동 초기화
  if (message.content === "!활동초기화") {
    if (
      !message.member.permissions.has(
        PermissionsBitField.Flags.Administrator
      )
    ) {
      return message.reply("⛔ 관리자만 사용할 수 있는 명령어입니다.");
    }

    userStats.set(guildId, new Map());
    message.channel.send(
      "🧹 이 서버의 활동 데이터가 관리자에 의해 초기화되었습니다."
    );
  }
});

// =======================
// 🌐 API (공개 랭킹 조회용)
// =======================

// 서버별 유저 활동 조회 (읽기 전용)
app.get("/api/stats/:guildId", (req, res) => {
  const { guildId } = req.params;
  const guildStats = userStats.get(guildId);

  if (!guildStats) return res.json([]);

  const data = Array.from(guildStats.entries()).map(
    ([userId, value]) => ({
      userId,
      ...value,
    })
  );

  res.json(data);
});

// =======================
client.login(process.env.DISCORD_TOKEN);

app.listen(PORT, () => {
  console.log(`🌐 API 서버 실행중 → ${PORT}`);
});
