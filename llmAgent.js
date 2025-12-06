// llmAgent.js
import dotenv from "dotenv";
import OpenAI from "openai";
import { BUSINESS_PROFILE, buildSystemPrompt, TOOLS, getServiceById } from "./agentConfig.js";
import { checkAvailability, bookAppointment } from "./book8Client.js";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// choose a cost-friendly model here
const MODEL = "gpt-4o-mini"; // Using chat completions API

/**
 * Run a single agent turn:
 * - userMessage: text from the customer
 * - handle: which business (e.g. "waismofit")
 */
export async function runAgentTurn({ handle, userMessage }) {
  // For now, use the static BUSINESS_PROFILE
  // Later we can fetch by handle from Book8
  const profile = BUSINESS_PROFILE;
  const systemPrompt = buildSystemPrompt(profile);

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  // 1. Ask the model; allow tool calls
  let response = await openai.chat.completions.create({
    model: MODEL,
    messages: messages,
    tools: TOOLS,
    tool_choice: "auto",
  });

  // Helper to normalize outputs
  const assistantMessage = response.choices[0]?.message;
  if (!assistantMessage) {
    throw new Error("No output from model");
  }

  // 2. If the model wants to call tools, handle them
  if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
    const toolCalls = assistantMessage.tool_calls;

    const toolResults = [];

    for (const call of toolCalls) {
      const { function: func, id: call_id } = call;
      const name = func.name;
      const args = JSON.parse(func.arguments || "{}");

      try {
        if (name === "check_availability") {
          const { date, timezone, durationMinutes, serviceId } = args;

          // we don't actually need serviceId to hit Book8, but you might log it:
          const service = serviceId ? getServiceById(profile, serviceId) : null;
          console.log("[agent] check_availability for", {
            date,
            timezone,
            durationMinutes,
            service: service?.label,
          });

          const availability = await checkAvailability({
            date,
            timezone: timezone || profile.timezone,
            durationMinutes,
          });

          toolResults.push({
            role: "tool",
            tool_call_id: call_id,
            name,
            content: JSON.stringify(availability),
          });
        } else if (name === "book_appointment") {
          const {
            start,
            guestName,
            guestEmail,
            guestPhone,
            serviceId,
          } = args;

          const service = serviceId ? getServiceById(profile, serviceId) : null;
          console.log("[agent] book_appointment", {
            start,
            guestName,
            service: service?.label,
          });

          const booking = await bookAppointment({
            start,
            guestName,
            guestEmail,
            guestPhone,
          });

          toolResults.push({
            role: "tool",
            tool_call_id: call_id,
            name,
            content: JSON.stringify(booking),
          });
        } else {
          console.warn("[agent] Unknown tool name", name);
        }
      } catch (err) {
        console.error("[agent] Tool error", name, err);
        toolResults.push({
          role: "tool",
          tool_call_id: call_id,
          name,
          content: JSON.stringify({
            ok: false,
            error: err.message || "Tool failed",
          }),
        });
      }
    }

    // 3. Send tool outputs back to the model and get the final reply
    response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        ...messages,
        assistantMessage,
        ...toolResults,
      ],
    });
  }

  const finalMessage = response.choices[0]?.message;
  if (!finalMessage) {
    throw new Error("No final output from model");
  }

  const text = finalMessage.content || "Sorry, I couldn't generate a response.";

  return { text, raw: response };
}

