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
  "https://book8-voice-gateway.onrender.com/debug/agent-chat";

const DEFAULT_HANDLE = process.env.DEFAULT_HANDLE || "waismofit";

// TTS Voice configuration
const DEFAULT_TTS_VOICE = process.env.TWILIO_TTS_VOICE || "Polly.Joanna-Neural";
// Other nice options: "Polly.Matthew-Neural", "Polly.Joey-Neural", "Polly.Salli-Neural"

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
//  - Greets the caller
//  - Starts a <Gather> for speech
// ---------------------------------------------------------------------
app.post("/twilio/voice", (req, res) => {
  console.log("Incoming call from:", req.body.From);

  const vr = new VoiceResponse();

  // Gather caller speech and send it to /twilio/handle-gather
  const gather = vr.gather({
    input: "speech",
    action: "/twilio/handle-gather",
    method: "POST",
    language: "en-US",
    speechTimeout: "auto"
  });

  gather.say(
    {
      voice: DEFAULT_TTS_VOICE,
      language: "en-US"
    },
    `<speak>Hi, this is Wais Mo Fitness. <break time="250ms"/> I'm your AI assistant. How can I help you today?</speak>`
  );

  // If nothing is said, loop back
  vr.redirect("/twilio/voice");

  res.type("text/xml");
  res.send(vr.toString());
});

// ---------------------------------------------------------------------
//  Twilio speech handler: /twilio/handle-gather
//  - Receives SpeechResult from Twilio
//  - Sends it to the agent (/debug/agent-chat)
//  - Speaks the agent's reply back to the caller
//  - Starts another <Gather> for multi-turn conversation
// ---------------------------------------------------------------------
app.post("/twilio/handle-gather", async (req, res) => {
  const vr = new VoiceResponse();

  const speech =
    req.body.SpeechResult ||
    req.body.TranscriptionText ||
    req.body.Body ||
    "";
  const from = req.body.From;

  console.log("Twilio SpeechResult:", speech, "from", from);

  let replyText =
    "I'm sorry, I didn't quite catch that. Could you please repeat what you need?";

  if (speech && speech.trim().length > 0) {
    try {
      // ✅ IMPORTANT: tell the agent which business to use
      const agentBody = {
        handle: "waismofit",
        message: speech,
        callerPhone: req.body.From || null
      };

      const agentRes = await fetch(VOICE_AGENT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(agentBody)
      });

      if (!agentRes.ok) {
        throw new Error(`Agent API returned ${agentRes.status}: ${agentRes.statusText}`);
      }

      const agentJson = await agentRes.json();
      console.log("Agent response:", agentJson);

      if (agentJson && agentJson.reply) {
        replyText = agentJson.reply;
      } else {
        console.warn("Agent response missing 'reply' field:", agentJson);
      }
    } catch (err) {
      console.error("Error in /twilio/handle-gather:", err);
      replyText =
        "I'm having trouble accessing the scheduling system right now. Please try again later.";
    }
  }

  // Speak the agent's reply
  // Clean the text and wrap in SSML for more natural delivery
  const cleanedReply = replyText.trim();
  const spokenReply = `<speak>
  <prosody rate="95%">
    ${cleanedReply}
  </prosody>
</speak>`;

  vr.say(
    {
      voice: DEFAULT_TTS_VOICE,
      language: "en-US"
    },
    spokenReply
  );

  // Ask if they want to continue (multi-turn)
  const gather = vr.gather({
    input: "speech",
    action: "/twilio/handle-gather",
    method: "POST",
    language: "en-US",
    speechTimeout: "auto"
  });

  gather.say(
    {
      voice: DEFAULT_TTS_VOICE,
      language: "en-US"
    },
    "You can ask another question, book another appointment, or say goodbye to end the call."
  );

  res.type("text/xml");
  res.send(vr.toString());
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
