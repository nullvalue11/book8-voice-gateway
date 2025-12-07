// index.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import twilio from "twilio";
import OpenAI from "openai";
import { buildSystemPrompt, tools, getBusinessProfile } from "./agentConfig.js";

dotenv.config();

const { twiml: Twiml } = twilio;

// --- ENV ---
const PORT = process.env.PORT || 3000;
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
app.use(express.urlencoded({ extended: true })); // Twilio sends form-encoded
app.use(express.json());

// --- VERY SIMPLE IN-MEMORY SESSION STORE ---
// key = CallSid, value = { messages: [...] }
const sessions = new Map();

function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      messages: [
        {
          role: "system",
          content: [
            {
              type: "text",
              text:
                "You are Book8 AI, a friendly phone receptionist for a small business. " +
                "You talk like a real person: short sentences, warm tone, natural. " +
                "You can ask questions to understand what the caller wants, " +
                "and you summarize / clarify details. " +
                "Avoid sounding like a robot. " +
                "For now, you cannot directly change the calendar, but you can help " +
                "the caller decide what they want and tell them that a booking link " +
                "can be texted or emailed later."
            }
          ]
        }
      ]
    });
  }
  return sessions.get(callSid);
}

// --- HOME PAGE ---
app.get("/", (req, res) => {
  res.send(`
    <h1>Book8 Voice Gateway</h1>
    <p>Status: <strong>Running</strong></p>
    <p>Twilio Webhook: <strong>POST /twilio/voice</strong></p>
  `);
});

// --- HEALTH CHECK ---
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "book8-voice-gateway" });
});

// --- MAIN TWILIO VOICE WEBHOOK ---
// Twilio hits this endpoint multiple times in a call.
// Flow:
//  1. First hit: no SpeechResult -> we greet the caller & <Gather> speech.
//  2. Next hits: Twilio includes SpeechResult -> we send to OpenAI, get reply,
//     then <Gather> again for the next user turn.
app.post("/twilio/voice", async (req, res) => {
  const twiml = new Twiml.VoiceResponse();
  const {
    CallSid,
    From,
    SpeechResult,
    Confidence,
    CallStatus
  } = req.body || {};

  console.log("---- Incoming Twilio webhook ----");
  console.log("CallSid:", CallSid, "From:", From, "Status:", CallStatus);
  console.log("SpeechResult:", SpeechResult, "Confidence:", Confidence);

  // If the call is ending, clean up session
  if (CallStatus === "completed" || CallStatus === "busy" || CallStatus === "no-answer") {
    sessions.delete(CallSid);
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  const session = getSession(CallSid);

  // FIRST TURN: no SpeechResult yet -> greet + ask how to help
  if (!SpeechResult) {
    const gather = twiml.gather({
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
      "Hi! Thanks for calling. This is the Book Eight A.I. assistant. " +
        "How can I help you today?"
    );

    // If no speech at all, we'll hang up politely
    twiml.say(
      {
        voice: "Polly.Amy-Neural",
        language: "en-US"
      },
      "Hmm, I didn't quite hear anything. If you need help later, feel free to call again."
    );
    twiml.hangup();

    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // SUBSEQUENT TURNS: we have SpeechResult -> send to OpenAI
  session.messages.push({
    role: "user",
    content: [{ type: "text", text: SpeechResult }]
  });

  let aiText = "Sorry, I'm having trouble understanding right now. Could you repeat that?";

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: session.messages
    });

    // The responses API returns an array of content blocks
    const output = response.output?.[0];
    if (output && output.type === "message") {
      const textPart = output.content.find(p => p.type === "text");
      if (textPart) {
        aiText = textPart.text;
        // store assistant message back into session
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: aiText }]
        });
      }
    }

    console.log("AI:", aiText);
  } catch (err) {
    console.error("OpenAI error:", err);
    aiText =
      "I'm sorry, I'm having an issue right now. Please try again later or use the online booking link.";
  }

  // Reply to caller + keep conversation going with another <Gather>
  const gather = twiml.gather({
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
    aiText
  );

  // Safety: if user goes silent, we'll end after this turn.
  twiml.say(
    {
      voice: "Polly.Amy-Neural",
      language: "en-US"
    },
    "If you don't say anything, I'll end the call. You can always call back."
  );
  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

// --- Simple debug endpoint to talk to the agent over HTTP (text only) ---
app.post("/debug/agent-chat", async (req, res) => {
  try {
    const { handle, message } = req.body || {};

    if (!handle || !message) {
      return res.status(400).json({
        ok: false,
        error: "Missing 'handle' or 'message' in request body"
      });
    }

    // 1) Get business profile & system instructions
    const profile = await getBusinessProfile(handle);
    const systemPrompt = buildSystemPrompt(profile);

    // 2) First call: ask the model what to do (with tools enabled)
    const first = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: message
        }
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
    const second = await openai.chat.completions.create({
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
      ]
    });

    console.log("SECOND RESPONSE RAW:", JSON.stringify(second, null, 2));

    const finalText = second.choices[0]?.message?.content || "Sorry, I couldn't generate a response.";

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
