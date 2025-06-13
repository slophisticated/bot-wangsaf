// =================================================================
//                      BOT JOKI WHATSAPP V2.3
// =================================================================

// --- 1. Konfigurasi Awal & Impor Library ---
require("dotenv").config(); // WAJIB PALING ATAS, untuk membaca file .env

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  proto,
} = require("baileys");
const pino = require("pino");
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const midtransClient = require("midtrans-client");
const qrcode = require("qrcode-terminal");
const crypto = require("crypto");

// --- 2. Muat Variabel dari .env ---
const {
  GOOGLE_SHEET_ID,
  GCP_CLIENT_EMAIL,
  GCP_PRIVATE_KEY,
  MIDTRANS_SERVER_KEY,
  MIDTRANS_CLIENT_KEY,
  MIDTRANS_IS_PRODUCTION,
  DISCORD_WEBHOOK_URL,
  PORT,
  ADMIN_CONTACT, // <-- Variabel baru untuk nomor admin
} = process.env;

// --- 3. Database Produk & Inisialisasi Klien ---

const cdidProducts = {
  cdid_1m: { name: "1M Uang CDID", price: 1000, baseEstimasiMenit: 30 },
  cdid_5m: { name: "5M Uang CDID", price: 5000, baseEstimasiMenit: 120 }, // 2 jam
  cdid_10m: { name: "10M Uang CDID", price: 10000, baseEstimasiMenit: 240 }, // 4 jam
  cdid_20m: { name: "20M Uang CDID", price: 20000, baseEstimasiMenit: 480 }, // 8 jam
  cdid_50m: { name: "50M Uang CDID", price: 50000, baseEstimasiMenit: 1440 }, // 1 hari
  cdid_100m: { name: "100M Uang CDID", price: 85000, baseEstimasiMenit: 2880 }, // 2 hari
  cdid_125m: { name: "125M Uang CDID", price: 140000, baseEstimasiMenit: 3600 }, // 2.5 hari
};

const snap = new midtransClient.Snap({
  isProduction: MIDTRANS_IS_PRODUCTION === "true",
  serverKey: MIDTRANS_SERVER_KEY,
  clientKey: MIDTRANS_CLIENT_KEY,
});

// --- 4. State Management & Data Sementara ---

let sock;
let userState = {};
const USER_STATE_FILE = "./user_state.json";
let pendingOrders = {};
const PENDING_ORDERS_FILE = "./pending_orders.json";

function loadState() {
  if (fs.existsSync(USER_STATE_FILE))
    userState = JSON.parse(fs.readFileSync(USER_STATE_FILE));
  if (fs.existsSync(PENDING_ORDERS_FILE))
    pendingOrders = JSON.parse(fs.readFileSync(PENDING_ORDERS_FILE));
}

function saveState() {
  fs.writeFileSync(USER_STATE_FILE, JSON.stringify(userState, null, 2));
  fs.writeFileSync(PENDING_ORDERS_FILE, JSON.stringify(pendingOrders, null, 2));
}

// --- 5. Fungsi Helper ---

function generateOrderId() {
  const timestamp = Date.now();
  const randomPart = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `JOKI-${timestamp}-${randomPart}`;
}

function formatEstimasi(totalMenit) {
  if (isNaN(totalMenit) || totalMenit <= 0) return "Segera";

  const hari = Math.floor(totalMenit / 1440);
  const sisaMenit1 = totalMenit % 1440;
  const jam = Math.floor(sisaMenit1 / 60);
  const menit = sisaMenit1 % 60;

  let result = [];
  if (hari > 0) result.push(`${hari} Hari`);
  if (jam > 0) result.push(`${jam} Jam`);
  if (menit > 0) result.push(`${menit} Menit`);

  return result.length > 0 ? result.join(" ") : "Kurang dari satu menit";
}

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

async function simpanOrderKeSheet(orderData) {
  try {
    const doc = await getGoogleSheetDoc();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow(orderData);
    console.log(
      `✅ Order ${orderData.IDorder} berhasil disimpan ke Google Sheets.`
    );
  } catch (error) {
    console.error("❌ Gagal menyimpan ke Google Sheets:", error.message);
  }
}

