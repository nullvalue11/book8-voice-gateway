// index.js – Book8 Voice Gateway with AI Agent
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import twilio from "twilio";
import OpenAI from "openai";

dotenv.config();

const { twiml: Twiml } = twilio;

// ---- Config & clients ----
const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded
app.use(express.json());

const PORT = process.env.PORT || 5050;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const BOOK8_BASE_URL = process.env.BOOK8_BASE_URL;
const AGENT_API_KEY = process.env.BOOK8_AGENT_API_KEY;

// in-memory per-call state (good enough for MVP)
const calls = new Map();

// ---- Helper: get or create call session ----
function getCallSession(callSid) {
  if (!calls.has(callSid)) {
    const systemPrompt =
      "You are Book8 AI, a friendly phone assistant that books meetings " +
      "for small businesses using the Book8 scheduling app. " +
      "You can check availability and create bookings via tools the server provides. " +
      "Ask natural questions, confirm details (name, email, phone, preferred time), " +
      "and then use the tools to check availability and book. " +
      "Always explain clearly what you did for the caller.";

    calls.set(callSid, {
      messages: [
        { role: "system", content: systemPrompt }
      ]
    });
  }
  return calls.get(callSid);
}

// ---- Tools definitions for OpenAI ----
const tools = [
  {
    type: "function",
    function: {
      name: "check_availability",
      description:
        "Check available time slots for the business on a given date.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "The date to check, in YYYY-MM-DD format."
          },
          timezone: {
            type: "string",
            description:
              "IANA timezone string like 'America/Toronto'. If unsure, use the business local timezone."
          },
          durationMinutes: {
            type: "integer",
            description: "Meeting duration in minutes. Default is 30.",
            default: 30
          }
        },
        required: ["date"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_booking",
      description:
        "Create a booking for the caller at a specific start time.",
      parameters: {
        type: "object",
        properties: {
          start: {
            type: "string",
            description:
              "Start datetime in ISO 8601 with timezone offset, e.g. 2025-12-01T14:30:00-05:00."
          },
          guestName: {
            type: "string",
            description: "Name of the caller."
          },
          guestEmail: {
            type: "string",
            description: "Email of the caller. Can be omitted if caller refuses."
          },
          guestPhone: {
            type: "string",
            description: "Phone number of the caller (E.164 if possible)."
          },
          notes: {
            type: "string",
            description:
              "Any extra notes about the appointment or caller's preferences."
          }
        },
        required: ["start", "guestName", "guestPhone"]
      }
    }
  }
];

// ---- Tool executors (Book8 APIs) ----
async function tool_checkAvailability(args) {
  const payload = {
    agentApiKey: AGENT_API_KEY,
    date: args.date,
    timezone: args.timezone || "America/Toronto",
    durationMinutes: args.durationMinutes || 30
  };

  const res = await fetch(`${BOOK8_BASE_URL}/api/agent/availability`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  return data;
}

async function tool_createBooking(args) {
  const payload = {
    agentApiKey: AGENT_API_KEY,
    start: args.start,
    guestName: args.guestName,
    guestEmail: args.guestEmail || "",
    guestPhone: args.guestPhone,
    notes: args.notes || "",
    source: "phone-agent"
  };

  const res = await fetch(`${BOOK8_BASE_URL}/api/agent/book`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  return data;
}

// ---- Root page (debug info) ----
app.get("/", (_req, res) => {
  res.send(`
    <h1>Book8 Voice Gateway</h1>
    <p>Status: <strong>Running</strong></p>
    <p>Twilio Webhook: <code>POST /twilio/voice</code></p>
  `);
});

// ---- Health check ----
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "book8-voice-gateway" });
});

// ---- Main Twilio voice webhook ----
app.post("/twilio/voice", async (req, res) => {
  const vr = new Twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult;
  const fromNumber = req.body.From;

  const session = getCallSession(callSid);

  // First hit: no speech yet → greet and gather speech
  if (!speechResult) {
    console.log("New call from", fromNumber, "CallSid:", callSid);

    const gather = vr.gather({
      input: "speech",
      speechTimeout: "auto",
      action: "/twilio/voice",
      method: "POST"
    });

    gather.say(
      {
        voice: "Polly.Amy-Neural",
        language: "en-US"
      },
      "Hi, thanks for calling Book Eight. I'm your AI assistant. " +
        "How can I help you today?"
    );

    vr.say(
      {
        voice: "Polly.Amy-Neural",
        language: "en-US"
      },
      "Sorry, I didn't catch that. Please call again later. Goodbye."
    );

    res.type("text/xml").send(vr.toString());
    return;
  }

  // We got speech from caller
  const userText = speechResult;
  console.log(`[${callSid}] Caller said:`, userText);

  session.messages.push({ role: "user", content: userText });

  try {
    // 1st pass: let the model decide whether to call tools
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: session.messages,
      tools,
      tool_choice: "auto"
    });

    let assistantMessage = completion.choices[0].message;
    session.messages.push(assistantMessage);

    // If there are tool calls, execute them and call the model again
    if (assistantMessage.tool_calls?.length) {
      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || "{}");
        let result;

        console.log(`[${callSid}] Tool called: ${toolName}`, args);

        if (toolName === "check_availability") {
          result = await tool_checkAvailability(args);
        } else if (toolName === "create_booking") {
          result = await tool_createBooking(args);
        } else {
          result = { ok: false, error: "Unknown tool" };
        }

        session.messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });
      }

      // 2nd pass: get a natural language answer using tool results
      const followup = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: session.messages
      });

      assistantMessage = followup.choices[0].message;
      session.messages.push(assistantMessage);
    }

    const replyText = assistantMessage.content || "Sorry, something went wrong.";

    console.log(`[${callSid}] Assistant:`, replyText);

    // Reply and gather next user utterance
    const gather = vr.gather({
      input: "speech",
      speechTimeout: "auto",
      action: "/twilio/voice",
      method: "POST"
    });

    gather.say(
      {
        voice: "Polly.Amy-Neural",
        language: "en-US"
      },
      replyText
    );

    vr.say(
      {
        voice: "Polly.Amy-Neural",
        language: "en-US"
      },
      "We got disconnected. Please call again if you need anything else. Goodbye."
    );

    res.type("text/xml").send(vr.toString());
  } catch (err) {
    console.error(`[${callSid}] Error in AI flow`, err);

    vr.say(
      {
        voice: "Polly.Amy-Neural",
        language: "en-US"
      },
      "Sorry, I had a problem processing your request. Please try again later."
    );

    res.type("text/xml").send(vr.toString());
  }
});

// ---- Cleanup on hangup (optional) ----
app.post("/twilio/status", (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  if (["completed", "failed", "busy", "no-answer"].includes(callStatus)) {
    calls.delete(callSid);
    console.log("Cleaned up call session:", callSid, "status:", callStatus);
  }
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Book8 voice gateway listening on port ${PORT}`);
});
