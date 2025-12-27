# Prompt for Next Chat Session

Copy and paste this into your next chat:

---

**I'm working on the Book8 Voice Gateway project. Please read `VOICE_GATEWAY_SETUP.md` first to understand the full architecture and current state of the system.**

**Project Overview:**
This is a voice gateway that connects Twilio phone calls to Book8 AI agent for automated phone booking. The system handles speech-to-text, AI agent communication with tool calling (check_availability and book_appointment), and returns natural language responses via TTS.

**Key Architecture:**
- Twilio phone calls → `/twilio/voice` (greeting) → `/twilio/handle-gather` (processes speech)
- Speech is sent to `/debug/agent-chat` which uses OpenAI GPT-4o-mini with tool calling
- Tools call Book8 APIs (`/api/agent/availability` and `/api/agent/book`)
- Responses are shortened via `toPhoneSentence()` function and returned as TTS

**Recent Work Completed:**
- ✅ Implemented sequential tool calling (check availability → book appointment)
- ✅ Added phone-optimized reply shortening (max 2 sentences, 220 char cap)
- ✅ Enabled barge-in on all Gather elements for natural interruption
- ✅ Configured TTS with Polly.Matthew-Neural voice
- ✅ Added sentence splitting for shorter, more natural responses
- ✅ System prompt includes today's date for correct date interpretation
- ✅ Book8 API integration with proper authentication

**Current Status:**
- Deployed on Render.com at https://book8-voice-gateway.onrender.com
- All core functionality working (voice calls, agent, tool calling, booking)
- Using hard-coded handle "waismofit" (can be made dynamic later)

**Key Files:**
- `index.js` - Main Express server with Twilio webhooks and agent endpoint
- `agentConfig.js` - Business profile, system prompt builder, tool definitions
- `book8Client.js` - Book8 API client (checkAvailability, bookAppointment)
- `VOICE_GATEWAY_SETUP.md` - Full documentation

**Important Patterns:**
- Tool calling supports multiple sequential rounds (model can call check_availability, see results, then call book_appointment)
- All Twilio Gather elements have `bargeIn: true` for interruption
- Replies are aggressively shortened for phone conversations
- System prompt forces immediate booking when intent is clear (no unnecessary confirmations)

**Environment Variables Needed:**
- `OPENAI_API_KEY` - For GPT-4o-mini
- `BOOK8_BASE_URL` - Default: https://book8-ai.vercel.app
- `BOOK8_AGENT_API_KEY` - For Book8 API authentication
- `PORT` - Default: 10000
- `VOICE_AGENT_URL` - Default: https://book8-voice-gateway.onrender.com/debug/agent-chat
- `TWILIO_TTS_VOICE` - Default: Polly.Matthew-Neural

**What I need help with:**
[Describe your next task here]

---