async function kirimNotifKeDiscord(orderData) {
  const embedMessage = {
    content:
      "@everyone Halo APENGJERS berikut data pesanan terbaru untuk toko kamu:",
    embeds: [
      {
        color: 16711680,
        title: `Pesanan baru masuk (${orderData.idOrder}) ${orderData.productName}`,
        fields: [
          { name: "Username", value: "```" + orderData.username + "```" },
          { name: "Password", value: "```" + orderData.password + "```" },
          { name: "Payment", value: orderData.payment, inline: true },
          { name: "Jumlah", value: orderData.jumlah, inline: true },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    await axios.post(DISCORD_WEBHOOK_URL, embedMessage);
    console.log(
      `✅ Notifikasi untuk order ${orderData.idOrder} berhasil dikirim ke Discord.`
    );
  } catch (error) {
    console.error("❌ Gagal mengirim notifikasi ke Discord:", error.message);
  }
}

// --- 6. Logika Utama Bot (Baileys) ---

async function startBot() {
  console.log("Memulai bot WhatsApp...");
  const { state, saveCreds } = await useMultiFileAuthState("auth");

  sock = makeWASocket({ logger: pino({ level: "silent" }), auth: state });
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (connection === "open") console.log("✅ Bot berhasil terkoneksi!");
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.buttonsResponseMessage?.selectedButtonId ||
      msg.message.listResponseMessage?.singleSelectReply.selectedRowId ||
      "";

    console.log(`Pesan dari [${sender}]: "${text}"`);

    try {
      const currentState = userState[sender];

      // LOGIKA UNTUK MENANGANI FORM YANG DIKIRIM USER
      if (currentState && currentState.startsWith("MENUNGGU_FORM_CDID_")) {
        const productId = currentState.replace("MENUNGGU_FORM_CDID_", "");
        const product = cdidProducts[productId];

        const lines = text.split("\n");
        const formData = {};
        lines.forEach((line) => {
          const [key, ...valueParts] = line.split(":");
          if (key && valueParts.length > 0) {
            formData[key.trim().toLowerCase()] = valueParts.join(":").trim();
          }
        });

        if (
          !formData.username ||
          !formData.password ||
          !formData.jumlah ||
          !formData.payment
        ) {
          await sock.sendMessage(sender, {
            text: "❌ Form tidak lengkap. Pastikan semua field (username, password, payment, jumlah) terisi.",
          });
          return;
        }

        const jumlah = parseInt(formData.jumlah);
        if (isNaN(jumlah) || jumlah <= 0) {
          await sock.sendMessage(sender, { text: "❌ Jumlah tidak valid." });
          return;
        }

        const totalHarga = product.price * jumlah;
        const totalEstimasiMenit = product.baseEstimasiMenit * jumlah;
        const estimasiFormatted = formatEstimasi(totalEstimasiMenit);

        const idOrder = generateOrderId();

        const transaction = await snap.createTransaction({
          transaction_details: { order_id: idOrder, gross_amount: totalHarga },
          customer_details: { first_name: sender.split("@")[0] },
        });

        pendingOrders[idOrder] = {
          sender,
          productName: product.name,
          username: formData.username,
          password: formData.password,
          payment: formData.payment,
          jumlah: formData.jumlah,
          totalHarga: totalHarga,
          estimasi: estimasiFormatted,
        };
        saveState();

        const confirmationText = `Joki ${product.name}\nusername: ${
          formData.username
        }\npassword: ${formData.password}\npayment: ${
          formData.payment
        }\nJumlah: ${formData.jumlah}\n\nHarga: Rp ${totalHarga.toLocaleString(
          "id-ID"
        )}\n\nSilahkan Bayar lewat QRIS di bawah ini atau melalui link:\n${
          transaction.redirect_url
        }`;

        await sock.sendMessage(sender, {
          image: { url: "https://placehold.co/400x400/FFF/000?text=QRIS+ANDA" },
          caption: confirmationText,
        });

        delete userState[sender];
        saveState();
        return;
      }

      // --- LOGIKA ALUR KOMPLAIN YANG DIPERBARUI ---
      if (currentState === "MENUNGGU_KONFIRMASI_KOMPLAIN") {
        if (text === "hubungi_cs_ya") {
          // Ambil nomor dari .env dan bersihkan dari karakter selain angka
          const adminNumber = (ADMIN_CONTACT || "6281234567890").replace(
            /[^0-9]/g,
            ""
          );
          const adminLink = `https://wa.me/${adminNumber}`;
          const pesanLinkAdmin = `Baik, silakan klik link di bawah ini untuk langsung memulai chat dengan admin kami:\n\n${adminLink}\n\nMohon jelaskan permasalahanmu dengan detail ya.`;

          await sock.sendMessage(sender, { text: pesanLinkAdmin });
        } else if (text === "hubungi_cs_tidak") {
          await sock.sendMessage(sender, {
            text: "Baik, kembali ke menu utama. Silakan kirim pesan apa saja untuk menampilkan menu.",
          });
        }
        delete userState[sender];
        saveState();
        return;
      }

      // LOGIKA UNTUK RESPON TOMBOL
      switch (text) {
        case "joki_cdid":
          const sections = [
            {
              title: "Pilih Paket Joki CDID",
              rows: Object.entries(cdidProducts).map(
                ([id, { name, price }]) => ({
                  title: name,
                  rowId: id,
                  description: `Harga: Rp${price.toLocaleString("id-ID")}`,
                })
              ),
            },
          ];
          const listMessage = {
            text: "Berikut adalah daftar harga untuk Joki CDID:",
            footer: "Pilih salah satu",
            title: "Daftar Harga",
            buttonText: "Lihat Paket",
            sections,
          };
          await sock.sendMessage(sender, listMessage);
          return;

        case "komplain_cs":
          userState[sender] = "MENUNGGU_KONFIRMASI_KOMPLAIN";
          saveState();
          const komplainButtons = [
            {
              buttonId: "hubungi_cs_ya",
              buttonText: { displayText: "Ya" },
              type: 1,
            },
            {
              buttonId: "hubungi_cs_tidak",
              buttonText: { displayText: "Tidak" },
              type: 1,
            },
          ];
          const komplainMessage = {
            text: "Anda akan menghubungi Layanan Pengaduan APENGJERS. Pastikan anda menjelaskan Permasalahan anda sedetail mungkin dan kooperatif dengan admin yang melayani.\n\n*Ya* untuk melanjutkan chat ke Layanan Pengaduan Apengjers, *Tidak* untuk Kembali ke Menu awal.",
            footer: "Konfirmasi Pilihan Anda",
            buttons: komplainButtons,
            headerType: 1,
          };
          await sock.sendMessage(sender, komplainMessage);
          return;

        case "joki_bloxfruit":
          await sock.sendMessage(sender, {
            text: "Layanan *Joki BloxFruit* akan segera hadir!",
          });
          return;
      }

      if (text.startsWith("cdid_")) {
        const product = cdidProducts[text];
        if (product) {
          userState[sender] = `MENUNGGU_FORM_CDID_${text}`;
          saveState();
          const formText = `Joki ${product.name}\nusername: \npassword: \npayment: Qris\nJumlah: `;
          await sock.sendMessage(sender, {
            text: "📝 Silakan salin, isi, dan kirim kembali form di bawah ini:",
          });
          await sock.sendMessage(sender, { text: formText });
          return;
        }
      }

      // LOGIKA DEFAULT: TAMPILKAN MENU UTAMA
      const buttons = [
        {
          buttonId: "joki_cdid",
          buttonText: { displayText: "Joki CDID 🚗" },
          type: 1,
        },
        {
          buttonId: "joki_bloxfruit",
          buttonText: { displayText: "Joki BloxFruit 🏴‍☠️" },
          type: 1,
        },
        {
          buttonId: "komplain_cs",
          buttonText: { displayText: "Komplain 💬" },
          type: 1,
        },
      ];
      const buttonMessage = {
        text: "Selamat datang di APENGJERS! 🤖\n\nSilakan pilih salah satu layanan joki di bawah ini.",
        footer: "Bot Joki Terpercaya",
        buttons: buttons,
        headerType: 1,
      };
      await sock.sendMessage(sender, buttonMessage);
    } catch (error) {
      console.error("Terjadi error di messages.upsert:", error);
    }
  });
}

// --- 7. Server Web & Webhook (Express) ---
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Server bot joki sedang berjalan!");
});

