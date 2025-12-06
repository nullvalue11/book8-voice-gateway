// server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import twilio from "twilio";
const { twiml: Twiml } = twilio;

// Load env vars
dotenv.config();

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false })); // For Twilio form-encoded body
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- NEW HOME ROUTE (fixes "Not Found" in browser) ---
app.get("/", (req, res) => {
  res.send(`
    <h1>Book8 Voice Gateway</h1>
    <p>Status: <strong>Running</strong></p>
    <p>Twilio Webhook: <code>POST /twilio/voice</code></p>
  `);
});

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "book8-voice-gateway" });
});

// Twilio voice webhook
app.post("/twilio/voice", (req, res) => {
  console.log("Incoming call from:", req.body.From);

  const response = new Twiml.VoiceResponse();
  response.say(
    {
      voice: "Polly.Amy-Neural",
      language: "en-US"
    },
    "Thanks for calling Book Eight. Your voice gateway is working."
  );

  res.type("text/xml");
  res.send(response.toString());
});

// Fallback for unknown routes
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`Voice gateway listening on port ${PORT}`);
});
