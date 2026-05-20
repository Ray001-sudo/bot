"use strict";

require("dotenv").config();

const { Client, LocalAuth, List, Buttons } = require("whatsapp-web.js");
const qrcode         = require("qrcode-terminal");
const QRCode         = require("qrcode");
const axios          = require("axios");
const http           = require("http");

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE      = (process.env.API_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const SUPPORT_PHONE = process.env.SUPPORT_PHONE || "+254700000000";
const PORT          = process.env.PORT || 3001;

// ─────────────────────────────────────────────────────────────────────────────
// QR HTTP Server
// When the bot needs a QR scan, visit:
//   http://localhost:3001         (local)
//   https://your-bot.onrender.com (Render)
// The page auto-refreshes every 10s so you always see the latest QR code.
// ─────────────────────────────────────────────────────────────────────────────

let currentQR        = null;   // raw QR string from whatsapp-web.js
let qrImageDataUrl   = null;   // base64 PNG of the QR code
let botStatus        = "starting"; // "starting" | "qr_ready" | "authenticated" | "ready"

async function updateQRImage(qrString) {
  try {
    qrImageDataUrl = await QRCode.toDataURL(qrString, {
      width: 400,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });
  } catch (err) {
    console.error("[QR] Failed to generate QR image:", err.message);
  }
}

const httpServer = http.createServer(async (req, res) => {
  // Health check endpoint — Render uses this to confirm the service is up
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: botStatus, timestamp: new Date().toISOString() }));
    return;
  }

  // Main QR page
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

  if (botStatus === "ready" || botStatus === "authenticated") {
    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>DataMart Bot</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: sans-serif; display: flex; flex-direction: column;
                   align-items: center; justify-content: center; min-height: 100vh;
                   margin: 0; background: #f0fdf4; }
            .card { background: white; border-radius: 16px; padding: 40px;
                    box-shadow: 0 4px 24px rgba(0,0,0,0.08); text-align: center; max-width: 400px; }
            .icon { font-size: 64px; margin-bottom: 16px; }
            h1 { color: #16a34a; margin: 0 0 8px; }
            p { color: #6b7280; margin: 0; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">✅</div>
            <h1>Bot is Live!</h1>
            <p>DataMart WhatsApp Bot is connected and running.<br>No QR scan needed.</p>
          </div>
        </body>
      </html>
    `);
    return;
  }

  if (!qrImageDataUrl) {
    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>DataMart Bot — Starting</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta http-equiv="refresh" content="5">
          <style>
            body { font-family: sans-serif; display: flex; flex-direction: column;
                   align-items: center; justify-content: center; min-height: 100vh;
                   margin: 0; background: #f9fafb; }
            .card { background: white; border-radius: 16px; padding: 40px;
                    box-shadow: 0 4px 24px rgba(0,0,0,0.08); text-align: center; max-width: 400px; }
            .spinner { width: 48px; height: 48px; border: 4px solid #e5e7eb;
                       border-top-color: #16a34a; border-radius: 50%;
                       animation: spin 1s linear infinite; margin: 0 auto 16px; }
            @keyframes spin { to { transform: rotate(360deg); } }
            h1 { color: #111827; margin: 0 0 8px; font-size: 20px; }
            p { color: #6b7280; margin: 0; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="spinner"></div>
            <h1>Starting WhatsApp Bot…</h1>
            <p>QR code is being generated.<br>This page refreshes automatically.</p>
          </div>
        </body>
      </html>
    `);
    return;
  }

  // QR code ready — show it
  res.end(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>DataMart Bot — Scan QR</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="refresh" content="30">
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                 display: flex; flex-direction: column; align-items: center;
                 justify-content: center; min-height: 100vh;
                 background: #f0fdf4; padding: 24px; }
          .card { background: white; border-radius: 20px; padding: 40px 32px;
                  box-shadow: 0 8px 32px rgba(0,0,0,0.10); text-align: center;
                  max-width: 480px; width: 100%; }
          .logo { font-size: 40px; margin-bottom: 8px; }
          h1 { color: #111827; font-size: 22px; margin-bottom: 6px; }
          .subtitle { color: #6b7280; font-size: 14px; margin-bottom: 28px; line-height: 1.5; }
          .qr-wrapper { background: #f9fafb; border: 2px solid #e5e7eb;
                        border-radius: 16px; padding: 20px; display: inline-block;
                        margin-bottom: 24px; }
          .qr-wrapper img { display: block; width: 280px; height: 280px; }
          .steps { text-align: left; background: #f0fdf4; border-radius: 12px;
                   padding: 16px 20px; margin-bottom: 20px; }
          .steps p { font-size: 13px; color: #374151; margin-bottom: 6px; line-height: 1.5; }
          .steps p:last-child { margin-bottom: 0; }
          .steps strong { color: #16a34a; }
          .refresh-note { color: #9ca3af; font-size: 12px; }
          .pulse { display: inline-block; width: 8px; height: 8px; background: #16a34a;
                   border-radius: 50%; margin-right: 6px;
                   animation: pulse 2s ease-in-out infinite; }
          @keyframes pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.5; transform: scale(1.3); }
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="logo">📱</div>
          <h1>Scan to Connect WhatsApp Bot</h1>
          <p class="subtitle">
            <span class="pulse"></span>Waiting for QR scan…
          </p>

          <div class="qr-wrapper">
            <img src="${qrImageDataUrl}" alt="WhatsApp QR Code" />
          </div>

          <div class="steps">
            <p><strong>Step 1:</strong> Open WhatsApp on your phone</p>
            <p><strong>Step 2:</strong> Tap <strong>⋮ Menu</strong> → <strong>Linked Devices</strong></p>
            <p><strong>Step 3:</strong> Tap <strong>Link a Device</strong></p>
            <p><strong>Step 4:</strong> Point your camera at this QR code</p>
          </div>

          <p class="refresh-note">⟳ Page auto-refreshes every 30 seconds if QR expires</p>
        </div>
      </body>
    </html>
  `);
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🌐 QR Server running on port ${PORT}`);
  console.log(`   Local:  http://localhost:${PORT}`);
  console.log(`   Render: https://your-bot-service.onrender.com\n`);
});

// ─────────────────────────────────────────────────────────────────────────────
// In-memory session store
// ─────────────────────────────────────────────────────────────────────────────

const sessions = new Map();

function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, {
      step:                 "idle",
      selectedProductId:    null,
      selectedProductName:  null,
      selectedProductPrice: null,
      targetPhone:          null,
      transactionId:        null,
      pollCount:            0,
      pollInterval:         null,
    });
  }
  return sessions.get(from);
}

