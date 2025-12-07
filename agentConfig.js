// agentConfig.js
import dotenv from "dotenv";

dotenv.config();

// 1) Static business profile for now.
// Later we can fetch this from Book8 via HTTP.
export const BUSINESS_PROFILE = {
  handle: "waismofit",             // Book8 scheduling handle
  businessType: "fitness coaching",
  name: "Wais Mo Fitness",
  timezone: "America/Toronto",

  // What the AI can talk about / offer
  services: [
    {
      id: "consult_30",
      label: "30-minute intro call",
      durationMinutes: 30,
      price: 0,
      description: "Free discovery call to understand goals."
    },
    {
      id: "session_60",
      label: "60-minute 1:1 training session",
      durationMinutes: 60,
      price: 120,
      description: "Personal training session."
    }
  ],

  // Simple policies/prompts the agent can mention
  policies: {
    cancellation: "Please give at least 12 hours notice to cancel or reschedule.",
    location: "All sessions are online via video call unless otherwise agreed."
  }
};

// Build the SYSTEM prompt string the Realtime model will receive.
export function buildSystemPrompt(profile) {
  const tz = profile.timezone || "America/Toronto";

  // Compute "today" in that timezone, but keep it simple: use server date in YYYY-MM-DD
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10); // e.g. "2025-12-06"

  return `
You are a professional phone booking agent for the business "${profile.name}" (handle: ${profile.handle}).

Current date (today) is: ${todayIso} in timezone ${tz}.

Your job:
- Have a natural, friendly, *real* conversation with callers.
- Help them choose a service, explain options and pricing.
- Check availability using tools.
- Book appointments using tools.
- Never make up availability or bookings — always use tools for that.

Services available:
${profile.services.map(s => `   - ${s.label} (${s.durationMinutes} minutes, $${s.price}) — ${s.description}`).join("\n")}

Policies:
- Cancellation: ${profile.policies.cancellation}
- Location: ${profile.policies.location}

VERY IMPORTANT RULES ABOUT DATES & TIMES:
- Always interpret phrases like "today", "tomorrow", "this afternoon", "next Monday" relative to TODAY = ${todayIso} in timezone ${tz}.
- When calling tools:
  - For "check_availability", you MUST use:
    - "date": a calendar date in the form YYYY-MM-DD (e.g. "2025-12-07").
    - "timezone": an IANA timezone (e.g. "${tz}").
    - "durationMinutes": the numeric duration in minutes.
  - For "book_appointment", you MUST use:
    - "start": a full ISO 8601 datetime with offset, e.g. "2025-12-07T10:00:00-05:00" if the caller said "tomorrow at 10am".
    - "guestName", "guestEmail", "guestPhone" from the caller when available.
- Do NOT use dates in the past (like 2023) when the user clearly means a future date like "tomorrow".
- If you're unsure about the date or time, ask a clarifying question.

TOOLS:
- If you need to check open times, ALWAYS call "check_availability".
- If the caller confirms a specific time, ALWAYS call "book_appointment" to actually book it.
- Never say "I can't check availability" unless a tool call actually fails.

If the tools say there are no available slots:
- Apologize.
- Offer alternative times (e.g. earlier/later that day, or another day).
- Ask the caller what they prefer.

Keep responses short and spoken-friendly. You are talking on the phone, not writing an email.
`;
}

// Helper to get business profile by handle (for now, just return static profile)
export async function getBusinessProfile(handle) {
  // For now, return static profile. Later we can fetch from Book8 API
  const profile = { ...BUSINESS_PROFILE };
  // Add agentApiKey from env for now
  profile.agentApiKey = process.env.BOOK8_AGENT_API_KEY;
  return profile;
}

// Tool schemas for OpenAI responses API
export const tools = [
  {
    type: "function",
    function: {
      name: "check_availability",
      description: "Check available time slots for the business on a given day.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "ISO date, e.g. 2025-12-01" },
          timezone: { type: "string", description: "IANA timezone" },
          durationMinutes: { type: "number" }
        },
        required: ["date", "timezone", "durationMinutes"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description: "Book an appointment in the schedule.",
      parameters: {
        type: "object",
        properties: {
          start: { type: "string", description: "ISO datetime with timezone" },
          guestName: { type: "string" },
          guestEmail: { type: "string" },
          guestPhone: { type: "string" }
        },
        required: ["start", "guestName"]
      }
    }
  }
];

// Also export as TOOLS for backward compatibility
export const TOOLS = tools;

// Helper to map a service label → duration (for the tools)
export function getServiceById(profile, serviceId) {
  return profile.services.find(s => s.id === serviceId) || null;
}

