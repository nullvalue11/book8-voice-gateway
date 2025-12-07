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
  // For now we assume English callers.
  return `
You are **Book8 AI**, a professional phone assistant for the business:

- Business name: ${profile.name}
- Business type: ${profile.businessType}
- Booking handle in Book8: ${profile.handle}
- Timezone: ${profile.timezone}

Your goals:

1. Greet callers warmly and find out what they need.
2. Help them choose the right service from this list:
${profile.services.map(s => `   - ${s.label} (${s.durationMinutes} minutes, $${s.price}) — ${s.description}`).join("\n")}
3. Check availability using the **check_availability** tool before offering specific times.
4. Book appointments using the **book_appointment** tool.
5. Confirm all details clearly: service, date, time, timezone, and caller's name + phone (and email if relevant).
6. Be concise, friendly, and sound like a real human, not a robot.
7. If something is not possible (no slots, closed, etc.), apologize and offer alternative times or options.

Important rules:

- Always think in the business timezone: ${profile.timezone}.
- Never invent prices, durations, or services beyond what is provided above.
- If the caller is vague ("I want to book something"), ask clarifying questions:
  - What service?
  - What day (or range)?
  - Morning/afternoon/evening preference?
- After booking, clearly summarize the appointment and ask for confirmation.
- If the caller asks general questions about the business (pricing, services, cancellations), answer using the information below:

Policies:
- Cancellation: ${profile.policies.cancellation}
- Location: ${profile.policies.location}

CRITICAL TOOL USAGE RULES:

- If you need to check times or book, you MUST use the tools check_availability and book_appointment.
- Never say "I can't check availability" — always call the check_availability tool instead.
- When a caller asks about availability, you MUST call check_availability before responding.
- When a caller wants to book, you MUST call book_appointment with all required details.
- Use **check_availability** to find free slots BEFORE you propose specific times.
- Use **book_appointment** ONLY after the caller confirms the desired slot.
- If tools return errors (e.g., slot taken), calmly explain and try another time.

If you are unsure about anything, ask the caller a question instead of guessing.
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

