/**
 * A cheap code check for requests that are plainly not about U.S. airports (write me a poem, a
 * recipe, a joke). The model has been seen to just do the task, so these are answered with a
 * fixed friendly line before any model call: no cost, no drift. Anything that mentions airports,
 * flights, routes, airlines or a known airport code goes to the model as usual.
 */

import * as data from "./data";
import { carriersNamedIn } from "./carriers";

const CREATIVE_TASK =
  /\b(poem|poetry|haiku|limerick|sonnet|song lyrics|lyrics|short story|bedtime story|story about|joke|riddle|recipe|essay|rap about|write a (?:poem|story|song|joke))\b/i;

const AVIATION =
  /\b(airport|airports|airline|airlines|flight|flights|route|routes|runway|terminal|aviation|passenger|passengers|carrier|carriers|delay|delays|congestion|congested|traffic|growth|growing|expansion|layover|boarding|aircraft|plane|planes)\b/i;

/** Cities, codes and names of the dataset's airports: a message that names one is about airports, whatever it asks for. */
let placeWords: Set<string> | null = null;
const namesAnAirportPlace = (message: string): boolean => {
  placeWords ??= new Set(
    data.allAirports().flatMap((a) => [a.iata.toLowerCase(), ...a.city.toLowerCase().split(/[-/,]/).map((part) => part.trim())]),
  );
  const padded = ` ${message.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return [...placeWords].some((word) => word.length >= 3 && padded.includes(` ${word} `));
};

export const OFF_TOPIC_REPLY =
  "That one's outside my lane: I'm here for U.S. airport analysis. I can rank airports for expansion, compare two airports, or look at routes and airlines. Want to try one?";

/** The fixed reply when the message is a creative-writing style request with nothing to do with airports; otherwise null. */
export function offTopicReply(message: string): string | null {
  if (!CREATIVE_TASK.test(message) || AVIATION.test(message)) return null;
  if (namesAnAirportPlace(message) || carriersNamedIn(message).length > 0) return null;
  const words = message.toUpperCase().match(/\b[A-Z]{3}\b/g) ?? [];
  if (words.some((word) => data.getAirport(word))) return null;
  return OFF_TOPIC_REPLY;
}
