"use strict";

require("dotenv").config();

const { Client, LocalAuth, Buttons } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const axios = require("axios");
const express = require("express");

// ─────────────────────────────────────────────────────────────────────────────
// Session folder – local directory inside your project
// ─────────────────────────────────────────────────────────────────────────────
const SESSION_DATA_PATH = "./session";   // <-- this folder will be created automatically
console.log(`📁 Session will be stored in: ${SESSION_DATA_PATH}`);

// ─────────────────────────────────────────────────────────────────────────────
// Keep‑alive HTTP server (prevents Render from sleeping)
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) =>
  res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() })
);

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Health check server listening on http://0.0.0.0:${PORT}`);
});
server.on("error", (err) => {
  console.error("❌ HTTP server error:", err.message);
  process.exit(1);
});
setInterval(() => {
  console.log(`[Health] Server still listening on port ${PORT}`);
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const API_BASE = (process.env.API_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const SUPPORT_PHONE = process.env.SUPPORT_PHONE || "+254700000000";

// ─────────────────────────────────────────────────────────────────────────────
// In‑memory session store (conversation state)
// ─────────────────────────────────────────────────────────────────────────────
const sessions = new Map();

function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, {
      step: "idle",
      selectedProductId: null,
      selectedProductName: null,
      selectedProductPrice: null,
      targetPhone: null,
      transactionId: null,
      pollCount: 0,
      pollInterval: null,
    });
  }
  return sessions.get(from);
}