app.post("/webhook-midtrans", async (req, res) => {
  try {
    const notification = await snap.transaction.notification(req.body);
    const orderId = notification.order_id;
    const transactionStatus = notification.transaction_status;

    if (transactionStatus == "settlement" || transactionStatus == "capture") {
      const orderDetails = pendingOrders[orderId];
      if (!orderDetails) return res.status(200).send("OK (Order not found)");

      console.log(`✅ Pembayaran untuk order ${orderId} berhasil.`);

      const sheetData = {
        IDorder: orderId,
        "username:password (akun user)": `${orderDetails.username}:${orderDetails.password}`,
        "Tanggal Transaksi": new Date().toLocaleString("id-ID", {
          timeZone: "Asia/Jakarta",
        }),
        "Status Order": "Segera Diproses",
        "Nominal/Harga jokian yg dipilih": orderDetails.totalHarga,
      };

      await simpanOrderKeSheet(sheetData);
      await kirimNotifKeDiscord({ idOrder: orderId, ...orderDetails });

      const confirmationMessage = `Pembayaran diterima, joki sudah mulai diproses ya kak 🙏\nEstimasi selesai: ${orderDetails.estimasi}\nSelama proses berlangsung mohon jangan ditabrak/dimainkan dulu akunnya agar tidak mengganggu proses 🙏\nEstimasi tersebut sudah termasuk bonus uangnya juga ya kak 💸\nMohon ditunggu dan terima kasih atas kepercayaannya 😊`;
      await sock.sendMessage(orderDetails.sender, {
        text: confirmationMessage,
      });

      delete pendingOrders[orderId];
      saveState();
    }
    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Error di webhook Midtrans:", error.message);
    res.status(500).send("Error");
  }
});

// --- 8. Jalankan Aplikasi ---
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
  loadState();
  startBot();
});