function resetSession(from) {
  const existing = sessions.get(from);
  if (existing?.pollInterval) clearInterval(existing.pollInterval);
  sessions.set(from, {
    step:                 "idle",
    selectedProductId:    null,
    selectedProductName:  null,
    selectedProductPrice: null,
    targetPhone:          null,
    transactionId:        null,
    pollCount:            0,
    pollInterval:         null,
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
    const { data } = await axios.get(
      `${API_BASE}/api/user/orders?phone=${phone}`,
      { timeout: 10000 }
    );
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
  if (digits.startsWith("0")   && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.startsWith("254") && digits.length === 12) return digits;
  if (digits.startsWith("7")   && digits.length === 9)  return `254${digits}`;
  if (digits.startsWith("1")   && digits.length === 9)  return `254${digits}`;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message builders
// ─────────────────────────────────────────────────────────────────────────────

async function buildProductListMessage() {
  const products = await fetchProducts();
  if (!products.length) return null;

  const grouped = {};
  for (const p of products) {
    const cat = p.category || "OTHER";
    if (!grouped[cat]) grouped[cat] = [];
    if (grouped[cat].length < 10) {
      grouped[cat].push({
        id:          `buy_${p.id}`,
        title:       p.name.substring(0, 24),
        description: `Ksh ${p.selling_price}${p.description ? " — " + p.description.substring(0, 60) : ""}`,
      });
    }
  }

  const sections = Object.entries(grouped).map(([title, rows]) => ({ title, rows }));

  return new List(
    "Select a package below to purchase via M-Pesa STK Push. 📱",
    "📦 View Packages",
    sections,
    "Available Packages",
    `Support: ${SUPPORT_PHONE}`
  );
}

function buildConfirmButtons(productName, price, phone) {
  return new Buttons(
    `Please confirm your purchase:\n\n*Package:* ${productName}\n*Price:* Ksh ${price}\n*Bundle for:* ${phone}\n\nAn M-Pesa STK Push will be sent to *${phone}* to complete payment.`,
    [
      { id: "confirm_yes", body: "✅ Confirm & Pay" },
      { id: "confirm_no",  body: "❌ Cancel"        },
    ],
    "Confirm Purchase",
    "Powered by DataMart"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling loop
// ─────────────────────────────────────────────────────────────────────────────

async function startPolling(client, from, transactionId) {
  const session     = getSession(from);
  session.step      = "polling";
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
          `🎉 *Bundle Activated!*\n\nYour *${productName}* has been successfully activated.\n\nEnjoy! 🚀\n\nReply *menu* to buy more.`
        );

      } else if (tx.status === "PAID" || tx.status === "FULFILLING") {
        if (session.pollCount === 1) {
          await client.sendMessage(
            from,
            `💳 *Payment received!*\n\nActivating your *${session.selectedProductName}* now… ⏳`
          );
        }

      } else if (tx.status === "FAILED") {
        clearInterval(interval);
        session.pollInterval = null;
        const reason = tx.failure_reason || "Payment was not completed.";
        resetSession(from);
        await client.sendMessage(
          from,
          `❌ *Transaction Failed*\n\n${reason}\n\nNo money was deducted.\n\nReply *menu* to try again or call:\n${SUPPORT_PHONE}`
        );
      }
    } catch (err) {
      console.error("[Poll] Error:", err.message);
    }
  }, 5000);

  session.pollInterval = interval;
}

