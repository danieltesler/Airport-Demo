// Lists the default ElevenLabs voices (name, id, description) so one can be picked for
// ELEVENLABS_VOICE_ID. Run: node --env-file=.env.local scripts/list-elevenlabs-voices.mjs
// The key is read from the environment and is never printed.

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
  console.error("Set ELEVENLABS_API_KEY in .env.local first.");
  process.exit(1);
}

const response = await fetch("https://api.elevenlabs.io/v2/voices?voice_type=default&page_size=100", {
  headers: { "xi-api-key": apiKey },
});
if (!response.ok) {
  console.error(`ElevenLabs returned ${response.status}.`);
  process.exit(1);
}

const { voices } = await response.json();
for (const voice of voices) {
  const labels = Object.values(voice.labels ?? {}).join(", ");
  console.log(`${voice.name}\t${voice.voice_id}\t${labels}`);
}
