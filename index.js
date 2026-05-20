"use strict";

require("dotenv").config();

const { Client, LocalAuth, List, Buttons } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const axios  = require("axios");
const express = require('express');

// ─────────────────────────────────────────────────────────────────────────────
// Health check HTTP server for Render (must bind to 0.0.0.0)
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.status(200).send('OK');
});
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Health check server listening on http://0.0.0.0:${PORT}`);
});
server.on('error', (err) => {
  console.error('❌ HTTP server error:', err.message);
  process.exit(1);
});

// Periodic log to prove the server is alive (every 5 minutes)
setInterval(() => {
  console.log(`[Health] Server still listening on port ${PORT}`);
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE      = (process.env.API_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const SUPPORT_PHONE = process.env.SUPPORT_PHONE || "+254700000000";

// ─────────────────────────────────────────────────────────────────────────────
// In-memory session store
// Tracks each user's conversation state across messages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Session shape per user:
 * {
 *   step: "idle" | "awaiting_phone" | "awaiting_confirm" | "polling",
 *   selectedProductId:    number | null,
 *   selectedProductName:  string | null,
 *   selectedProductPrice: number | null,
 *   targetPhone:          string | null,
 *   transactionId:        number | null,
 *   pollCount:            number,
 *   pollInterval:         NodeJS timer | null,
 * }
 */
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
  // Clear any running poll timer before resetting
  if (existing?.pollInterval) {
    clearInterval(existing.pollInterval);
  }
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
// API helpers — all talk to your existing Next.js backend
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

  // Group by category, max 10 rows per section (WhatsApp limit)
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

  try {
    return new List(
      "Select a package below to purchase via M-Pesa STK Push. 📱",
      "📦 View Packages",
      sections,
      "Available Packages",
      `Support: ${SUPPORT_PHONE}`
    );
  } catch (err) {
    console.error("[List] Failed to create List message, using fallback:", err);
    // Fallback: simple text list
    let fallback = "*Available Packages:*\n\n";
    products.forEach((p, idx) => {
      fallback += `${idx+1}. *${p.name}* – Ksh ${p.selling_price}\n   Reply *buy ${p.id}* to purchase\n\n`;
    });
    fallback += `Reply *help* for support.`;
    return fallback;
  }
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
// Polling — checks transaction status every 5s, times out after 2 minutes
// ─────────────────────────────────────────────────────────────────────────────

async function startPolling(client, from, transactionId) {
  const session      = getSession(from);
  session.step       = "polling";
  session.pollCount  = 0;

  const interval = setInterval(async () => {
    session.pollCount++;

    // 24 polls × 5 seconds = 2 minutes timeout
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
        // Only send this message once when payment is first confirmed
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
      // PENDING = still waiting for PIN, keep polling silently

    } catch (err) {
      console.error("[Poll] Error checking status:", err.message);
    }
  }, 5000);

  session.pollInterval = interval;
}

// ─────────────────────────────────────────────────────────────────────────────
// Purchase processor — called after user taps "Confirm & Pay"
// ─────────────────────────────────────────────────────────────────────────────

async function processPurchase(client, from, session) {
  await client.sendMessage(
    from,
    `📤 Sending M-Pesa prompt to *${session.targetPhone}*…`
  );

  try {
    const result = await initiateSTK(session.targetPhone, session.selectedProductId);

    if (!result.success) {
      let errMsg;
      if (result.code === "RATE_LIMITED") {
        errMsg = `⏳ Please wait *${result.retryAfterSeconds} seconds* before making another payment request.`;
      } else {
        errMsg = `❌ *Could not initiate payment.*\n\n${result.error || "Please try again."}\n\nIf this persists, call: ${SUPPORT_PHONE}`;
      }
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

    // Start polling for confirmation
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
// Status check — shows last 5 orders for the sender's number
// ─────────────────────────────────────────────────────────────────────────────

async function handleStatusCheck(client, from) {
  // Extract sender's own number from the WhatsApp ID (format: 254712345678@c.us)
  const senderNumber = from.replace("@c.us", "");
  const normPhone    = normalisePhone(senderNumber);

  if (!normPhone) {
    await client.sendMessage(
      from,
      `Could not determine your phone number.\nPlease call support: ${SUPPORT_PHONE}`
    );
    return;
  }

  const orders = await fetchUserOrders(normPhone);

  if (!orders.length) {
    await client.sendMessage(
      from,
      `📭 You have no recent transactions.\n\nReply *menu* to browse packages.`
    );
    return;
  }

  const statusEmoji = {
    SUCCESS:    "✅",
    FAILED:     "❌",
    PENDING:    "⏳",
    PAID:       "💳",
    FULFILLING: "⚙️",
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
    `📊 *Your Recent Orders:*\n\n${lines.join("\n")}\n\nReply *menu* to buy more packages.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main message handler
// ─────────────────────────────────────────────────────────────────────────────

async function handleMessage(client, msg) {
  try {
    const from  = msg.from;
    const body  = (msg.body || "").trim();
    const lower = body.toLowerCase();

    // Only respond to individual chats, not groups
    const chat = await msg.getChat();
    if (chat.isGroup) return;

    // Ignore status broadcasts
    if (from === "status@broadcast") return;

    const session = getSession(from);

    // ── Handle interactive List reply (product selected from menu) ─────────────
    if (msg.type === "list_response") {
      const selectedId = msg.selectedRowId || "";

      if (selectedId.startsWith("buy_")) {
        const productId = parseInt(selectedId.replace("buy_", ""), 10);
        const products  = await fetchProducts();
        const product   = products.find((p) => p.id === productId);

        if (!product) {
          await client.sendMessage(
            from,
            "Sorry, that package is no longer available.\n\nReply *menu* to see current packages."
          );
          return;
        }

        session.selectedProductId    = product.id;
        session.selectedProductName  = product.name;
        session.selectedProductPrice = product.selling_price;
        session.step                 = "awaiting_phone";

        await client.sendMessage(
          from,
          `Great choice! 📦 *${product.name}* — Ksh ${product.selling_price}\n\nPlease send the *phone number* that should receive this bundle:\n\n_Format: 0712345678 or 254712345678_`
        );
        return;
      }
    }

    // ── Handle interactive Button reply (confirm or cancel) ────────────────────
    if (msg.type === "buttons_response") {
      const btnId = msg.selectedButtonId || "";

      if (btnId === "confirm_no") {
        resetSession(from);
        await client.sendMessage(
          from,
          "Purchase cancelled. ❌\n\nReply *menu* to start again."
        );
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

    // ── Text commands ──────────────────────────────────────────────────────────

    // Greetings & main menu trigger
    if (
      lower === "menu"     || lower === "hi"       || lower === "hello"  ||
      lower === "start"    || lower === "packages"  || lower === "buy"    ||
      lower === "sema"     || lower === "niaje"     || lower === "habari" ||
      lower === "hii"      || lower === "hey"       || lower === "data"   ||
      lower === "airtime"  || lower === "bundles"   || body === "0"
    ) {
      resetSession(from);
      const workerAlive = await checkSystemStatus();

      if (!workerAlive) {
        await client.sendMessage(
          from,
          `⚠️ *System Notice:* Our activation system is currently in manual mode. Purchases still work — bundle activation may take a few extra minutes.`
        );
      }

      const listMsg = await buildProductListMessage();
      if (!listMsg) {
        await client.sendMessage(
          from,
          `No packages are available right now. Please try again later or call:\n${SUPPORT_PHONE}`
        );
        return;
      }

      try {
        await client.sendMessage(from, listMsg);
      } catch (err) {
        console.error("[Send List] Failed to send List message:", err);
        if (typeof listMsg === 'string') {
          await client.sendMessage(from, listMsg);
        } else {
          await client.sendMessage(from, "❌ Failed to show packages. Please try again later.");
        }
      }
      return;
    }

    // Order status
    if (lower === "status" || lower === "orders" || lower === "history") {
      await handleStatusCheck(client, from);
      return;
    }

    // Help
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

    // Cancel
    if (lower === "cancel" || lower === "stop" || lower === "quit") {
      resetSession(from);
      await client.sendMessage(
        from,
        "Session cancelled. ✅\n\nReply *menu* to start fresh."
      );
      return;
    }

    // ── Step: waiting for phone number ─────────────────────────────────────────

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

      const confirmMsg = buildConfirmButtons(
        session.selectedProductName,
        session.selectedProductPrice,
        normPhone
      );

      await client.sendMessage(from, confirmMsg);
      return;
    }

    // ── Step: waiting for confirmation button tap ──────────────────────────────

    if (session.step === "awaiting_confirm") {
      // User typed text instead of tapping a button
      if (lower === "yes" || lower === "confirm" || lower === "pay" || lower === "ndio") {
        await processPurchase(client, from, session);
        return;
      }
      if (lower === "no" || lower === "cancel" || lower === "hapana") {
        resetSession(from);
        await client.sendMessage(from, "Purchase cancelled.\n\nReply *menu* to start again.");
        return;
      }
      // Remind them to tap the buttons
      await client.sendMessage(
        from,
        "Please tap *Confirm & Pay* or *Cancel* on the message above.\n\nOr reply *cancel* to start over."
      );
      return;
    }

    // ── Step: polling — waiting for M-Pesa payment ─────────────────────────────

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

    // ── Fallback — idle state, unknown message ─────────────────────────────────

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
// WhatsApp client initialisation
// ─────────────────────────────────────────────────────────────────────────────

const client = new Client({
  authStrategy: new LocalAuth({
    // Session is saved here — survives bot restarts without re-scanning QR
    dataPath: "./.wwebjs_auth",
  }),
  puppeteer: {
    headless: true,
    // No executablePath — Puppeteer uses .puppeteerrc.cjs to find
    // the Chrome it downloaded into .cache/puppeteer/
    // This works identically on Windows, Mac, and Linux/Render
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

// ── QR code (shown once on first run) ─────────────────────────────────────────
client.on("qr", (qr) => {
  console.log("\n📱 Scan this QR code with WhatsApp:\n");
  console.log("   Open WhatsApp → Settings → Linked Devices → Link a Device\n");
  qrcode.generate(qr, { small: true });
  console.log("");
});

// ── Auth events ───────────────────────────────────────────────────────────────
client.on("authenticated", () => {
  console.log("✅ Authenticated — session saved to .wwebjs_auth/");
});

client.on("auth_failure", (msg) => {
  console.error("❌ Authentication failed:", msg);
  console.error("   Delete the .wwebjs_auth/ folder and restart to re-scan QR.");
  process.exit(1);
});

// ── Ready ─────────────────────────────────────────────────────────────────────
client.on("ready", async () => {
  console.log("🚀 DataMart WhatsApp Bot is LIVE!\n");
  console.log(`   API Base URL : ${API_BASE}`);
  console.log(`   Support Phone: ${SUPPORT_PHONE}\n`);

  // Verify API connectivity on startup
  const products = await fetchProducts();
  if (products.length) {
    console.log(`✅ API reachable — ${products.length} active products loaded.`);
  } else {
    console.warn("⚠️  Could not load products from API. Check API_BASE_URL in .env");
  }

  const workerAlive = await checkSystemStatus();
  console.log(`   Worker status: ${workerAlive ? "🟢 ONLINE" : "🔴 OFFLINE"}\n`);
});

// ── Incoming messages ─────────────────────────────────────────────────────────
client.on("message", async (msg) => {
  try {
    await handleMessage(client, msg);
  } catch (err) {
    console.error("[Client message event] Unhandled error:", err);
  }
});

// ── Disconnected — attempt to reconnect ───────────────────────────────────────
client.on("disconnected", (reason) => {
  console.warn("\n⚠️  WhatsApp disconnected:", reason);
  console.log("   Reinitialising in 5 seconds…\n");
  setTimeout(() => {
    client.initialize().catch((err) => {
      console.error("Failed to reinitialise:", err.message);
      process.exit(1);
    });
  }, 5000);
});

// ── Boot ──────────────────────────────────────────────────────────────────────
console.log("Starting DataMart WhatsApp Bot…");
console.log(`Node.js ${process.version}\n`);

client.initialize().catch((err) => {
  console.error("Failed to initialise WhatsApp client:", err.message);
  process.exit(1);
});