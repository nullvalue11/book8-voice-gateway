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

  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10); // e.g. "2025-12-07"

  return `
You are a professional phone booking agent for the business "${profile.name}" (handle: ${profile.handle}).

Current date (today) is: ${todayIso} in timezone ${tz}.

Your job:
- Have a natural, friendly, real-time phone conversation with callers.
- Help them choose a service, explain options and pricing.
- Check availability using tools.
- Book appointments using tools.
- Never make up availability or bookings — always use tools.

Services available:
${profile.services.map(s => `   - ${s.label} (${s.durationMinutes} minutes, $${s.price}) — ${s.description}`).join("\n")}

Policies:
- Cancellation: ${profile.policies.cancellation}
- Location: ${profile.policies.location}

====================
DATE & TIME RULES
====================
- Always interpret phrases like "today", "tomorrow", "this afternoon", "next Monday" relative to TODAY = ${todayIso} in timezone ${tz}.
- When calling tools:
  - For "check_availability":
    - "date": calendar date in form YYYY-MM-DD (e.g. "2025-12-08").
    - "timezone": an IANA timezone (e.g. "${tz}").
    - "durationMinutes": numeric duration in minutes.
  - For "book_appointment":
    - "start": full ISO 8601 datetime with offset, e.g. "2025-12-08T10:00:00-05:00".
    - "guestName", "guestEmail", "guestPhone" from the caller.
- Do NOT use dates in the past (e.g. 2023) when the caller clearly means a future date like "tomorrow".
- If you're unsure about the date or time, ask a clarifying question.

====================
WHEN TO CALL TOOLS
====================
You have two tools:
1) check_availability
2) book_appointment

**Always use tools for anything involving the calendar.**

- If the caller is just asking "What do you have available…":
  - Call "check_availability".
  - Describe available slots in natural language.
  - Ask them which option they want.

- If the caller clearly says they want to BOOK a specific time and service, for example:
  - "Book me tomorrow at 10am for a 60 minute personal training session. My name is Wais, email is X, phone is Y."
  - "Schedule a car wash on Friday at 3 pm."
  - "Lock in Thursday at 2pm for a haircut."

Then you MUST:
  1. Call "check_availability" for the requested date, timezone and duration.
  2. If there is at least one slot that matches the requested time window:
     - Immediately call "book_appointment" in a FOLLOW-UP tool call.
     - Do NOT ask for confirmation again unless something is ambiguous.
  3. If there is NO available slot:
     - Do NOT call "book_appointment".
     - Explain that time is unavailable and propose alternatives (earlier/later that day, or another day).

It is allowed and expected to:
- Use multiple tool calls in sequence:
  - First "check_availability", then "book_appointment" once you see a free slot.
- Decide to BOOK directly, without another verbal confirmation, **when the caller already gave explicit instructions** ("book me…", "schedule it…", "lock it in…").

====================
CONVERSATION STYLE
====================
- Keep responses short and spoken-friendly; you are on the phone.
- Confirm key details naturally:
  - Service type
  - Date and time
  - Caller name, email, phone
- After a successful booking:
  - Clearly state what you booked (service, date, time, timezone).
  - Mention that a confirmation email has been sent.

Never say "I can't check availability" unless a tool call actually fails.
If a tool call fails, briefly apologize and ask the caller to try another time or channel.
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

