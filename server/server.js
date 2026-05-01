/**
 * LASIK WhatsApp Bot — Production Grade
 */

const express = require("express");
const axios   = require("axios");
const fs      = require("fs");
const path    = require("path");

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "OK", version: "v4.3-intel" });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG & ENV VALIDATION
// ─────────────────────────────────────────────────────────────────────────────
const REQUIRED_ENV = ["BOT_SECRET", "WEBHOOK_VERIFY_TOKEN", "WHATSAPP_ACCESS_TOKEN", "PHONE_NUMBER_ID"];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`[FATAL] Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const INACTIVITY_MS = 2 * 60 * 1000;                          // 2 minutes
const API_URL       = "https://relive-cure-backend-production.up.railway.app/api/ingest-lead";
const BOT_SECRET    = process.env.BOT_SECRET;
const VERIFY_TOKEN  = process.env.WEBHOOK_VERIFY_TOKEN;
const SESSION_FILE  = path.join(__dirname, "sessions.json");

// States in which knowledge responses are ALLOWED (TIMELINE, SURGERY_CITY, INSURANCE excluded — direct answer required)


// ─────────────────────────────────────────────────────────────────────────────
// Fix 1 — DEBOUNCED SESSION PERSISTENCE (concurrency-safe)
// In-memory sessions = single source of truth at runtime.
// Disk write is debounced 200ms so rapid concurrent messages don't cause races.
// ─────────────────────────────────────────────────────────────────────────────
let sessions = {};
const processedMessages = new Map();

// Periodic cleanup for deduplication map
setInterval(() => {
  const now = Date.now();
  for (const [id, timestamp] of processedMessages.entries()) {
    if (now - timestamp > 60000) processedMessages.delete(id);
  }
}, 30000);

// Hydrate from disk on startup
try {
  if (fs.existsSync(SESSION_FILE)) {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    for (const [phone, s] of Object.entries(raw)) {
      sessions[phone] = { ...s, inactivityTimer: null };
    }
    console.log(`[SESSION] Hydrated ${Object.keys(sessions).length} sessions from disk`);
  }
} catch (e) {
  console.error("[SESSION] Hydration error:", e.message);
}

let _saveTimeout = null;

/** Debounced write of the full in-memory sessions object to disk. */
function schedulePersist() {
  clearTimeout(_saveTimeout);
  _saveTimeout = setTimeout(() => {
    try {
      // Strip non-serialisable timer refs
      const toWrite = {};
      for (const [p, s] of Object.entries(sessions)) {
        toWrite[p] = {
          state:               s.state,
          data:                s.data,
          ingested:            s.ingested,
          first_ingest_done:    s.first_ingest_done,
          last_activity_at:    s.last_activity_at,
          // Memory flags
          repeat_count:        s.repeat_count || {},
          resume_offered:      s.resume_offered || false,
          last_intent_handled: s.last_intent_handled || null
        };
      }
      fs.writeFileSync(SESSION_FILE, JSON.stringify(toWrite, null, 2));
    } catch (e) {
      console.error("[SESSION] Persist error:", e.message);
    }
  }, 200);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fix 2 — STRICT NAME VALIDATION
// ─────────────────────────────────────────────────────────────────────────────
const NAME_BLACKLIST = new Set([
  "yes","ok","okay","haan","ha","no","nah","start","nahi","nope","sure",
  "chalo","bilkul","haan ji","skip","next","continue"
]);

function isValidName(str) {
  if (!str || str.trim().length < 3) return false;
  const cleaned = str.toLowerCase().trim();
  if (NAME_BLACKLIST.has(cleaned)) return false;
  if (!/^[a-zA-Z\s]+$/.test(str.trim())) return false; // only letters + spaces, no digits
  // At least one word must be 3+ characters (prevents "jas" type short fragments alone)
  const words = str.trim().split(/\s+/);
  return words.some(w => w.length >= 3);
}

// ─────────────────────────────────────────────────────────────────────────────
// Up 2 — LEAD SCORING
// ─────────────────────────────────────────────────────────────────────────────
function scoreSession(session) {
  const d = session.data;
  const fields = ["city","insurance","surgeryCity","timeline"];
  const params = fields.filter(f => d[f] && String(d[f]).trim()).length;

  let band;
  if (params === 4 && d.timeline && d.timeline.toLowerCase().includes("immediately")) {
    band = "HOT";
  } else if (params >= 3) {
    band = "WARM";
  } else {
    band = "COLD";
  }

  // Lead Intelligence Fields
  const intelligence = {
    interest_cost:      !!d.interest_cost,
    interest_recovery:  !!d.interest_recovery,
    concern_pain:       !!d.concern_pain,
    concern_safety:     !!d.concern_safety,
    urgency_level:      d.timeline?.toLowerCase().includes("immediately") ? "high" : (params >= 2 ? "medium" : "low"),
    is_returning:       !!d.is_returning
  };

  return { intent_score: params, intent_band: band, ...intelligence };
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND TO API — includes trigger, scoring, last_activity_at
// ─────────────────────────────────────────────────────────────────────────────
async function sendToAPI(phone, session, trigger = "complete") {
  const d = session.data;
  const scored = scoreSession(session);
  const payload = {
    phone_number:           phone,
    contact_name:           d.contactName || "WhatsApp Lead",
    city:                   d.city        || "",
    preferred_surgery_city: d.surgeryCity || "",
    timeline:               d.timeline    || "",
    insurance:              d.insurance   || "",

    interest_cost:          scored.interest_cost,
    interest_recovery:      scored.interest_recovery,
    concern_pain:           scored.concern_pain,
    concern_safety:         scored.concern_safety,
    concern_power:          !!d.concern_power,

    intent_level:           scored.intent_band || "COLD",
    intent_score:           scored.intent_score || 0,
    urgency_level:          scored.urgency_level || "low",
    request_call:           d.request_call || false,

    last_user_message:      d.lastMessage || "",
    ingestion_trigger:      trigger
  };

  // ── [WAKE] Quick health ping — no force-wait (chatbot is already running)
  axios.get("https://relive-cure-backend-production.up.railway.app/health").catch((e) => {
    console.log("[WAKE] Health ping failed:", e.message);
  });

  for (let i = 1; i <= 5; i++) {
    console.log("[API] Attempt:", i);
    console.log("🔥 SENDING LEAD PAYLOAD:", JSON.stringify(payload, null, 2));
    console.log("🔑 x-bot-key:", BOT_SECRET);
    
    try {
      const res = await axios.post(API_URL, payload, {
        headers: { 
          "Content-Type": "application/json", 
          "x-bot-key": BOT_SECRET
        },
        timeout: 40000,
      });
      console.log(`[API] ✅ Success attempt ${i} | id=${res.data.lead_id}`);
      session.ingested = true;
      schedulePersist();
      return; 
    } catch (err) {
      const statusCode = err.response?.status || 'NO_STATUS';
      const responseBody = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.log(`[API] ❌ Attempt ${i} FAILED | status=${statusCode} | error=${responseBody}`);
      console.log(`[API] ❌ Full error cause:`, err.cause || err.code || 'none');
      
      if (i < 5) {
        const backoff = i * 4000;
        console.log(`[API] Retrying in ${backoff}ms...`);
        await new Promise(r => setTimeout(r, backoff));
      } else {
        console.error("❌ FINAL FAILURE: Lead ingestion failed after all 5 attempts — phone:", phone);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INACTIVITY TIMER — 2-min timeout + Up1 follow-up ping at 30 min
// ─────────────────────────────────────────────────────────────────────────────
function resetInactivityTimer(phone) {
  const session = sessions[phone];
  if (!session || session.state === "COMPLETE") return;

  if (session.inactivityTimer) {
    clearTimeout(session.inactivityTimer);
    session.inactivityTimer = null;
  }

  session.inactivityTimer = setTimeout(async () => {
    const s = sessions[phone];
    if (!s) return;
    s.inactivityTimer = null;
    console.log(`[CHATBOT] ⏱ Timer fired — ingesting partial lead | phone=${phone}`);
    await sendToAPI(phone, s, "timeout");

    // Up 1 — Follow-up ping (placeholder for real WhatsApp API)
    setTimeout(() => {
      console.log(`[CHATBOT] 📲 Follow-up ping due | phone=${phone} | band=${scoreSession(s).intent_band}`);
      // TODO: integrate WhatsApp Business API here
      // send("Hi 👋 just checking — would you like help with LASIK consultation?")
    }, 30 * 60 * 1000);

  }, INACTIVITY_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// INTENT DETECTION — expanded Hinglish/Hindi, priority-ordered
// Priority: RECOVERY → PAIN → ELIGIBILITY → REFERRAL → COST → YES
// No bare "kitna"/"kitne" to avoid cost collisions
// ─────────────────────────────────────────────────────────────────────────────
const INTENTS = {
  RECOVERY: [
    "recovery", "recover", "healing",
    "kitne din", "kitna time", "kab tak",
    "how much time", "how long", "time will it take",
    "will it take", "recover time", "recovery time",
    "kitna time lagega", "time lagega", "kitna din lagega",
    "how fast recover", "kitna jaldi recover"
  ],
  PAIN: [
    "pain","painful","dard","dard hoga","takleef","hurt",
    "pain hota","kya pain","kya dard","dard hoga kya",
    "pain hoga kya","painful hai kya","dard nahi hoga"
  ],
  ELIGIBILITY: [
    "eligible","eligibility","suitable","possible",
    "kar sakta","kar sakti","ho sakta","can i do",
    "karwa sakta","karwa sakti","karwa sakta hu kya",
    "mere liye possible","suitable hu kya","ho sakta kya",
    "kya main","kya ho sakta"
  ],
  REFERRAL: [
    "refer","referral","reward","earn","paisa",
    "kya milega","kitna milega","refer friend","refer kaise","money"
  ],
  COST: [
    "cost","price","charges","fees","kharcha","rate","expense",
    "amount","lasik cost","laser cost","eye surgery cost",
    "total cost","kitna padega","kitne ka padega",
    "kitna hai","kitne ka","kitne ki","price kya","surgery ka price"
  ],
  YES: [
    "yes","haan","ha","haan ji","ok","okay","sure","chalo","start","bilkul"
  ],
  TIMELINE: [
    "when", "how soon", "timeline", "schedule", "availability",
    "kab", "kitne din", "kitna time", "kab tak", "jaldi",
    "when can i", "how fast", "next week", "this week",
    "earliest", "soon", "immediately", "kitna jaldi"
  ],
  SAFETY: [
    "scared", "fear", "safe", "risk", "side effects", 
    "nervous", "afraid", "dar lag raha", "danger", "dangerous"
  ]
};

const STRONG_SALES = [ "call me","call back","doctor","specialist", "appointment","consultation","baat karni", "talk to doctor","callback" ];
const WEAK_SALES = [ "help","details","info","interested","guide" ];

function isStrongSalesIntent(m) {
  return STRONG_SALES.some(w => m.toLowerCase().includes(w));
}

function isWeakSalesIntent(m) {
  return WEAK_SALES.some(w => m.toLowerCase().includes(w));
}

function detectAllIntents(message) {
  const m = message.toLowerCase();
  return Object.entries(INTENTS)
    .filter(([, words]) => words.some(w => m.includes(w)))
    .map(([intent]) => intent);
}

function detectIntent(message) {
  return detectAllIntents(message)[0] || null;
}

async function checkExistingLead(phone) {
  try {
    const url = "https://relive-cure-backend-production.up.railway.app/api/check-lead/" + phone;
    const res = await axios.get(url, {
      headers: { "x-bot-key": BOT_SECRET },
      timeout: 10000
    });
    return res.data.exists ? res.data.lead : null;
  } catch (e) {
    console.error(`[CHATBOT] Check-lead failed | phone=${phone} | error=${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE BASE — WhatsApp bullet format
// ─────────────────────────────────────────────────────────────────────────────
const KB = {
  COST: `💰 *LASIK Cost Ranges:*

• Basic LASIK → ₹20,000
• Advanced LASIK → ₹45,000
• Premium / SMILE → ₹90,000

Cost depends on technology used.
Want me to help find the right option for you? 👇`,

  RECOVERY: `⚡ *LASIK Recovery is Fast:*

• Clear vision in 3–12 hours
• Normal routine next day
• Full recovery in 1–2 weeks

Want to check if you're eligible? 👇`,

  PAIN: `✅ *LASIK is Almost Painless:*

• Mild pressure for a few seconds
• No real pain during surgery
• Eye drops for comfort post-op

Want me to check your eligibility? 👇`,

  ELIGIBILITY: `🔍 *LASIK Eligibility Depends On:*

• Eye power (stable for 1+ year)
• Age (18+ years)
• Eye health & corneal thickness

I can check if you're suitable in 2 mins. Shall I? 👇`,

  REFERRAL: `🎁 *LASIK Referral Program:*

• Refer a friend → get *₹1,000*
• Works for any completed surgery
• No limit on referrals

Our specialist will contact you shortly.`,

  SAFETY: `😊 Totally understandable to feel this way

LASIK is one of the safest procedures:

• No major pain
• 10–15 min surgery
• High success rate

Doctors evaluate your eyes before surgery.

Would you like me to check your eligibility?`,

  TIMELINE: `📅 *LASIK Timeline:*

• Surgery time → 10–15 mins for both eyes
• Recovery → 4–12 hours
• Resuming work → After 1–2 days

We have slots available this week. Want me to check availability for you? 👇`,
};

function buildKnowledgeResponse(message, session) {
  let intents = detectAllIntents(message).filter(i => i !== "YES");
  
  // Strict Power Detection (Fix 9)
  const powerRegex = /(?:power|number)?\s*[-+]\d{1,2}(\.\d+)?\b/i;
  if (powerRegex.test(message) && !intents.includes("ELIGIBILITY")) {
    intents.push("ELIGIBILITY");
    session.data.concern_power = true;
  }

  if (intents.length === 0) return null;
  
  // INTENT PRIORITY SYSTEM (Fix 2)
  const PRIORITY_ORDER = [ "COST", "ELIGIBILITY", "RECOVERY", "PAIN", "SAFETY", "TIMELINE", "REFERRAL" ];
  const topIntent = PRIORITY_ORDER.find(p => intents.includes(p));
  const secondaryIntent = PRIORITY_ORDER.find(p => intents.includes(p) && p !== topIntent);

  if (session.last_intent_handled === topIntent) {
    const followUps = [
      "Want me to help you check if you're eligible?",
      "I can guide you based on your case 👍",
      "Would you like to take the next step?",
      "Should I connect you with a LASIK specialist?"
    ];

    const nextStep = getNextQuestion(session, "resume");

    return (
      (KB[topIntent] || "") +
      "\n\n" +
      followUps[Math.floor(Math.random() * followUps.length)] +
      "\n\n─────────────\n\n" +
      nextStep.text
    );
  }
  
  session.last_intent_handled = topIntent;
  let baseReply;
  if (secondaryIntent) {
    const r1 = KB[topIntent] || "";
    const r2 = KB[secondaryIntent] || "";
    baseReply = `${r1}\n\n─────────────\n\n${r2}`;
  } else {
    baseReply = KB[topIntent] || "";
  }

  if (!baseReply) return null;

  // Set Intelligence Flags
  if (intents.includes("COST"))     session.data.interest_cost = true;
  if (intents.includes("RECOVERY")) session.data.interest_recovery = true;
  if (intents.includes("PAIN"))     session.data.concern_pain = true;
  if (intents.includes("SAFETY"))   session.data.concern_safety = true;

  // ALWAYS CONTINUE FLOW AFTER KB (Fix 10)
  const nextStep = getNextQuestion(session, "resume");
  return baseReply + "\n\n" + nextStep.text;
}

const QUESTION_VARIATIONS = {
  NAME: [
    "May I know your name?",
    "What should I call you?",
    "Quick thing—your name?",
    "Before we continue, your name?"
  ],
  CITY: [
    "Which city are you based in? 📍",
    "Where do you stay? (City name)",
    "Can you tell me your city?"
  ],
  SURGERY_CITY: [
    "Which city would you prefer for surgery? (You can choose any city)",
    "Where would you like to get the surgery done?",
    "Preferred city for the procedure?"
  ],
  INSURANCE: [
    "Do you have medical insurance?",
    "Got any health insurance that covers eye surgery?",
    "Are you covered by insurance?"
  ],
  TIMELINE: [
    "When are you planning the surgery?",
    "How soon are you looking to get this done?",
    "Any specific month or week in mind for LASIK?"
  ]
};

/** Helper for flow resumption */
function getNextQuestion(session, context = "normal") {
  const d = session.data;
  const firstName = d.contactName && d.contactName !== "WhatsApp Lead" ? d.contactName.split(" ")[0] : "";
  
  let field = null;
  let variations = [];

  if (!d.contactName) {
    field = "NAME";
    variations = QUESTION_VARIATIONS.NAME;
  } else if (!d.city) {
    field = "CITY";
    variations = QUESTION_VARIATIONS.CITY;
  } else if (!d.surgeryCity) {
    field = "SURGERY_CITY";
    variations = QUESTION_VARIATIONS.SURGERY_CITY;
  } else if (!d.insurance) {
    field = "INSURANCE";
    variations = QUESTION_VARIATIONS.INSURANCE;
  } else if (!d.timeline) {
    field = "TIMELINE";
    variations = QUESTION_VARIATIONS.TIMELINE;
  }

  if (!field) return { text: "", field: null };

  let text = variations[Math.floor(Math.random() * variations.length)];
  
  if (context === "resume") {
    const resumePhrases = [
      "By the way, can I get your [FIELD] so I can help better?",
      "Just to continue—your [FIELD]?",
      "Moving forward, could you tell me your [FIELD]?"
    ];
    const phrase = resumePhrases[Math.floor(Math.random() * resumePhrases.length)];
    const fieldFriendly = field.toLowerCase().replace("_", " ");
    text = phrase.replace("[FIELD]", fieldFriendly);
  } else {
    const prefix = firstName ? `Got it, ${firstName} 👍\n\n` : "";
    text = prefix + text;
  }

  return { text, field };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHATBOT WEBHOOK
// ─────────────────────────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[WEBHOOK] ✅ Verification successful");
    return res.status(200).send(challenge);
  }
  
  console.warn("[WEBHOOK] ❌ Verification failed");
  return res.sendStatus(403);
});

