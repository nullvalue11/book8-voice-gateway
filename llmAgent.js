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
const MODEL = "gpt-4.1-mini"; // or "gpt-4o-mini" once GA in responses API

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
  let response = await openai.responses.create({
    model: MODEL,
    input: messages,
    tools: TOOLS,
    tool_choice: "auto",
  });

  // Helper to normalize outputs
  const firstOutput = response.output?.[0];
  if (!firstOutput) {
    throw new Error("No output from model");
  }

  // 2. If the model wants to call tools, handle them
  if (firstOutput.type === "tool_call") {
    const toolCalls = firstOutput.tool_calls || [];

    const toolResults = [];

    for (const call of toolCalls) {
      const { name, arguments: args, call_id } = call;

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
    response = await openai.responses.create({
      model: MODEL,
      input: [
        ...messages,
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              tool_calls: toolCalls,
            },
          ],
        },
        ...toolResults,
      ],
    });
  }

  const finalOutput = response.output?.[0];
  if (!finalOutput) {
    throw new Error("No final output from model");
  }

  if (finalOutput.type === "message") {
    const text = finalOutput.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join(" ");

    return { text, raw: response };
  }

  // fallback
  return { text: JSON.stringify(finalOutput), raw: response };
}

