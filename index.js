// index.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import twilio from "twilio";
import OpenAI from "openai";
import { buildSystemPrompt, tools, getBusinessProfile } from "./agentConfig.js";

dotenv.config();

// --- ENV ---
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BOOK8_BASE_URL = process.env.BOOK8_BASE_URL || "https://book8-ai.vercel.app";
const BOOK8_AGENT_API_KEY = process.env.BOOK8_AGENT_API_KEY; // will use later

if (!OPENAI_API_KEY) {
  console.warn("WARNING: OPENAI_API_KEY is not set. The agent will not work.");
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- EXPRESS SETUP ---
const app = express();
app.use(cors());

// Twilio posts as x-www-form-urlencoded by default:
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const { twiml: Twiml } = twilio;
const VoiceResponse = Twiml.VoiceResponse;

// Helper: where to send text to the agent
const VOICE_AGENT_URL =
  process.env.VOICE_AGENT_URL ||
  "https://book8-voice-agent.onrender.com/agent/chat";

// Business resolver from core API
// Route every call via core-api resolve
async function resolveBusinessByTo(toPhone) {
  if (!toPhone) return null;

  // Call: GET https://book8-core-api.onrender.com/api/resolve?to=${encodeURIComponent(To)}
  const url = `https://book8-core-api.onrender.com/api/resolve?to=${encodeURIComponent(toPhone)}`;
  
  try {
    const r = await fetch(url);
    if (!r.ok) {
      console.error(`Core API resolve failed: ${r.status} ${r.statusText}`);
      return null;
    }

    const json = await r.json();
    // Response format: { businessId }
    return json?.businessId || null;
  } catch (err) {
    console.error("Error calling core-api resolve:", err);
    return null;
  }
}

// TTS Voice configuration
const DEFAULT_TTS_VOICE = process.env.TWILIO_TTS_VOICE || "Polly.Matthew-Neural";
// Other nice options: "Polly.Joanna-Neural", "Polly.Kendra-Neural", "Polly.Joey-Neural", "Polly.Salli-Neural"

// Helper: Clean and shorten text for phone conversations
function toPhoneSentence(text) {
  if (!text) {
    return "Sorry, I didn't catch that. Could you say that again?";
  }

  // Kill any markdown
  let clean = text.replace(/\*\*/g, "").replace(/[_`]/g, "").replace(/\n\n/g, ". ").replace(/\n/g, " ");

  // Split into sentences
  const parts = clean.split(/(?<=[.!?])\s+/);

  // Keep max 2 short sentences
  clean = parts.slice(0, 2).join(" ");

  // Hard cap length
  if (clean.length > 220) {
    clean = clean.slice(0, 220);
  }

  return clean.trim();
}

// --- SESSION STORE (stateful conversations) ---
const sessions = new Map();
const SESSION_TTL_MS = 20 * 60 * 1000; // 20 minutes

function getSession(callSid) {
  if (!callSid) return null;
  if (!sessions.has(callSid)) {
    sessions.set(callSid, { 
      messages: [], 
      lastActive: Date.now(), 
      businessId: null 
    });
  }
  const s = sessions.get(callSid);
  s.lastActive = Date.now();
  return s;
}

// Cleanup old sessions to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions.entries()) {
    if (now - s.lastActive > SESSION_TTL_MS) {
      sessions.delete(sid);
      console.log(`Cleaned up expired session: ${sid}`);
    }
  }
}, 60 * 1000); // Run cleanup every minute

// --- HOME PAGE ---
app.get("/", (req, res) => {
  res.send(`
    <h1>Book8 Voice Gateway</h1>
    <p>Status: <b>Running</b></p>
    <p>Twilio Webhook: POST /twilio/voice</p>
  `);
});

// --- HEALTH CHECK ---
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "book8-voice-gateway" });
});

// ---------------------------------------------------------------------
//  Twilio entrypoint: /twilio/voice
//  - Reads req.body.To (Twilio number being called)
//  - Calls core-api /api/resolve?to=${To} to get business
//  - Sets businessId from response and carries it through query string
//  - Greets the caller and starts a <Gather> for speech
// ---------------------------------------------------------------------
app.post("/twilio/voice", async (req, res) => {
  const to = req.body.To;     // Twilio number dialed (your shared number)
  const from = req.body.From; // caller
  const callSid = req.body.CallSid; // Twilio call identifier

  console.log("Incoming call from:", from, "to:", to, "CallSid:", callSid);

  // Get or create session for this call
  const session = getSession(callSid);

  // Check if businessId is already in query string (from redirects)
  // If present, use it; otherwise resolve from phone number
  let businessId = req.query.businessId || session.businessId;

  if (!businessId) {
    // Read req.body.To and call core-api /api/resolve?to=${To}
    // Get { businessId } from response
    businessId = await resolveBusinessByTo(to);

    // If no business found, fail gracefully
    if (!businessId) {
      const vr = new VoiceResponse();
      vr.say(
        {
          voice: DEFAULT_TTS_VOICE,
          language: "en-US"
        },
        "This number is not yet configured for a business. Goodbye."
      );
      vr.hangup();
      res.type("text/xml").send(vr.toString());
      return;
    }
  }

  // Store businessId in session
  session.businessId = businessId;

  // IMPORTANT: keep businessId in the query string for all future gathers
  const vr = new VoiceResponse();
  const gather = vr.gather({
    input: "speech",
    action: `/twilio/handle-gather?businessId=${encodeURIComponent(businessId)}`,
    method: "POST",
    language: "en-US",
    speechTimeout: "auto",
    bargeIn: true
  });

  // Use generic greeting (business details can be fetched later if needed)
  const greet = "Hi, thanks for calling. How can I help you today?";

  gather.say(
    {
      voice: DEFAULT_TTS_VOICE,
      language: "en-US"
    },
    greet
  );

  vr.redirect(`/twilio/voice?businessId=${encodeURIComponent(businessId)}`);
  res.type("text/xml").send(vr.toString());
});

// ---------------------------------------------------------------------
//  Twilio speech handler: /twilio/handle-gather
//  - Receives SpeechResult from Twilio
//  - Immediately responds with "thinking" message to reduce perceived lag
//  - Redirects to /twilio/process-agent for actual processing
// ---------------------------------------------------------------------
app.post("/twilio/handle-gather", async (req, res) => {
  const speech =
    req.body.SpeechResult ||
    req.body.TranscriptionText ||
    req.body.Body ||
    "";
  const from = req.body.From;
  const to = req.body.To;
  const callSid = req.body.CallSid; // Twilio call identifier
  let businessId = req.query.businessId;

  // Get or create session for this call
  const session = getSession(callSid);

  // Keep using the passed businessId (don't re-resolve unless missing)
  if (!businessId && session.businessId) {
    businessId = session.businessId;
  } else if (!businessId && to) {
    console.log("businessId missing in handle-gather, re-resolving from to:", to);
    businessId = await resolveBusinessByTo(to);
    session.businessId = businessId;
  }

  console.log("Twilio SpeechResult:", speech, "from", from, "businessId", businessId, "CallSid:", callSid);

  const vr = new VoiceResponse();

  // If no speech, redirect back to voice entry
  if (!speech || speech.trim().length === 0) {
    const redirectUrl = businessId 
      ? `/twilio/voice?businessId=${encodeURIComponent(businessId)}`
      : "/twilio/voice";
    vr.redirect(redirectUrl);
    res.type("text/xml").send(vr.toString());
    return;
  }

  // If still no businessId after re-resolution, fail gracefully
  if (!businessId) {
    vr.say(
      {
        voice: DEFAULT_TTS_VOICE,
        language: "en-US"
      },
      "I'm sorry, I'm having trouble identifying your business. Please try calling again."
    );
    vr.hangup();
    res.type("text/xml").send(vr.toString());
    return;
  }

  // Store businessId in session
  session.businessId = businessId;

  // Add user message to session history
  session.messages.push({ role: "user", content: speech });

  // Immediately respond with "thinking" message to reduce perceived lag
  // This makes the call feel much more responsive
  vr.say(
    {
      voice: DEFAULT_TTS_VOICE,
      language: "en-US"
    },
    "Sure — one second."
  );

  // Redirect to processing endpoint with all necessary params
  const params = new URLSearchParams({
    speech: speech,
    from: from || "",
    to: to || "",
    businessId: businessId || "",
    callSid: callSid || ""
  });

  vr.redirect(`/twilio/process-agent?${params.toString()}`);
  res.type("text/xml").send(vr.toString());
});

// ---------------------------------------------------------------------
//  Twilio agent processor: /twilio/process-agent
//  - Does the actual agent API call
//  - Speaks the agent's reply back to the caller
//  - Starts another <Gather> for multi-turn conversation
// ---------------------------------------------------------------------
app.get("/twilio/process-agent", async (req, res) => {
  const vr = new VoiceResponse();

  const speech = req.query.speech || "";
  const from = req.query.from || "";
  const to = req.query.to || "";
  const callSid = req.query.callSid || "";
  let businessId = req.query.businessId || "";

  // Get session for this call
  const session = getSession(callSid);

  // Keep using the passed businessId (don't re-resolve unless missing)
  if (!businessId && session.businessId) {
    businessId = session.businessId;
  } else if (!businessId && to) {
    console.log("businessId missing in process-agent, re-resolving from to:", to);
    businessId = await resolveBusinessByTo(to);
    session.businessId = businessId;
  }

  let replyText =
    "I'm sorry, I didn't quite catch that. Could you please repeat what you need?";

  if (speech && speech.trim().length > 0 && businessId) {
    try {
      // Send full message history (last ~12 messages) to agent for context
      const recentMessages = session.messages.slice(-12);
      
      const agentBody = {
        handle: businessId,          // keep existing contract
        businessId: businessId,      // explicit
        messages: recentMessages,     // full conversation history
        callerPhone: from || null,
        toPhone: to || null,          // IMPORTANT for resolving later
        callSid: callSid || null
      };

      const agentRes = await fetch(VOICE_AGENT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(agentBody),
      });

      if (!agentRes.ok) {
        console.error(
          "Agent API error:",
          agentRes.status,
          await agentRes.text()
        );
        replyText =
          "I'm having trouble accessing the scheduling system right now. Please try again a bit later.";
      } else {
        const agentJson = await agentRes.json();
        console.log("Agent response:", agentJson);
        if (agentJson.ok && agentJson.reply) {
          replyText = agentJson.reply;
          // Add assistant reply to session history
          session.messages.push({ role: "assistant", content: replyText });
        } else {
          replyText = (agentJson && agentJson.reply) || "Thanks. How else can I help you today?";
          if (replyText) {
            session.messages.push({ role: "assistant", content: replyText });
          }
        }
      }
    } catch (err) {
      console.error("Error in /twilio/process-agent:", err);
      replyText =
        "I'm having trouble accessing the scheduling system right now. Please try again a bit later.";
    }
  }

  // If still no businessId after re-resolution, fail gracefully
  if (!businessId) {
    vr.say(
      {
        voice: DEFAULT_TTS_VOICE,
        language: "en-US"
      },
      "I'm sorry, I'm having trouble identifying your business. Please try calling again."
    );
    vr.hangup();
    res.type("text/xml").send(vr.toString());
    return;
  }

  // --- Build next <Gather> with barge-in so the caller can interrupt ---
  // Keep messages short: split into sentences and only say the first 1–2
  const phoneReply = toPhoneSentence(replyText);
  const sentences = phoneReply.split(/(?<=[.!?])\s+/);
  const trimmed = sentences.slice(0, 2).join(" ");
  
  const gather = vr.gather({
    input: "speech",
    action: `/twilio/handle-gather?businessId=${encodeURIComponent(businessId)}`,
    method: "POST",
    language: "en-US",
    speechTimeout: "auto",
    bargeIn: true, // 🔑 allow interruption on every turn
  });

  // Use SSML with breaks for more natural delivery
  gather.say(
    {
      voice: DEFAULT_TTS_VOICE,
      language: "en-US",
    },
    `<speak>${trimmed}</speak>`
  );

  // Keep conversation going with businessId
  vr.redirect(`/twilio/voice?businessId=${encodeURIComponent(businessId)}`);

  res.type("text/xml");
  res.send(vr.toString());
});

// --- Simple debug endpoint to talk to the agent over HTTP (text only) ---
app.post("/debug/agent-chat", async (req, res) => {
  try {
    const { handle, message, messages, businessId, callerPhone, toPhone, callSid } = req.body || {};

    // Support both single message (backward compat) and messages array (stateful)
    let conversationMessages = [];
    if (messages && Array.isArray(messages) && messages.length > 0) {
      // Use provided messages array (stateful conversation)
      conversationMessages = messages;
    } else if (message) {
      // Single message (backward compatibility)
      conversationMessages = [{ role: "user", content: message }];
    } else {
      return res.status(400).json({
        ok: false,
        error: "Missing 'message' or 'messages' in request body"
      });
    }

    if (!handle && !businessId) {
      return res.status(400).json({
        ok: false,
        error: "Missing 'handle' or 'businessId' in request body"
      });
    }

    const businessHandle = handle || businessId;

    // 1) Get business profile & system instructions
    const profile = await getBusinessProfile(businessHandle);
    const systemPrompt = buildSystemPrompt(profile);

    // 2) First call: ask the model what to do (with tools enabled)
    const first = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        ...conversationMessages
      ],
      tools,                  // 👈 from agentConfig.js
      tool_choice: "auto"     // let it decide when to call tools
    });

    console.log("FIRST RESPONSE RAW:", JSON.stringify(first, null, 2));

    const assistantMessage = first.choices[0]?.message;
    if (!assistantMessage) {
      throw new Error("No response from model");
    }

    // Extract any tool calls
    const toolCalls = assistantMessage.tool_calls || [];
    const textContent = assistantMessage.content || "";

    // If there are NO tool calls, just return what it said
    if (toolCalls.length === 0) {
      return res.json({
        ok: true,
        reply: textContent,
        raw: first,
        note: "No tool calls in first response"
      });
    }

    // 3) Execute tool calls against Book8
    const toolOutputs = [];

    for (const tc of toolCalls) {
      const name = tc.function?.name;
      const args = JSON.parse(tc.function?.arguments || "{}");
      const call_id = tc.id;
      console.log("Processing tool call:", name, args);

      if (name === "check_availability") {
        // Expecting: { date, timezone, durationMinutes }
        const resp = await fetch(`${BOOK8_BASE_URL}/api/agent/availability`, {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "x-book8-agent-key": profile.agentApiKey
          },
          body: JSON.stringify({
            agentApiKey: profile.agentApiKey,
            date: args.date,
            timezone: args.timezone,
            durationMinutes: args.durationMinutes
          })
        });

        const data = await resp.json();
        console.log("check_availability result:", data);

        toolOutputs.push({
          role: "tool",
          tool_call_id: call_id,
          content: JSON.stringify(data)
        });
      }

      if (name === "book_appointment") {
        const resp = await fetch(`${BOOK8_BASE_URL}/api/agent/book`, {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "x-book8-agent-key": profile.agentApiKey
          },
          body: JSON.stringify({
            agentApiKey: profile.agentApiKey,
            start: args.start,
            guestName: args.guestName,
            guestEmail: args.guestEmail,
            guestPhone: args.guestPhone
          })
        });

        const data = await resp.json();
        console.log("book_appointment result:", data);

        toolOutputs.push({
          role: "tool",
          tool_call_id: call_id,
          content: JSON.stringify(data)
        });
      }
    }

    // 4) Second call: give the tool results back to the model to generate the final reply
    let second = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: message
        },
        assistantMessage,
        ...toolOutputs
      ],
      tools,
      tool_choice: "auto"
    });

    console.log("SECOND RESPONSE RAW:", JSON.stringify(second, null, 2));

    const secondMessage = second.choices[0]?.message;
    
    // Check if the second response also wants to call tools (e.g., book_appointment after check_availability)
    if (secondMessage.tool_calls && secondMessage.tool_calls.length > 0) {
      const secondToolCalls = secondMessage.tool_calls;
      const secondToolOutputs = [];

      for (const tc of secondToolCalls) {
        const name = tc.function?.name;
        const args = JSON.parse(tc.function?.arguments || "{}");
        const call_id = tc.id;
        console.log("Processing second tool call:", name, args);

        if (name === "check_availability") {
          const resp = await fetch(`${BOOK8_BASE_URL}/api/agent/availability`, {
            method: "POST",
            headers: { 
              "Content-Type": "application/json",
              "x-book8-agent-key": profile.agentApiKey
            },
            body: JSON.stringify({
              agentApiKey: profile.agentApiKey,
              date: args.date,
              timezone: args.timezone,
              durationMinutes: args.durationMinutes
            })
          });

          const data = await resp.json();
          console.log("check_availability result:", data);

          secondToolOutputs.push({
            role: "tool",
            tool_call_id: call_id,
            content: JSON.stringify(data)
          });
        }

        if (name === "book_appointment") {
          const resp = await fetch(`${BOOK8_BASE_URL}/api/agent/book`, {
            method: "POST",
            headers: { 
              "Content-Type": "application/json",
              "x-book8-agent-key": profile.agentApiKey
            },
            body: JSON.stringify({
              agentApiKey: profile.agentApiKey,
              start: args.start,
              guestName: args.guestName,
              guestEmail: args.guestEmail,
              guestPhone: args.guestPhone
            })
          });

          const data = await resp.json();
          console.log("book_appointment result:", data);

          secondToolOutputs.push({
            role: "tool",
            tool_call_id: call_id,
            content: JSON.stringify(data)
          });
        }
      }

      // Third call: get final response after second round of tool calls
      const third = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: message
          },
          assistantMessage,
          ...toolOutputs,
          secondMessage,
          ...secondToolOutputs
        ]
      });

      const finalText = third.choices[0]?.message?.content || "Sorry, I couldn't generate a response.";

      return res.json({
        ok: true,
        reply: finalText,
        first,
        second,
        third,
        toolCalls: [...toolCalls, ...secondToolCalls],
        toolOutputs: [...toolOutputs, ...secondToolOutputs]
      });
    }

    const finalText = secondMessage?.content || "Sorry, I couldn't generate a response.";

    return res.json({
      ok: true,
      reply: finalText,
      first,
      second,
      toolCalls,
      toolOutputs
    });
  } catch (err) {
    console.error("Error in /debug/agent-chat:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Internal error in agent-chat"
    });
  }
});

// --- 404 FALLBACK ---
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`Book8 voice gateway listening on port ${PORT}`);
});
