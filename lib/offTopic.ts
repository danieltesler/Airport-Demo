/**
 * Requests answered by code with a fixed line, before any model call: no cost, no drift.
 *
 * Red-team runs showed the model will tell an airport joke, offer to analyse election candidates,
 * suggest a medication, decode and parrot a base64 instruction, and claim "I was created by OpenAI".
 * Prompt wording did not stop any of these, so each is caught here by a plain pattern:
 *  - an explicit ask for a joke, poem, song, riddle or recipe (always refused), or other creative
 *    writing with nothing about airports in it;
 *  - personal advice ("what medication should I take", "who should I vote for"), or a political,
 *    medical or legal topic with nothing about airports in it;
 *  - an encoded blob (base64 and the like): the agent only reads plain-language questions;
 *  - a question about the assistant itself ("are you ChatGPT", "who built you", "what model are you"):
 *    one honest, fixed answer. "Which model is this expansion score based on?" is about the scoring
 *    method and goes to the model.
 * The regression run (Daredevil, 2026-10-22) found the first version refusing real airport questions
 * ("Diagnose the delay problem at JFK", "Is the Delta lawsuit visible in ATL seat numbers?"), so every
 * topic gate below steps aside when the message is about airports. See lib/redTeam.test.ts for the
 * phrasings that must be blocked and those that must be allowed.
 */

import * as data from "./data";
import { carriersNamedIn } from "./carriers";

export const OFF_TOPIC_REPLY =
  "That one's outside my lane: I'm here for U.S. airport analysis. I can rank airports for expansion, compare two airports, or look at routes and airlines. Want to try one?";

export const ADVICE_REPLY =
  "I can't help with political, medical or legal questions; I'm here for U.S. airport analysis. If it's a medical emergency, tell the crew or call emergency services.";

export const ENCODED_REPLY =
  "I only read plain-language questions about U.S. airports. Ask me in words, for example: which airports in Texas are strongest for expansion?";

export const IDENTITY_REPLY =
  "I'm the Airport Investment Intelligence assistant built for this demo. A language model from OpenAI picks which tools to run and writes the wording; every figure comes from deterministic tools over public BTS data, and code checks each number before you see it.";

// --------------------------------------------------------------------------- //
// Is the message about airports?
// --------------------------------------------------------------------------- //

const AVIATION =
  /\b(airport|airports|airline|airlines|flight|flights|route|routes|runway|runways|terminal|aviation|passenger|passengers|carrier|carriers|delay|delays|congestion|congested|traffic|growth|growing|expansion|layover|boarding|aircraft|plane|planes|seat|seats|hub|hubs|slot|slots|faa|tsa|load factor)\b/i;

/** Hebrew aviation words: airport(s), flight(s), passengers, airline, seats, delays, traffic, growth, expansion. */
const HEBREW_AVIATION = /שד(?:ה|ות) תעופה|נמל(?:י)? תעופה|טיס(?:ה|ות)|נוסעים|חבר(?:ת|ות) תעופה|מושבים|עיכובים|תנועה|צמיחה|הרחבה/;

