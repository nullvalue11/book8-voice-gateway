// businessConfig.js

// Map Twilio phone numbers → business config
// Use E.164 format exactly as Twilio sends in req.body.To
export const BUSINESSES_BY_PHONE = {
  "+16477882883": {             // your existing number
    handle: "waismofit",
    displayName: "Wais Mo Fitness",
    greeting: "Hi, this is Wais Mo Fitness. I'm your AI assistant. How can I help you today?",
    language: "en-US",
    ttsVoice: "Polly.Matthew-Neural",   // or your DEFAULT_TTS_VOICE
  },

  // Example future business
  "+15551234567": {
    handle: "cutzbarber",
    displayName: "Cutz Barber Shop",
    greeting: "Hey, thanks for calling Cutz Barber Shop. How can I help you today?",
    language: "en-US",
    ttsVoice: "Polly.Joanna-Neural",
  },
};

export function getBusinessForCall(req) {
  const toNumber = req.body.To;           // number that was called
  const biz = BUSINESSES_BY_PHONE[toNumber];
  return biz || BUSINESSES_BY_PHONE["+16477882883"]; // fallback to Wais
}


