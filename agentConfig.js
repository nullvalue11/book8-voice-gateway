// agentConfig.js

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

Tool usage:

- Use **check_availability** to find free slots BEFORE you propose specific times.
- Use **book_appointment** ONLY after the caller confirms the desired slot.
- If tools return errors (e.g., slot taken), calmly explain and try another time.

If you are unsure about anything, ask the caller a question instead of guessing.
`;
}

// Tool schemas the Realtime model will use.
// Your Realtime client will register these.
export const TOOLS = [
  {
    name: "check_availability",
    description: "Check available booking slots for a given date and service duration.",
    parameters: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Date in ISO format YYYY-MM-DD in the business timezone."
        },
        durationMinutes: {
          type: "integer",
          description: "Desired appointment duration in minutes."
        }
      },
      required: ["date", "durationMinutes"]
    }
  },
  {
    name: "book_appointment",
    description: "Book an appointment in Book8 for the caller.",
    parameters: {
      type: "object",
      properties: {
        start: {
          type: "string",
          description: "Start datetime in ISO 8601, in the business timezone."
        },
        serviceId: {
          type: "string",
          description: "ID of the chosen service (e.g. 'consult_30')."
        },
        guestName: {
          type: "string",
          description: "Full name of the caller."
        },
        guestPhone: {
          type: "string",
          description: "Phone number of the caller in E.164 format if possible."
        },
        guestEmail: {
          type: "string",
          description: "Email if the caller provides it (optional)."
        }
      },
      required: ["start", "serviceId", "guestName", "guestPhone"]
    }
  }
];

// Helper to map a service label → duration (for the tools)
export function getServiceById(profile, serviceId) {
  return profile.services.find(s => s.id === serviceId) || null;
}

