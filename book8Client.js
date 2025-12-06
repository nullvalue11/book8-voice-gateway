// book8Client.js
import dotenv from "dotenv";

dotenv.config();

const BASE_URL = process.env.BOOK8_BASE_URL;           // e.g. https://book8-ai.vercel.app
const AGENT_API_KEY = process.env.BOOK8_AGENT_API_KEY; // from MongoDB user document

if (!BASE_URL || !AGENT_API_KEY) {
  console.warn("[book8Client] Missing BOOK8_BASE_URL or BOOK8_AGENT_API_KEY");
}

async function postJson(path, body) {
  const url = `${BASE_URL}${path}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-book8-agent-key": AGENT_API_KEY,
    },
    body: JSON.stringify(body ?? {}),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.ok === false) {
    console.error("[book8Client] Error", res.status, data);
    throw new Error(
      data?.error || `Book8 API error ${res.status} for ${path}`
    );
  }

  return data;
}

// Call /api/agent/availability on Book8
export async function checkAvailability({ date, timezone, durationMinutes }) {
  return postJson("/api/agent/availability", {
    date,
    timezone,
    durationMinutes,
  });
}

// Call /api/agent/book on Book8
export async function bookAppointment({
  start,
  guestName,
  guestEmail,
  guestPhone,
}) {
  return postJson("/api/agent/book", {
    start,
    guestName,
    guestEmail,
    guestPhone,
  });
}

