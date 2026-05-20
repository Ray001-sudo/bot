require("dotenv").config();

const express = require("express");
const { Client, LocalAuth, List, Buttons } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const axios = require("axios");

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = (process.env.API_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const SUPPORT_PHONE = process.env.SUPPORT_PHONE || "+254700000000";
const COUNTRY_CODE = process.env.ALLOWED_COUNTRY_CODE || "254";

// Session path – use environment variable if provided (Render Disk), otherwise default
const SESSION_DATA_PATH = process.env.SESSION_DATA_PATH || "./.wwebjs_auth";

// ─────────────────────────────────────────────────────────────────────────────
// Keep‑alive HTTP server (prevents Render from sleeping)
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("DataMart WhatsApp bot is alive"));
app.get("/health", (req, res) => res.status(200).send("OK"));

const server = app.listen(PORT, () => {
  console.log(`✅ Keep‑alive HTTP server listening on port ${PORT}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// In-memory session store
// Tracks each user's conversation state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * session shape:
 * {
 *   step: "idle" | "awaiting_phone" | "awaiting_pin" | "polling",
 *   selectedProductId: number | null,
 *   selectedProductName: string | null,
 *   selectedProductPrice: number | null,
 *   transactionId: number | null,
 *   pollCount: number,
 * }
 */
const sessions = new Map();

function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, {
      step: "idle",
      selectedProductId: null,
      selectedProductName: null,
      selectedProductPrice: null,
      transactionId: null,
      pollCount: 0,
    });
  }
  return sessions.get(from);
}

function resetSession(from) {
  sessions.set(from, {
    step: "idle",
    selectedProductId: null,
    selectedProductName: null,
    selectedProductPrice: null,
    transactionId: null,
    pollCount: 0,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// API helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchProducts() {
  const { data } = await axios.get(`${API_BASE}/api/products`);
  return data.success ? data.data : [];
}

async function initiateSTK(phone, productId) {
  const { data } = await axios.post(`${API_BASE}/api/mpesa/stk`, {
    phone,
    product_id: productId,
  });
  return data;
}

async function pollTransactionStatus(transactionId) {
  const { data } = await axios.get(
    `${API_BASE}/api/user/transaction-status?id=${transactionId}`
  );
  return data.success ? data.data : null;
}

async function checkSystemStatus() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/system/status`);
    if (!data.success || !data.data?.worker_last_heartbeat) return false;
    const age = Date.now() - new Date(data.data.worker_last_heartbeat).getTime();
    return age < 2 * 60 * 1000;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Message builders
// ─────────────────────────────────────────────────────────────────────────────

function normalisePhone(raw) {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0") && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.startsWith("254") && digits.length === 12) return digits;
  if (digits.startsWith("7") && digits.length === 9) return `254${digits}`;
  return null;
}

/**
 * Build a whatsapp-web.js List message with all active products.
 * Grouped by category, max 10 rows per section.
 */
async function buildProductListMessage() {
  const products = await fetchProducts();
  if (!products.length) return null;

  // Group by category
  const grouped = {};
  for (const p of products) {
    const cat = p.category || "OTHER";
    if (!grouped[cat]) grouped[cat] = [];
    if (grouped[cat].length < 10) {
      grouped[cat].push({
        id: `buy_${p.id}`,
        title: p.name.substring(0, 24),
        description: `Ksh ${p.selling_price}${p.description ? " — " + p.description.substring(0, 60) : ""}`,
      });
    }
  }

  const sections = Object.entries(grouped).map(([title, rows]) => ({ title, rows }));

  return new List(
    "Select a package below to purchase via M-Pesa STK Push.",
    "📦 View Packages",
    sections,
    "Available Packages",
    "Reply *help* anytime for assistance"
  );
}

/**
 * Build a 2-button confirmation message before initiating payment.
 */
function buildConfirmButtons(productName, price, phone) {
  return new Buttons(
    `Confirm your purchase:\n\n*${productName}*\nPrice: *Ksh ${price}*\nFor number: *${phone}*\n\nM-Pesa STK Push will be sent to ${phone}.`,
    [{ id: "confirm_yes", body: "✅ Confirm & Pay" }, { id: "confirm_no", body: "❌ Cancel" }],
    "Confirm Purchase",
    "Powered by DataMart"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling loop — checks tx status every 5 seconds, times out after 2 minutes
// ─────────────────────────────────────────────────────────────────────────────

async function startPolling(client, from, transactionId) {
  const session = getSession(from);
  session.step = "polling";
  session.pollCount = 0;

  const interval = setInterval(async () => {
    session.pollCount++;

    if (session.pollCount > 24) {
      clearInterval(interval);
      resetSession(from);
      await client.sendMessage(
        from,
        "⏳ Payment timed out. No charge was made. Reply *menu* to try again or contact support:\n" + SUPPORT_PHONE
      );
      return;
    }

    try {
      const tx = await pollTransactionStatus(transactionId);
      if (!tx) return;

      if (tx.status === "SUCCESS") {
        clearInterval(interval);
        resetSession(from);
        await client.sendMessage(
          from,
          `🎉 *Bundle Activated!*\n\nYour *${session.selectedProductName}* has been successfully activated. Enjoy! 🚀\n\nReply *menu* to buy more.`
        );
      } else if (tx.status === "PAID" || tx.status === "FULFILLING") {
        // Payment received, activation in progress — only notify once
        if (session.pollCount === 1) {
          await client.sendMessage(
            from,
            `💳 *Payment received!* Activating your *${session.selectedProductName}* now… Please wait.`
          );
        }
      } else if (tx.status === "FAILED") {
        clearInterval(interval);
        resetSession(from);
        await client.sendMessage(
          from,
          `❌ *Transaction Failed*\n\n${tx.failure_reason || "Payment was not completed."}\n\nNo money was deducted. Reply *menu* to try again or call ${SUPPORT_PHONE}.`
        );
      }
    } catch (err) {
      console.error("[Poll] Error:", err.message);
    }
  }, 5000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main message handler
// ─────────────────────────────────────────────────────────────────────────────

async function handleMessage(client, msg) {
  const from = msg.from;
  const body = (msg.body || "").trim();
  const lower = body.toLowerCase();
  const session = getSession(from);

  // Only respond to individual chats, not groups
  const chat = await msg.getChat();
  if (chat.isGroup) return;

  // ── Handle List reply (product selection) ──────────────────────────────────
  if (msg.type === "list_response") {
    const selectedId = msg.selectedRowId || "";
    if (selectedId.startsWith("buy_")) {
      const productId = parseInt(selectedId.replace("buy_", ""), 10);
      const products = await fetchProducts();
      const product = products.find((p) => p.id === productId);

      if (!product) {
        await client.sendMessage(from, "Sorry, that package is no longer available. Reply *menu* to see current packages.");
        return;
      }

      session.selectedProductId = product.id;
      session.selectedProductName = product.name;
      session.selectedProductPrice = product.selling_price;
      session.step = "awaiting_phone";

      await client.sendMessage(
        from,
        `Great choice! 📦 *${product.name}* — Ksh ${product.selling_price}\n\nPlease send the *phone number* to receive this bundle:\n_(e.g. 0712345678 or 254712345678)_`
      );
      return;
    }
  }

  // ── Handle Button reply (confirm / cancel) ─────────────────────────────────
  if (msg.type === "buttons_response") {
    const btnId = msg.selectedButtonId || "";

    if (btnId === "confirm_no") {
      resetSession(from);
      await client.sendMessage(from, "Purchase cancelled. Reply *menu* to start again.");
      return;
    }

    if (btnId === "confirm_yes" && session.step === "awaiting_pin") {
      await processPurchase(client, from, session);
      return;
    }
  }

  // ── Text commands ──────────────────────────────────────────────────────────

  if (lower === "menu" || lower === "hi" || lower === "hello" ||
      lower === "start" || lower === "packages" || lower === "buy" ||
      lower === "sema" || lower === "niaje") {
    resetSession(from);
    const workerAlive = await checkSystemStatus();

    const listMsg = await buildProductListMessage();
    if (!listMsg) {
      await client.sendMessage(from, "No packages available at the moment. Please try again later or call " + SUPPORT_PHONE);
      return;
    }

    if (!workerAlive) {
      await client.sendMessage(
        from,
        "⚠️ *Notice:* Our activation system is in manual mode. Purchases still work but activation may take a few extra minutes."
      );
    }

    await client.sendMessage(from, listMsg);
    return;
  }

  if (lower === "status") {
    await handleStatusCheck(client, from);
    return;
  }

  if (lower === "help" || lower === "msaada") {
    await client.sendMessage(
      from,
      `*DataMart Support* 🛎️\n\nCommands:\n• *menu* — Browse packages\n• *status* — Your recent orders\n• *help* — This message\n\nCall/WhatsApp support: ${SUPPORT_PHONE}\n\nPowered by DataMart`
    );
    return;
  }

  if (lower === "cancel") {
    resetSession(from);
    await client.sendMessage(from, "Session cleared. Reply *menu* to start fresh.");
    return;
  }

  // ── Step: awaiting phone number ────────────────────────────────────────────

  if (session.step === "awaiting_phone") {
    const normPhone = normalisePhone(body);

    if (!normPhone) {
      await client.sendMessage(
        from,
        `❌ Invalid phone number: *${body}*\n\nPlease use format:\n• 0712345678\n• 254712345678`
      );
      return;
    }

    session.step = "awaiting_pin";

    // Show confirmation buttons
    const confirmMsg = buildConfirmButtons(
      session.selectedProductName,
      session.selectedProductPrice,
      normPhone
    );

    // Store the normalised phone temporarily on the session
    session.targetPhone = normPhone;
    await client.sendMessage(from, confirmMsg);
    return;
  }

  // ── Polling — ignore messages while waiting for payment ───────────────────

  if (session.step === "polling") {
    await client.sendMessage(
      from,
      "⏳ Waiting for your M-Pesa payment. Please enter your PIN on the prompt.\n\nReply *cancel* to abort."
    );
    return;
  }

  // ── Fallback ───────────────────────────────────────────────────────────────

  await client.sendMessage(
    from,
    `👋 Welcome to *DataMart*!\n\nReply *menu* to see available data, airtime and SMS packages.\nReply *help* for support.\n\nFor urgent help: ${SUPPORT_PHONE}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Process purchase — called after user confirms
// ─────────────────────────────────────────────────────────────────────────────

async function processPurchase(client, from, session) {
  await client.sendMessage(
    from,
    `💳 Sending M-Pesa prompt to *${session.targetPhone}*…\n\nPlease check your phone and enter your PIN.`
  );

  try {
    const result = await initiateSTK(session.targetPhone, session.selectedProductId);

    if (!result.success) {
      const errMsg = result.code === "RATE_LIMITED"
        ? `⏳ Please wait ${result.retryAfterSeconds}s before making another request.`
        : `❌ ${result.error || "Could not initiate payment. Please try again."}`;
      resetSession(from);
      await client.sendMessage(from, errMsg);
      return;
    }

    session.transactionId = result.data.transaction_id;

    await client.sendMessage(
      from,
      `📱 *M-Pesa prompt sent!*\n\nEnter your PIN on your phone to complete payment for *${session.selectedProductName}* — Ksh ${session.selectedProductPrice}.\n\n_Prompt expires in 60 seconds._`
    );

    if (result.data.system_busy) {
      await client.sendMessage(
        from,
        "⚠️ *Note:* Activation is in manual mode — slight delays expected after payment."
      );
    }

    // Start polling for payment confirmation
    await startPolling(client, from, session.transactionId);

  } catch (err) {
    console.error("[STK] Error:", err.message);
    resetSession(from);
    await client.sendMessage(
      from,
      `❌ Payment initiation failed. Please try again or call ${SUPPORT_PHONE}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status check
// ─────────────────────────────────────────────────────────────────────────────

async function handleStatusCheck(client, from) {
  // We don't have user history without the Meta API user lookup,
  // so we check by the sender's own number
  const senderNumber = from.replace("@c.us", "");
  const normPhone = normalisePhone(senderNumber);

  if (!normPhone) {
    await client.sendMessage(from, "Could not determine your phone number. Call support: " + SUPPORT_PHONE);
    return;
  }

  try {
    const { data } = await axios.get(`${API_BASE}/api/user/orders?phone=${normPhone}`);
    if (!data.success || !data.data?.length) {
      await client.sendMessage(from, "You have no recent transactions.\n\nReply *menu* to buy packages.");
      return;
    }

    const statusEmoji = { SUCCESS: "✅", FAILED: "❌", PENDING: "⏳", PAID: "💳", FULFILLING: "⚙️" };
    const lines = data.data.map((tx) => {
      const emoji = statusEmoji[tx.status] || "•";
      const date = new Date(tx.created_at).toLocaleDateString("en-KE");
      return `${emoji} ${tx.product_name} — Ksh ${tx.amount} (${tx.status}) — ${date}`;
    });

    await client.sendMessage(
      from,
      `📊 *Your Recent Orders:*\n\n${lines.join("\n")}\n\nReply *menu* to buy more.`
    );
  } catch {
    await client.sendMessage(from, "Could not fetch your orders. Try again later.");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp client setup
// ─────────────────────────────────────────────────────────────────────────────

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: SESSION_DATA_PATH,
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

// Print QR code in terminal on first run
client.on("qr", (qr) => {
  console.log("\n📱 SCAN THIS QR WITH WHATSAPP (Linked Devices):\n");
  qrcode.generate(qr, { small: true });
  console.log("\n👉 Go to Render Logs tab to see the QR code above.");
  console.log("👉 Open WhatsApp → Settings → Linked Devices → Link a Device\n");
});

client.on("authenticated", () => {
  console.log("✅ WhatsApp authenticated — session saved.");
});

client.on("auth_failure", (msg) => {
  console.error("❌ Authentication failed:", msg);
  console.log("Delete the .wwebjs_auth folder and restart to re-scan QR.");
});

client.on("ready", async () => {
  console.log("🚀 DataMart WhatsApp Bot is ready!");
  console.log(`📡 API Base: ${API_BASE}`);
  console.log(`💾 Session path: ${SESSION_DATA_PATH}`);

  // Verify API is reachable
  try {
    const products = await fetchProducts();
    console.log(`✅ Connected to API — ${products.length} active products loaded.`);
  } catch (err) {
    console.error("⚠️  Could not reach API:", err.message);
  }
});

client.on("message", async (msg) => {
  try {
    await handleMessage(client, msg);
  } catch (err) {
    console.error("[Message handler error]", err.message);
  }
});

client.on("disconnected", (reason) => {
  console.warn("⚠️  WhatsApp disconnected:", reason);
  console.log("Attempting to reinitialise…");
  client.initialize();
});

// Graceful shutdown on SIGTERM (Render sends this when stopping the service)
process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing gracefully...");
  server.close(() => {
    console.log("HTTP server closed.");
    client.destroy().then(() => {
      console.log("WhatsApp client destroyed.");
      process.exit(0);
    }).catch((err) => {
      console.error("Error destroying client:", err);
      process.exit(1);
    });
  });
});

// Boot
console.log("Starting DataMart WhatsApp Bot…");
client.initialize();