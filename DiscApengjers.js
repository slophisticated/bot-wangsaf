// =================================================================
//                      WORKER BOT DISCORD V1.0
// =================================================================
require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { GoogleSpreadsheet } = require("google-spreadsheet");

// Muat variabel dari .env
const {
  DISCORD_BOT_TOKEN,
  GOOGLE_SHEET_ID,
  GCP_CLIENT_EMAIL,
  GCP_PRIVATE_KEY,
} = process.env;

const PREFIX = "!"; // Prefix untuk perintah

// Inisialisasi Klien Discord
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Fungsi untuk koneksi ke Google Sheets
async function getGoogleSheetDoc() {
  const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID);
  const creds = {
    client_email: GCP_CLIENT_EMAIL,
    private_key: GCP_PRIVATE_KEY.replace(/\\n/g, "\n"),
  };
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
  return doc;
}

// Saat bot siap dan online
client.on("ready", () => {
  console.log(`✅ Worker Bot Discord online sebagai ${client.user.tag}!`);
});

// Saat ada pesan masuk di channel mana pun yang bisa diakses bot
client.on("messageCreate", async (message) => {
  // Abaikan jika pesan dari bot lain atau tidak menggunakan prefix
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;

  // Pisahkan perintah dan argumennya
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // Logika untuk perintah !mulai
  if (command === "mulai") {
    if (!args.length) {
      return message.channel.send(
        "⚠️ Harap masukkan ID Order. Contoh: `!mulai JOKI-XXXX-XXXX`"
      );
    }

    const orderId = args[0].toUpperCase();

    try {
      await message.channel.send(
        `⏳ Mencari order \`${orderId}\` di Google Sheets...`
      );

      const doc = await getGoogleSheetDoc();
      const sheet = doc.sheetsByIndex[0]; // Asumsi sheet pertama
      const rows = await sheet.getRows();

      const orderRow = rows.find((row) => row.get("IDorder") === orderId);

      if (!orderRow) {
        return message.channel.send(
          `❌ Order dengan ID \`${orderId}\` tidak ditemukan.`
        );
      }

      if (orderRow.get("Status Order") !== "Segera Diproses") {
        return message.channel.send(
          `⚠️ Order \`${orderId}\` sudah dalam status "${orderRow.get(
            "Status Order"
          )}". Tidak dapat dimulai ulang.`
        );
      }

      // Update status dan catat waktu mulai
      orderRow.set("Status Order", "Dalam Proses");
      orderRow.set(
        "Waktu Mulai Proses",
        new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
      );
      await orderRow.save();

      console.log(`Worker ${message.author.tag} memulai order ${orderId}`);
      await message.channel.send(
        `✅ **Sukses!** Order \`${orderId}\` sekarang berstatus **"Dalam Proses"**. Progress bar di fitur Cek Order pelanggan akan segera berjalan!`
      );
    } catch (error) {
      console.error("Error saat menjalankan perintah !mulai:", error);
      await message.channel.send(
        "Terjadi error saat mencoba update status ke Google Sheets."
      );
    }
  }

  // Kamu bisa tambah perintah lain di sini, misal: !selesai <IDOrder>
});

// Login bot ke Discord menggunakan token
client.login(DISCORD_BOT_TOKEN);