/** Cities, codes and names of the dataset's airports: a message that names one is about airports, whatever it asks for. */
let placeWords: Set<string> | null = null;
const namesAnAirportPlace = (message: string): boolean => {
  placeWords ??= new Set(
    data.allAirports().flatMap((a) => [a.iata.toLowerCase(), ...a.city.toLowerCase().split(/[-/,]/).map((part) => part.trim())]),
  );
  const padded = ` ${message.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return [...placeWords].some((word) => word.length >= 3 && padded.includes(` ${word} `));
};

function aboutAirports(message: string): boolean {
  if (AVIATION.test(message) || HEBREW_AVIATION.test(message) || namesAnAirportPlace(message)) return true;
  if (carriersNamedIn(message).length > 0) return true;
  const words = message.toUpperCase().match(/\b[A-Z]{3}\b/g) ?? [];
  return words.some((word) => Boolean(data.getAirport(word)));
}

// --------------------------------------------------------------------------- //
// Creative tasks
// --------------------------------------------------------------------------- //

/**
 * An explicit ask for a joke, poem, song, riddle or recipe: refused even when it names an airport ("tell me a joke about
 * ATL" was answered with a joke). "A riddle-free answer" and "a joke-free summary" do not match (no hyphen after the noun).
 */
const ENTERTAINMENT_REQUEST =
  /\b(?:write|compose|tell|give|make|sing|do)\b(?:\s+(?:me|us))?(?:\s+(?:a|an|another|one|some))?(?:\s+(?:short|funny|quick|little|bedtime|good))?\s+(?:poem|poems|haiku|limerick|sonnet|song|songs|rap|joke|jokes|riddle|lyrics|recipe)\b(?!-)|\b(?:joke|jokes|poem|haiku|limerick|riddle)\s+about\b/i;

/** The Hebrew equivalent: a "write / tell / give me" verb before joke, poem/song, riddle or recipe. */
const HEBREW_ENTERTAINMENT_REQUEST =
  /(?:^|\s)ו?(?:כתוב|תכתוב|כתבי|תכתבי|ספר|תספר|ספרי|תספרי|תן|תני)(?:\s+(?:לי|לנו))?\s+(?:\S+\s+)?(?:בדיחה|בדיחות|שיר|שירים|חידה|מתכון)(?=$|[\s?.!,])/;

/** Other creative writing ("a short story", "an essay"): refused only when nothing in the message is about airports. */
const CREATIVE_TASK =
  /\b(poem|poetry|haiku|limerick|sonnet|song lyrics|lyrics|short story|bedtime story|story about|joke|riddle|recipe|essay|rap about|write a (?:poem|story|song|joke))\b(?!-)/i;

/** The fixed reply for a creative request (see above); otherwise null. */
export function offTopicReply(message: string): string | null {
  if (ENTERTAINMENT_REQUEST.test(message) || HEBREW_ENTERTAINMENT_REQUEST.test(message)) return OFF_TOPIC_REPLY;
  if (CREATIVE_TASK.test(message) && !aboutAirports(message)) return OFF_TOPIC_REPLY;
  return null;
}

// --------------------------------------------------------------------------- //
// Advice, encoded text, identity
// --------------------------------------------------------------------------- //

/** Asking for personal advice: refused even when an airport or flight is mentioned ("chest pain on my flight to ATL"). */
const PERSONAL_ADVICE =
  /\b(?:what|which) (?:medication|medications|medicine|pill|pills|drug|drugs) should (?:i|we)\b|\bshould i (?:take|see a doctor|sue|vote)\b|\bwho should (?:i|we) vote\b|\bi (?:have|feel|got) (?:a |an )?(?:chest pain|headache|fever|pain|symptoms?|rash|nausea)\b|\bhow (?:do|can|should) (?:i|we) sue\b|\bdraft (?:the|a|my|our) (?:legal )?(?:claim|lawsuit|complaint)\b|\b(?:give|need) (?:me )?(?:medical|legal) advice\b/i;

/** Political, medical and legal topics: refused only when nothing in the message is about airports. */
const ADVICE_TOPIC =
  /\b(vote|voting|election|elections|democrats?|republicans?|medication|medications|medicine|medical advice|symptoms?|chest pain|diagnos\w*|dosage|prescri\w*|lawsuit|sue|suing|lawyer|attorney|legal (?:claim|advice))\b/i;

/** A run of 40+ base64 characters with no spaces, mixing upper and lower case; slash-separated airport codes are removed first. */
const AIRPORT_CODE_LIST = /\b[A-Za-z]{3}(?:\/[A-Za-z]{3})+\b/g;
const ENCODED_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;
const looksEncoded = (message: string): boolean =>
  (message.replace(AIRPORT_CODE_LIST, " ").match(ENCODED_RUN) ?? []).some((run) => /[a-z]/.test(run) && /[A-Z]/.test(run));

/** Questions about the assistant itself, never about a scoring model ("which model is this expansion score based on?"). */
const IDENTITY_QUESTION =
  /\bare you (?:chat ?gpt|gpt|openai|claude|gemini|an? (?:ai|bot|chatbot|llm|language model|robot|human|real person))\b|\bwho (?:built|made|created|developed|trained|programmed|designed) you\b|\b(?:what|which) (?:ai |language |llm |gpt )?model are you\s*(?:running(?: on)?|built on|based on)?\s*[?.!]*$|\b(?:what|which) (?:ai|language|llm|gpt) model (?:do you use|powers you|are you (?:running|built|based) on|is behind you)\b|\bwhat are you (?:built|running) on\s*[?.!]*$/i;

/** Every request code answers with a fixed line (see the header), or null to let the model answer. */
export function cannedReply(message: string): string | null {
  if (looksEncoded(message)) return ENCODED_REPLY;
  if (IDENTITY_QUESTION.test(message)) return IDENTITY_REPLY;
  if (PERSONAL_ADVICE.test(message)) return ADVICE_REPLY;
  if (ADVICE_TOPIC.test(message) && !aboutAirports(message)) return ADVICE_REPLY;
  return offTopicReply(message);
}