async function sendWhatsAppReply(phone, reply) {
  const url = `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: phone,
    type: "text",
    text: { body: reply }
  };

  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    attempt++;
    try {
      console.log(`[WA SEND] Sending reply to: ${phone} (Attempt ${attempt})`);
      await axios.post(url, payload, {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        },
        timeout: 10000
      });
      console.log("[WA SEND] ✅ Success");
      return; // STOP immediately on success
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = !status || status === 429 || status >= 500;
      
      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = attempt * 1000;
        console.warn(`[WA RETRY] Attempt ${attempt} failed (status: ${status || 'network'}). Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      
      console.error("[WA SEND FAIL]", {
        phone,
        status: status,
        error: err.response?.data || err.message,
        attempt
      });
      break;
    }
  }
}

app.post("/chat", async (req, res) => {
  try {
    const reply = await handleIncomingMessage(req.body, true);
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function handleIncomingMessage(reqBody, isTestChat = false) {
  let phone, message, msgId;
  let reply = null;
  let replied = false;
  let finalized = false;

  const setReply = (text) => {
    if (replied) return;
    reply = text;
    replied = true;
  };

  const finalize = async (skipWA = false) => {
    if (finalized) return reply;
    finalized = true;

    if (!reply) {
      reply = `I didn't fully get that, but I can help with:\n\n• LASIK cost  \n• Recovery time  \n• Eligibility  \n\nOr I can arrange a specialist call for you.`;
    }

    console.log('[REPLY_FINAL]', reply);
    if (!skipWA) {
      try {
        await sendWhatsAppReply(phone, reply);
      } catch (e) {
        console.error("WA_SEND_FAILED", e.message);
      }
    }
    return reply;
  };

  try {
    // 1. EXTRACT DATA
    if (reqBody && reqBody.entry) {
      const messageObj = reqBody.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!messageObj) return;
      phone = messageObj.from;
      message = messageObj.text?.body || "";
      msgId = messageObj.id;
    } else {
      phone = reqBody.phone;
      message = reqBody.message || "";
      msgId = null;
    }

    if (!phone || !message) return;
    message = message.trim();
    const msgLow = message.toLowerCase();

    // 2. LOG START
    console.log(`[EXECUTION_START] phone=${phone} msgId=${msgId || 'none'}`);

    // 3. DEDUPLICATION
    const dedupKey = msgId || (phone + "_" + Buffer.from(message).toString('base64').substring(0, 10) + "_" + Math.floor(Date.now() / 1000));
    if (processedMessages.has(dedupKey)) {
      console.log(`[DEDUP] Skipping duplicate message: ${dedupKey}`);
      return;
    }
    processedMessages.set(dedupKey, Date.now());

    // 4. LOAD SESSION
    if (!sessions[phone]) {
      const existing = await checkExistingLead(phone);
      sessions[phone] = {
        state: existing ? "RETURNING" : "GREETING",
        data: existing ? { contactName: existing.contact_name, is_returning: true } : {},
        inactivityTimer: null,
        ingested: !!existing,
        // Memory flags
        repeat_count: {},
        last_question_asked: null,
        resume_offered: false,
        last_intent_handled: null
      };
      if (!existing) {
        // Initial ingest removed (Fix 6)
      }
    }

    const session = sessions[phone];
    console.log(`[STATE_BEFORE] phone=${phone} state=${session.state}`);

    session.last_activity_at = new Date().toISOString();
    session.data.lastMessage = msgLow;
    resetInactivityTimer(phone);

    // 5. RESTART CHECK (Requirement 4: ASK_RESUME Fix)
    const restartWords = ["hi","hello","hey","start","hii","helo"];
    if (restartWords.some(w => msgLow === w)) {
      const hasCollectedSomething = session.data.contactName && session.data.contactName !== "WhatsApp Lead";
      if (hasCollectedSomething && !session.resume_offered) {
        console.log('[RESUME_TRIGGERED]');
        session.state = "ASK_RESUME";
        session.resume_offered = true;
        setReply("Welcome back! 👋 I see we were in the middle of our conversation. Would you like to continue from where we left off? (Yes/No)");
        return finalize(isTestChat);
      } else if (!hasCollectedSomething) {
        session.state = "GREETING";
        session.ingested = false;
        session.resume_offered = false;
        session.repeat_count = {};
        // Fall through to process GREETING
      }
    }

    // 6. LOGIC PRIORITY

    // 6. LOGIC PRIORITY (Fix 3: Knowledge > Strong Sales > Power)

    // A. KNOWLEDGE INTENT
    const knowledge = buildKnowledgeResponse(message, session);
    if (knowledge) {
      console.log('[LOGIC_PATH] knowledge');
      setReply(knowledge);
      console.log(`[STATE_AFTER] phone=${phone} state=${session.state}`);
      return finalizeWithIngest(phone, session, "knowledge", finalize, isTestChat);
    }

    // B. STRONG SALES INTENT (Fix 4)
    if (isStrongSalesIntent(msgLow)) {
      session.data.request_call = true;
      console.log('[LOGIC_PATH] strong_sales');
      setReply(`👍 Our LASIK specialist will call you shortly.`);
      console.log(`[STATE_AFTER] phone=${phone} state=${session.state}`);
      return finalizeWithIngest(phone, session, "sales_intent", finalize, isTestChat);
    }

    // C. POWER DETECTION (Fix 9)
    const powerRegex = /(?:power|number)?\s*[-+]\d{1,2}(\.\d+)?\b/i;
    if (powerRegex.test(message)) {
      session.data.concern_power = true;
      console.log('[LOGIC_PATH] power');
      const name = session.data.contactName ? session.data.contactName.split(" ")[0] : "";
      const personalPrefix = name ? `Got it, ${name} 👍\n\n` : "Got it 👍\n\n";
      setReply(`${personalPrefix}Based on your eye power, you could be a good candidate for LASIK.\n\nWould you like me to check your eligibility quickly?`);
      console.log(`[STATE_AFTER] phone=${phone} state=${session.state}`);
      return finalizeWithIngest(phone, session, "power_detected", finalize, isTestChat);
    }

    // D. STATE MACHINE (Requirement 1 & 3: Loops & Repeated Prompts)
    const state = session.state;
    console.log(`[STATE_DECISION] state=${state}`);

    // Increment repeat count
    session.repeat_count[state] = (session.repeat_count[state] || 0) + 1;
    if (session.repeat_count[state] > 2) {
      console.log(`[REPEAT_DETECTED] state=${state}`);
    }

    if (state === "GREETING") {
      setReply("Hi! 👋 I'm your Relive Cure LASIK assistant.\n\nI can help you check your eligibility for LASIK and answer any questions about cost or recovery.\n\nShall we start? (Yes/No)");
      session.state = "ASK_PERMISSION";
    }
    else if (state === "ASK_RESUME") {
      const isYes = msgLow.includes("yes") || msgLow.includes("haan") || msgLow.includes("ha") || msgLow.includes("ok");
      if (isYes) {
        const next = getNextQuestion(session);
        setReply(`Awesome! Let's pick up where we left off.\n\n${next.text}`);
        session.state = next.field;
      } else {
        session.state = "GREETING";
        session.data = {}; 
        session.repeat_count = {};
        session.resume_offered = false;
        setReply("No problem! Let's start fresh.\n\nHi! 👋 I'm your Relive Cure LASIK assistant. Shall we start checking your eligibility? (Yes/No)");
        session.state = "ASK_PERMISSION";
      }
    }
    else if (state === "RETURNING") {
      // Fix 5: Remove duplicate API call
      if (session.data.is_returning) {
        const next = getNextQuestion(session);
        if (!next.field) {
          session.state = "COMPLETE";
          const firstName = session.data.contactName ? session.data.contactName.split(" ")[0] : "there";
          setReply(`Welcome back, ${firstName}! 👋 Your details are already saved ✅\n\nWhat would you like to do?\n\n1. Talk to a specialist\n2. Ask a question`);
        } else {
          setReply(`Welcome back! Let's complete your profile.\n\n${next.text}`);
          session.state = next.field;
        }
      }
    }
    else if (state === "ASK_PERMISSION") {
      const isYes = msgLow.includes("yes") || msgLow.includes("haan") || msgLow.includes("ha") || msgLow.includes("ok") || msgLow.includes("sure");
      if (isYes) {
        const next = getNextQuestion(session);
        setReply(next.text);
        session.state = next.field;
      } else {
        setReply("No worries! If you change your mind, just say 'Hi'. Have a great day!");
        session.state = "COMPLETE";
      }
    }
    else if (state === "NAME") {
      // Requirement 2: Repeat Protection for Name
      if (session.repeat_count["NAME"] > 2 && message.length < 2) {
        session.data.contactName = "WhatsApp Lead";
        const next = getNextQuestion(session);
        setReply(`No problem, let's skip that for now.\n\n${next.text}`);
        session.state = next.field;
      } else if (message.length < 2) {
        setReply("Could you please tell me your name?");
      } else {
        session.data.contactName = message;
        const next = getNextQuestion(session);
        setReply(next.text);
        session.state = next.field;
      }
    }
    else if (state === "CITY") {
      session.data.city = message;
      const next = getNextQuestion(session);
      setReply(next.text);
      session.state = next.field;
    }
    else if (state === "SURGERY_CITY") {
      session.data.surgeryCity = message;
      const next = getNextQuestion(session);
      setReply(next.text);
      session.state = next.field;
    }
    else if (state === "INSURANCE") {
      session.data.insurance = message;
      const next = getNextQuestion(session);
      setReply(next.text);
      session.state = next.field;
    }
    else if (state === "TIMELINE") {
      session.data.timeline = message;
      session.state = "COMPLETE";
      const name = session.data.contactName ? session.data.contactName.split(" ")[0] : "";
      setReply(`${name ? `Perfect, ${name}! 🎉` : "Perfect! 🎉"}\n\nOur LASIK specialist will contact you shortly.\n\nMeanwhile, I can help you with:\n• Cost\n• Recovery\n• Eligibility`);
    }
    else if (state === "COMPLETE") {
      const knowledgeAgain = buildKnowledgeResponse(msgLow, session);
      if (knowledgeAgain) {
        setReply(knowledgeAgain);
      } else {
        setReply("Your request is already with our team! Is there anything else you'd like to know about LASIK recovery or costs?");
      }
    }

    // E. FALLBACK (if still no reply)
    if (!reply) {
      console.log('[LOGIC_PATH] fallback');
    }

    console.log(`[STATE_AFTER] phone=${phone} state=${session.state}`);
    return finalizeWithIngest(phone, session, "update", finalize, isTestChat);

  } catch (err) {
    console.error("Processing error:", err);
    setReply(`Something went wrong. Please try again.`);
    finalize();
  } finally {
    schedulePersist();
  }
}

/** Helper to wrap finalize with non-blocking ingest */
function finalizeWithIngest(phone, session, trigger, finalizeFn, isTestChat = false) {
  setImmediate(async () => {
    try {
      console.log('[ASYNC_INGEST] start');
      await sendToAPI(phone, session, trigger);
      console.log('[ASYNC_INGEST] success');
    } catch (e) {
      console.error('[ASYNC_INGEST_ERROR]', e);
    }
  });
  return finalizeFn(isTestChat);
}

app.post("/webhook", async (req, res) => {
  console.log("📩 Incoming webhook received");
  res.sendStatus(200);

  try {
    await handleIncomingMessage(req.body);
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[SERVER] WhatsApp Bot is running on port ${PORT}`);
  console.log("🚀 BOT VERSION: v4.3-intel");
  console.log(`[CHATBOT] API_URL: ${API_URL}`);
  console.log(`[SESSION] File: ${SESSION_FILE}`);

  // ─────────────────────────────────────────────────────────────────────────────
  // HEARTBEAT (Self-ping to prevent sleep)
  // ─────────────────────────────────────────────────────────────────────────────
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    const selfPingUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health`;
    console.log(`[HEARTBEAT] Enabled for ${selfPingUrl}`);
    setInterval(async () => {
      try {
        await axios.get(selfPingUrl);
        console.log("[HEARTBEAT] ✅ Ping success");
      } catch (err) {
        console.warn("[HEARTBEAT] ❌ Ping failed:", err.message);
      }
    }, 4 * 60 * 1000); // Every 4 mins
  } else {
    console.log("[HEARTBEAT] ℹ️ Skipped (RAILWAY_PUBLIC_DOMAIN not set)");
  }
});