function resetSession(from) {
  const existing = sessions.get(from);
  if (existing?.pollInterval) clearInterval(existing.pollInterval);
  sessions.set(from, {
    step: "idle",
    selectedProductId: null,
    selectedProductName: null,
    selectedProductPrice: null,
    targetPhone: null,
    transactionId: null,
    pollCount: 0,
    pollInterval: null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// API helpers
// ─────────────────────────────────────────────────────────────────────────────
async function fetchProducts() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/products`, { timeout: 10000 });
    return data.success ? data.data : [];
  } catch (err) {
    console.error("[API] fetchProducts failed:", err.message);
    return [];
  }
}

async function initiateSTK(phone, productId) {
  const { data } = await axios.post(
    `${API_BASE}/api/mpesa/stk`,
    { phone, product_id: productId },
    { timeout: 30000 }
  );
  return data;
}

async function pollTransactionStatus(transactionId) {
  try {
    const { data } = await axios.get(
      `${API_BASE}/api/user/transaction-status?id=${transactionId}`,
      { timeout: 10000 }
    );
    return data.success ? data.data : null;
  } catch {
    return null;
  }
}

async function fetchUserOrders(phone) {
  try {
    const { data } = await axios.get(`${API_BASE}/api/user/orders?phone=${phone}`, { timeout: 10000 });
    return data.success ? data.data : [];
  } catch {
    return [];
  }
}

async function checkSystemStatus() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/system/status`, { timeout: 5000 });
    if (!data.success || !data.data?.worker_last_heartbeat) return false;
    const age = Date.now() - new Date(data.data.worker_last_heartbeat).getTime();
    return age < 2 * 60 * 1000;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phone normaliser
// ─────────────────────────────────────────────────────────────────────────────
function normalisePhone(raw) {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0") && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.startsWith("254") && digits.length === 12) return digits;
  if (digits.startsWith("7") && digits.length === 9) return `254${digits}`;
  if (digits.startsWith("1") && digits.length === 9) return `254${digits}`;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message builders – plain text menu (no List)
// ─────────────────────────────────────────────────────────────────────────────
async function buildProductTextMessage() {
  const products = await fetchProducts();
  if (!products.length) return null;

  let message = "*📦 AVAILABLE PACKAGES*\n\n";
  products.forEach((p, idx) => {
    message += `${idx + 1}. *${p.name}* – Ksh ${p.selling_price}\n`;
    if (p.description) message += `   ${p.description.substring(0, 80)}\n`;
    message += `   Reply *${idx + 1}* or *buy ${p.id}* to purchase\n\n`;
  });
  message += `_Reply with the number of the package you want._\n`;
  message += `📞 Support: ${SUPPORT_PHONE}`;
  return message;
}

function buildConfirmButtons(productName, price, phone) {
  return new Buttons(
    `Please confirm your purchase:\n\n*Package:* ${productName}\n*Price:* Ksh ${price}\n*Bundle for:* ${phone}\n\nAn M-Pesa STK Push will be sent to *${phone}* to complete payment.`,
    [
      { id: "confirm_yes", body: "✅ Confirm & Pay" },
      { id: "confirm_no", body: "❌ Cancel" },
    ],
    "Confirm Purchase",
    "Powered by DataMart"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling & purchase logic
// ─────────────────────────────────────────────────────────────────────────────
async function startPolling(client, from, transactionId) {
  const session = getSession(from);
  session.step = "polling";
  session.pollCount = 0;

  const interval = setInterval(async () => {
    session.pollCount++;
    if (session.pollCount > 24) {
      clearInterval(interval);
      session.pollInterval = null;
      resetSession(from);
      await client.sendMessage(
        from,
        `⏳ *Payment timed out.*\n\nNo charge was made to your account.\n\nReply *menu* to try again or contact support:\n${SUPPORT_PHONE}`
      );
      return;
    }

    try {
      const tx = await pollTransactionStatus(transactionId);
      if (!tx) return;

      if (tx.status === "SUCCESS") {
        clearInterval(interval);
        session.pollInterval = null;
        const productName = session.selectedProductName;
        resetSession(from);
        await client.sendMessage(
          from,
          `🎉 *Bundle Activated!*\n\nYour *${productName}* has been successfully activated.\n\nEnjoy your bundle! 🚀\n\nReply *menu* to buy more packages.`
        );
      } else if (tx.status === "PAID" || tx.status === "FULFILLING") {
        if (session.pollCount === 1 || tx.status === "PAID") {
          await client.sendMessage(
            from,
            `💳 *Payment received!*\n\nActivating your *${session.selectedProductName}* now…\n\nPlease wait a moment. ⏳`
          );
        }
      } else if (tx.status === "FAILED") {
        clearInterval(interval);
        session.pollInterval = null;
        const reason = tx.failure_reason || "Payment was not completed.";
        resetSession(from);
        await client.sendMessage(
          from,
          `❌ *Transaction Failed*\n\n${reason}\n\nNo money was deducted from your account.\n\nReply *menu* to try again or call:\n${SUPPORT_PHONE}`
        );
      }
    } catch (err) {
      console.error("[Poll] Error checking status:", err.message);
    }
  }, 5000);
  session.pollInterval = interval;
}

async function processPurchase(client, from, session) {
  await client.sendMessage(from, `📤 Sending M-Pesa prompt to *${session.targetPhone}*…`);
  try {
    const result = await initiateSTK(session.targetPhone, session.selectedProductId);
    if (!result.success) {
      let errMsg =
        result.code === "RATE_LIMITED"
          ? `⏳ Please wait *${result.retryAfterSeconds} seconds* before making another payment request.`
          : `❌ *Could not initiate payment.*\n\n${result.error || "Please try again."}\n\nIf this persists, call: ${SUPPORT_PHONE}`;
      resetSession(from);
      await client.sendMessage(from, errMsg);
      return;
    }
    session.transactionId = result.data.transaction_id;
    await client.sendMessage(
      from,
      `📱 *M-Pesa prompt sent!*\n\nCheck your phone and *enter your PIN* to pay *Ksh ${session.selectedProductPrice}* for *${session.selectedProductName}*.\n\n_The prompt expires in 60 seconds._`
    );
    if (result.data.system_busy) {
      await client.sendMessage(
        from,
        `⚠️ *Note:* Our activation system is in manual mode. Your bundle will be activated shortly after payment — slight delays expected.`
      );
    }
    await startPolling(client, from, session.transactionId);
  } catch (err) {
    console.error("[STK] Error:", err.message);
    resetSession(from);
    await client.sendMessage(from, `❌ Payment initiation failed. Please try again or call:\n${SUPPORT_PHONE}`);
  }
}

async function handleStatusCheck(client, from) {
  const senderNumber = from.replace("@c.us", "");
  const normPhone = normalisePhone(senderNumber);
  if (!normPhone) {
    await client.sendMessage(
      from,
      `Could not determine your phone number.\nPlease call support: ${SUPPORT_PHONE}`
    );
    return;
  }
  const orders = await fetchUserOrders(normPhone);
  if (!orders.length) {
    await client.sendMessage(from, `📭 You have no recent transactions.\n\nReply *menu* to browse packages.`);
    return;
  }
  const statusEmoji = { SUCCESS: "✅", FAILED: "❌", PENDING: "⏳", PAID: "💳", FULFILLING: "⚙️" };
  const lines = orders.map((tx) => {
    const emoji = statusEmoji[tx.status] || "•";
    const date = new Date(tx.created_at).toLocaleDateString("en-KE", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    return `${emoji} *${tx.product_name}* — Ksh ${tx.amount} (${tx.status}) — ${date}`;
  });
  await client.sendMessage(
    from,
    `📊 *Your Recent Orders:*\n\n${lines.join("\n")}\n\nReply *menu* to buy more packages.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main message handler
// ─────────────────────────────────────────────────────────────────────────────
async function handleMessage(client, msg) {
  try {
    const from = msg.from;
    const body = (msg.body || "").trim();
    const lower = body.toLowerCase();

    const chat = await msg.getChat();
    if (chat.isGroup) return;
    if (from === "status@broadcast") return;

    const session = getSession(from);

    // ── Handle interactive Button reply (confirm/cancel) ────────────────────
    if (msg.type === "buttons_response") {
      const btnId = msg.selectedButtonId || "";
      if (btnId === "confirm_no") {
        resetSession(from);
        await client.sendMessage(from, "Purchase cancelled. ❌\n\nReply *menu* to start again.");
        return;
      }
      if (btnId === "confirm_yes") {
        if (session.step !== "awaiting_confirm") {
          await client.sendMessage(from, "Session expired. Reply *menu* to start again.");
          return;
        }
        await processPurchase(client, from, session);
        return;
      }
    }

    // ── Text commands ──────────────────────────────────────────────────────
    if (
      lower === "menu" ||
      lower === "hi" ||
      lower === "hello" ||
      lower === "start" ||
      lower === "packages" ||
      lower === "buy" ||
      lower === "sema" ||
      lower === "niaje" ||
      lower === "habari" ||
      lower === "hii" ||
      lower === "hey" ||
      lower === "data" ||
      lower === "airtime" ||
      lower === "bundles" ||
      body === "0"
    ) {
      resetSession(from);
      const workerAlive = await checkSystemStatus();
      if (!workerAlive) {
        await client.sendMessage(
          from,
          `⚠️ *System Notice:* Our activation system is currently in manual mode. Purchases still work — bundle activation may take a few extra minutes.`
        );
      }
      const textMenu = await buildProductTextMessage();
      if (!textMenu) {
        await client.sendMessage(
          from,
          `No packages are available right now. Please try again later or call:\n${SUPPORT_PHONE}`
        );
        return;
      }
      await client.sendMessage(from, textMenu);
      return;
    }

    if (lower === "status" || lower === "orders" || lower === "history") {
      await handleStatusCheck(client, from);
      return;
    }
    if (lower === "help" || lower === "msaada" || lower === "support") {
      await client.sendMessage(
        from,
        `*DataMart Help* 🛎️\n\n` +
          `*Commands:*\n` +
          `• *menu* — Browse all packages\n` +
          `• *status* — Your recent orders\n` +
          `• *cancel* — Cancel current session\n` +
          `• *help* — This message\n\n` +
          `*Support:*\n` +
          `📞 Call: ${SUPPORT_PHONE}\n` +
          `💬 WhatsApp: ${SUPPORT_PHONE}\n\n` +
          `_Powered by DataMart_`
      );
      return;
    }
    if (lower === "cancel" || lower === "stop" || lower === "quit") {
      resetSession(from);
      await client.sendMessage(from, "Session cancelled. ✅\n\nReply *menu* to start fresh.");
      return;
    }

    // ── Step: waiting for phone number ──────────────────────────────────────
    if (session.step === "awaiting_phone") {
      const normPhone = normalisePhone(body);
      if (!normPhone) {
        await client.sendMessage(
          from,
          `❌ *Invalid phone number:* ${body}\n\nPlease enter a valid Safaricom number:\n• 0712345678\n• 254712345678\n\nOr reply *cancel* to start over.`
        );
        return;
      }
      session.targetPhone = normPhone;
      session.step = "awaiting_confirm";
      const confirmMsg = buildConfirmButtons(
        session.selectedProductName,
        session.selectedProductPrice,
        normPhone
      );
      await client.sendMessage(from, confirmMsg);
      return;
    }

    // ── Step: awaiting confirmation button ──────────────────────────────────
    if (session.step === "awaiting_confirm") {
      if (lower === "yes" || lower === "confirm" || lower === "pay" || lower === "ndio") {
        await processPurchase(client, from, session);
        return;
      }
      if (lower === "no" || lower === "cancel" || lower === "hapana") {
        resetSession(from);
        await client.sendMessage(from, "Purchase cancelled.\n\nReply *menu* to start again.");
        return;
      }
      await client.sendMessage(
        from,
        "Please tap *Confirm & Pay* or *Cancel* on the message above.\n\nOr reply *cancel* to start over."
      );
      return;
    }

    // ── Step: polling ───────────────────────────────────────────────────────
    if (session.step === "polling") {
      if (lower === "cancel") {
        resetSession(from);
        await client.sendMessage(
          from,
          "Cancelled. ✅ If money was deducted, please contact support:\n" + SUPPORT_PHONE
        );
        return;
      }
      await client.sendMessage(
        from,
        `⏳ *Waiting for your M-Pesa payment…*\n\nPlease enter your PIN on the prompt on your phone.\n\nReply *cancel* to abort.`
      );
      return;
    }

    // ── Idle state: product selection by number or "buy X" ──────────────────
    let productId = null;
    const buyMatch = lower.match(/^buy\s*(\d+)$/);
    if (buyMatch) {
      productId = parseInt(buyMatch[1], 10);
    } else if (/^\d+$/.test(body)) {
      const index = parseInt(body, 10);
      const products = await fetchProducts();
      if (index >= 1 && index <= products.length) {
        productId = products[index - 1].id;
      }
    }

    if (productId) {
      const products = await fetchProducts();
      const product = products.find((p) => p.id === productId);
      if (product) {
        session.selectedProductId = product.id;
        session.selectedProductName = product.name;
        session.selectedProductPrice = product.selling_price;
        session.step = "awaiting_phone";
        await client.sendMessage(
          from,
          `Great choice! 📦 *${product.name}* — Ksh ${product.selling_price}\n\nPlease send the *phone number* that should receive this bundle:\n\n_Format: 0712345678 or 254712345678_`
        );
        return;
      } else {
        await client.sendMessage(from, `❌ Product not found. Reply *menu* to see available packages.`);
        return;
      }
    }

    // ── Fallback for unrecognised messages ──────────────────────────────────
    await client.sendMessage(
      from,
      `👋 Welcome to *DataMart!*\n\nGet affordable data bundles, airtime & SMS — paid instantly via M-Pesa.\n\nReply *menu* to see all packages.\nReply *help* for support.\n\n📞 ${SUPPORT_PHONE}`
    );
  } catch (err) {
    console.error("[Message handler error] Full error:", err);
    console.error("[Message handler error] Stack:", err.stack);
    const from = msg.from;
    if (from && !from.includes("@g.us")) {
      try {
        await client.sendMessage(from, "⚠️ An internal error occurred. Please try again or contact support.");
      } catch (sendErr) {
        console.error("Failed to send error message to user:", sendErr);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp client initialisation with persistent local session folder
// and anti‑disconnect measures
// ─────────────────────────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DATA_PATH }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu",
    ],
  },
});

// Keep‑alive ping: sends presence every 30 seconds to prevent WebSocket timeout
let pingInterval = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

async function sendKeepAlivePing() {
  if (!client) return;
  try {
    await client.sendPresenceAvailable();
    console.log("[Ping] Presence sent – connection kept alive");
  } catch (err) {
    console.warn("[Ping] Failed to send keep-alive:", err.message);
  }
}

client.on("ready", async () => {
  console.log("🚀 DataMart WhatsApp Bot is LIVE!");
  console.log(`📁 Session folder: ${SESSION_DATA_PATH}`);
  console.log(`📡 API Base URL : ${API_BASE}`);
  console.log(`📞 Support Phone: ${SUPPORT_PHONE}\n`);

  const products = await fetchProducts();
  if (products.length) console.log(`✅ API reachable — ${products.length} active products loaded.`);
  else console.warn("⚠️  Could not load products from API. Check API_BASE_URL in .env");

  const workerAlive = await checkSystemStatus();
  console.log(`   Worker status: ${workerAlive ? "🟢 ONLINE" : "🔴 OFFLINE"}\n`);

  // Start keep‑alive pinger
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = setInterval(sendKeepAlivePing, 30 * 1000);
  reconnectAttempts = 0;
});

client.on("qr", (qr) => {
  console.log("\n📱 Scan this QR code with WhatsApp:\n");
  console.log("   Open WhatsApp → Settings → Linked Devices → Link a Device\n");
  qrcode.generate(qr, { small: true });
  console.log("");
});

client.on("authenticated", () => {
  console.log("✅ Authenticated — session saved to:", SESSION_DATA_PATH);
});

client.on("auth_failure", (msg) => {
  console.error("❌ Authentication failed:", msg);
  process.exit(1);
});

client.on("message", async (msg) => {
  try {
    await handleMessage(client, msg);
  } catch (err) {
    console.error("[Client message event] Unhandled error:", err);
  }
});

client.on("disconnected", (reason) => {
  console.warn("\n⚠️  WhatsApp disconnected:", reason);
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = null;

  const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 300000);
  reconnectAttempts++;
  console.log(`   Reconnecting in ${delay / 1000} seconds... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

  setTimeout(() => {
    if (client) {
      client.initialize().catch((err) => {
        console.error("Failed to reinitialise:", err.message);
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          console.error("Max reconnect attempts reached. Exiting.");
          process.exit(1);
        }
      });
    }
  }, delay);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down gracefully...");
  if (pingInterval) clearInterval(pingInterval);
  server.close(() => console.log("HTTP server closed"));
  if (client) await client.destroy();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  console.log("\nSIGTERM received, shutting down...");
  if (pingInterval) clearInterval(pingInterval);
  server.close(() => console.log("HTTP server closed"));
  if (client) await client.destroy();
  process.exit(0);
});

// Start the bot
console.log("Starting DataMart WhatsApp Bot…");
console.log(`Node.js ${process.version}\n`);
client.initialize().catch((err) => {
  console.error("Failed to initialise WhatsApp client:", err.message);
  process.exit(1);
});