// ─────────────────────────────────────────────────────────────────────────────
// Purchase processor
// ─────────────────────────────────────────────────────────────────────────────

async function processPurchase(client, from, session) {
  await client.sendMessage(from, `📤 Sending M-Pesa prompt to *${session.targetPhone}*…`);

  try {
    const result = await initiateSTK(session.targetPhone, session.selectedProductId);

    if (!result.success) {
      const errMsg = result.code === "RATE_LIMITED"
        ? `⏳ Please wait *${result.retryAfterSeconds} seconds* before making another request.`
        : `❌ *Could not initiate payment.*\n\n${result.error || "Please try again."}\n\nIf this persists, call: ${SUPPORT_PHONE}`;
      resetSession(from);
      await client.sendMessage(from, errMsg);
      return;
    }

    session.transactionId = result.data.transaction_id;

    await client.sendMessage(
      from,
      `📱 *M-Pesa prompt sent!*\n\nCheck your phone and *enter your PIN* to pay *Ksh ${session.selectedProductPrice}* for *${session.selectedProductName}*.\n\n_Prompt expires in 60 seconds._`
    );

    if (result.data.system_busy) {
      await client.sendMessage(
        from,
        `⚠️ *Note:* Activation is in manual mode. Your bundle will be activated shortly — slight delays expected.`
      );
    }

    await startPolling(client, from, session.transactionId);

  } catch (err) {
    console.error("[STK] Error:", err.message);
    resetSession(from);
    await client.sendMessage(
      from,
      `❌ Payment initiation failed. Please try again or call:\n${SUPPORT_PHONE}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status check
// ─────────────────────────────────────────────────────────────────────────────

async function handleStatusCheck(client, from) {
  const senderNumber = from.replace("@c.us", "");
  const normPhone    = normalisePhone(senderNumber);

  if (!normPhone) {
    await client.sendMessage(from, `Could not determine your phone number.\nCall support: ${SUPPORT_PHONE}`);
    return;
  }

  const orders = await fetchUserOrders(normPhone);

  if (!orders.length) {
    await client.sendMessage(from, `📭 You have no recent transactions.\n\nReply *menu* to browse packages.`);
    return;
  }

  const statusEmoji = {
    SUCCESS: "✅", FAILED: "❌", PENDING: "⏳", PAID: "💳", FULFILLING: "⚙️",
  };

  const lines = orders.map((tx) => {
    const emoji = statusEmoji[tx.status] || "•";
    const date  = new Date(tx.created_at).toLocaleDateString("en-KE", {
      day: "2-digit", month: "short", year: "numeric",
    });
    return `${emoji} *${tx.product_name}* — Ksh ${tx.amount} (${tx.status}) — ${date}`;
  });

  await client.sendMessage(
    from,
    `📊 *Your Recent Orders:*\n\n${lines.join("\n")}\n\nReply *menu* to buy more.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main message handler
// ─────────────────────────────────────────────────────────────────────────────

async function handleMessage(client, msg) {
  const from  = msg.from;
  const body  = (msg.body || "").trim();
  const lower = body.toLowerCase();

  const chat = await msg.getChat();
  if (chat.isGroup) return;
  if (from === "status@broadcast") return;

  const session = getSession(from);

  // ── List reply ─────────────────────────────────────────────────────────────
  if (msg.type === "list_response") {
    const selectedId = msg.selectedRowId || "";
    if (selectedId.startsWith("buy_")) {
      const productId = parseInt(selectedId.replace("buy_", ""), 10);
      const products  = await fetchProducts();
      const product   = products.find((p) => p.id === productId);

      if (!product) {
        await client.sendMessage(from, "Sorry, that package is no longer available.\n\nReply *menu* to see current packages.");
        return;
      }

      session.selectedProductId    = product.id;
      session.selectedProductName  = product.name;
      session.selectedProductPrice = product.selling_price;
      session.step                 = "awaiting_phone";

      await client.sendMessage(
        from,
        `Great choice! 📦 *${product.name}* — Ksh ${product.selling_price}\n\nPlease send the *phone number* to receive this bundle:\n\n_Format: 0712345678 or 254712345678_`
      );
      return;
    }
  }

  // ── Button reply ───────────────────────────────────────────────────────────
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

  // ── Menu & greetings ───────────────────────────────────────────────────────
  if (
    lower === "menu"    || lower === "hi"      || lower === "hello"   ||
    lower === "start"   || lower === "packages" || lower === "buy"     ||
    lower === "sema"    || lower === "niaje"    || lower === "habari"  ||
    lower === "hii"     || lower === "hey"      || lower === "data"    ||
    lower === "airtime" || lower === "bundles"  || body  === "0"
  ) {
    resetSession(from);
    const workerAlive = await checkSystemStatus();

    if (!workerAlive) {
      await client.sendMessage(
        from,
        `⚠️ *System Notice:* Activation is in manual mode. Purchases still work — bundle activation may take a few extra minutes.`
      );
    }

    const listMsg = await buildProductListMessage();
    if (!listMsg) {
      await client.sendMessage(from, `No packages available right now. Please try later or call:\n${SUPPORT_PHONE}`);
      return;
    }

    await client.sendMessage(from, listMsg);
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
      `📞 Call/WhatsApp: ${SUPPORT_PHONE}\n\n` +
      `_Powered by DataMart_`
    );
    return;
  }

  if (lower === "cancel" || lower === "stop" || lower === "quit") {
    resetSession(from);
    await client.sendMessage(from, "Session cancelled. ✅\n\nReply *menu* to start fresh.");
    return;
  }

  // ── Awaiting phone number ──────────────────────────────────────────────────
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
    session.step        = "awaiting_confirm";

    await client.sendMessage(from, buildConfirmButtons(
      session.selectedProductName,
      session.selectedProductPrice,
      normPhone
    ));
    return;
  }

  // ── Awaiting confirmation ──────────────────────────────────────────────────
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

  // ── Polling ────────────────────────────────────────────────────────────────
  if (session.step === "polling") {
    if (lower === "cancel") {
      resetSession(from);
      await client.sendMessage(
        from,
        "Cancelled. ✅ If money was deducted, contact support:\n" + SUPPORT_PHONE
      );
      return;
    }
    await client.sendMessage(
      from,
      `⏳ *Waiting for your M-Pesa payment…*\n\nPlease enter your PIN on the prompt.\n\nReply *cancel* to abort.`
    );
    return;
  }

  // ── Fallback ───────────────────────────────────────────────────────────────
  await client.sendMessage(
    from,
    `👋 Welcome to *DataMart!*\n\nGet affordable data bundles, airtime & SMS — paid instantly via M-Pesa.\n\nReply *menu* to see all packages.\nReply *help* for support.\n\n📞 ${SUPPORT_PHONE}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp client
// ─────────────────────────────────────────────────────────────────────────────

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: "./.wwebjs_auth",
  }),
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

client.on("qr", async (qr) => {
  currentQR   = qr;
  botStatus   = "qr_ready";

  // Also print small version in terminal as backup
  console.log("\n📱 QR code generated.");
  console.log("   ➡  Open your browser to scan it properly:\n");
  console.log(`   Local:  http://localhost:${PORT}`);
  console.log(`   Render: https://your-bot-service.onrender.com\n`);
  qrcode.generate(qr, { small: true });

  // Generate the clean browser-scannable image
  await updateQRImage(qr);
});

client.on("authenticated", () => {
  botStatus = "authenticated";
  console.log("✅ Authenticated — session saved.");
});

client.on("auth_failure", (msg) => {
  console.error("❌ Auth failed:", msg);
  process.exit(1);
});

client.on("ready", async () => {
  botStatus = "ready";
  console.log("\n🚀 DataMart WhatsApp Bot is LIVE!\n");
  console.log(`   API Base URL : ${API_BASE}`);
  console.log(`   Support Phone: ${SUPPORT_PHONE}\n`);

  const products = await fetchProducts();
  if (products.length) {
    console.log(`✅ API reachable — ${products.length} active products loaded.`);
  } else {
    console.warn("⚠️  Could not load products. Check API_BASE_URL in .env");
  }

  const workerAlive = await checkSystemStatus();
  console.log(`   Worker status: ${workerAlive ? "🟢 ONLINE" : "🔴 OFFLINE"}\n`);
});

client.on("message", async (msg) => {
  try {
    await handleMessage(client, msg);
  } catch (err) {
    console.error("[Message handler error]", err.message);
  }
});

client.on("disconnected", (reason) => {
  botStatus = "starting";
  console.warn("\n⚠️  Disconnected:", reason);
  console.log("   Reinitialising in 5 seconds…\n");
  setTimeout(() => {
    client.initialize().catch((err) => {
      console.error("Failed to reinitialise:", err.message);
      process.exit(1);
    });
  }, 5000);
});

// ── Boot ──────────────────────────────────────────────────────────────────────
console.log(`\nStarting DataMart WhatsApp Bot…`);
console.log(`Node.js ${process.version}\n`);

client.initialize().catch((err) => {
  console.error("Failed to initialise:", err.message);
  process.exit(1);
});