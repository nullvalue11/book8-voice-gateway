# Book8 Voice Gateway - Setup & Architecture

## Overview
Voice gateway that connects Twilio phone calls to Book8 AI agent for automated phone booking. Handles speech-to-text, AI agent communication, and booking creation via Book8 APIs.

## Architecture Flow
```
Twilio Phone Call 
  → /twilio/voice (greeting)
  → /twilio/handle-gather (processes speech)
  → /debug/agent-chat (AI agent with tools)
  → Book8 APIs (/api/agent/availability, /api/agent/book)
  → Response back to caller via TTS
```

## Key Files

### `index.js` - Main Express server
- **Routes:**
  - `GET /` - Home page status
  - `GET /health` - Health check
  - `POST /twilio/voice` - Initial call greeting with Gather
  - `POST /twilio/handle-gather` - Processes speech, calls agent, returns TTS response
  - `POST /debug/agent-chat` - HTTP endpoint for testing agent (text-based)

- **Key Features:**
  - Barge-in enabled (`bargeIn: true`) on all Gather elements for natural interruption
  - `toPhoneSentence()` function shortens replies (max 2 sentences, 220 char cap)
  - Uses `DEFAULT_TTS_VOICE` (Polly.Matthew-Neural) for warmer voice
  - SSML support for natural pauses and prosody

### `agentConfig.js` - Business profile and agent configuration
- **Exports:**
  - `BUSINESS_PROFILE` - Static profile for "waismofit" business
  - `buildSystemPrompt(profile)` - Generates system prompt with today's date and business info
  - `tools` - Tool definitions for `check_availability` and `book_appointment`
  - `getBusinessProfile(handle)` - Returns business profile (currently static)

- **System Prompt Features:**
  - Injects current date (today) for relative date interpretation
  - Explicit instructions to use tools (never say "I can't check availability")
  - Forces immediate booking when intent is clear
  - Phone-friendly conversation style

### `book8Client.js` - Book8 API client
- **Functions:**
  - `checkAvailability({ date, timezone, durationMinutes })` - Calls `/api/agent/availability`
  - `bookAppointment({ start, guestName, guestEmail, guestPhone })` - Calls `/api/agent/book`
- **Headers:** Uses `x-book8-agent-key` header and `agentApiKey` in body

### `llmAgent.js` - Legacy agent implementation (may not be used)
- Currently not used in main flow
- `/debug/agent-chat` uses direct OpenAI calls in `index.js`

## Environment Variables

Required:
- `OPENAI_API_KEY` - OpenAI API key for GPT-4o-mini
- `BOOK8_BASE_URL` - Base URL for Book8 APIs (default: https://book8-ai.vercel.app)
- `BOOK8_AGENT_API_KEY` - API key for Book8 agent endpoints
- `PORT` - Server port (default: 10000)
- `VOICE_AGENT_URL` - URL for agent endpoint (default: https://book8-voice-gateway.onrender.com/debug/agent-chat)
- `TWILIO_TTS_VOICE` - TTS voice (default: Polly.Matthew-Neural)

## Tool Calling Flow

1. **First API call:** Model decides to call tools
   - `check_availability` - Checks calendar availability
   - `book_appointment` - Creates booking

2. **Tool execution:** Gateway executes tools via `book8Client.js`
   - Calls Book8 `/api/agent/availability` or `/api/agent/book`
   - Returns results as tool outputs

3. **Second API call:** Model receives tool results and generates natural language reply

4. **Third API call (if needed):** If model wants to call more tools after seeing results

## Key Design Decisions

1. **Sequential Tool Calls:** Supports multiple rounds of tool calls (check availability → book appointment)
2. **Barge-in Enabled:** All Gather elements have `bargeIn: true` for natural interruption
3. **Phone-Optimized Replies:** `toPhoneSentence()` ensures short, conversational responses
4. **Date Awareness:** System prompt includes today's date to correctly interpret "tomorrow", "next Tuesday", etc.
5. **Hard-coded Handle:** Currently uses "waismofit" - can be made dynamic later via phone number mapping

## Voice Configuration

- **Default Voice:** `Polly.Matthew-Neural` (male, warmer tone)
- **Alternatives:** Polly.Joanna-Neural, Polly.Kendra-Neural, Polly.Joey-Neural, Polly.Salli-Neural
- **SSML:** Simple `<speak>` tags, no complex prosody (keeps it natural)
- **Rate:** Natural speed (no artificial slowing)

## Testing

### HTTP Testing
```powershell
Invoke-RestMethod -Uri "https://book8-voice-gateway.onrender.com/debug/agent-chat" `
  -Method Post -ContentType "application/json" `
  -Body '{"handle": "waismofit", "message": "Book me tomorrow at 11am..."}'
```

### Expected Response
- `toolCalls` array with `check_availability` and `book_appointment`
- `toolOutputs` with Book8 API responses
- `reply` with natural language confirmation

## Deployment

- **Platform:** Render.com
- **Auto-deploy:** On push to master branch
- **URL:** https://book8-voice-gateway.onrender.com
- **Port:** 10000 (configured in Render)

## Current Status

✅ Working:
- Twilio voice webhooks
- Speech-to-text processing
- AI agent with tool calling
- Sequential tool execution (check → book)
- Book8 API integration
- Natural language responses
- Barge-in interruption
- Phone-optimized reply shortening

## Future Enhancements

- Dynamic business profile lookup by phone number
- Session persistence across calls
- Better error recovery
- Call recording/analytics
- Multi-language support

