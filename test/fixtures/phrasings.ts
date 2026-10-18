/**
 * Regression fixtures: the phrasings that failed against the real model (paid test, 60 questions x 3
 * repeats). Each case records what the user said and what the model sent to the tool (including the
 * wrong or missing arguments the model really produced), so the code-level fixes can be replayed with
 * no network and no model.
 */

export interface PhrasingCase {
  id: string;
  /** The user's message. */
  message: string;
  tool: string;
  /** The arguments as the model sent them (often wrong). `user_message` is added by the agent. */
  args: Record<string, unknown>;
  /** What was wrong in the real run. */
  failure: string;
}

export const PHRASINGS: PhrasingCase[] = [
  {
    id: "q01-portland-oregon",
    message: "Compare Portland Oregon and Seattle congestion",
    tool: "compare_airports",
    args: { scope: "Washington", user_words: "Portland Oregon and Seattle", metric: "congestion" },
    failure: "model improvised the Washington-state scope; the table was SEA and GEG while the prose discussed Portland",
  },
  {
    id: "q05-top-3",
    message: "Best Pacific airports for expansion, top 3.",
    tool: "rank_airports",
    args: { scope: "Pacific", user_words: "Pacific", metric: "expansion", top_n: 5 },
    failure: "asked for top 3, got 5 rows",
  },
  {
    id: "q11-top-3",
    message: "Top 3 most congested Midwest airports?",
    tool: "rank_airports",
    args: { scope: "Midwest", user_words: "Midwest", metric: "congestion" },
    failure: "asked for top 3, got 5 rows",
  },
  {
    id: "q13-least-congested",
    message: "Which airports in the country are the least congested?",
    tool: "rank_airports",
    args: { scope: "all", user_words: "the country", metric: "congestion" },
    failure: "no ascending option: DFW (the MOST congested) was called the least congested",
  },
  {
    id: "q15-spelled-lax",
    message: "Compare L A X and Santa Ana congestion levels, which one is worse?",
    tool: "compare_airports",
    args: { scope: "L A X and Santa Ana", user_words: "L A X and Santa Ana", metric: "congestion" },
    failure: "the spelled-out code was not read, so a 5-airport Los Angeles metro table came back",
  },
  {
    id: "q34-southwest-at-oakland",
    message: "How did Southwest's flying at Oakland change between 2024 and 2025?",
    tool: "capacity_trend",
    args: { origin: "OAK", group_by: "carrier" },
    failure: "the model quoted Oakland's totals as Southwest's",
  },
  {
    id: "q42-spirit-at-oakland",
    message: "How much did Spirit cut at Oakland?",
    tool: "capacity_trend",
    args: { origin: "OAK", group_by: "carrier" },
    failure: "the model quoted Oakland's totals as Spirit's",
  },
  {
    id: "q35-unrequested-destination",
    message: "Which airlines cut the most seats at Oakland from 2024 to 2025: Southwest, Spirit, Delta?",
    tool: "capacity_trend",
    args: { origin: "OAK", destination: "LAS", group_by: "carrier" },
    failure: "the model added a Las Vegas destination filter the user never asked for",
  },
  {
    id: "q08-dallas-austin",
    message: "Compare Dallas and Austin",
    tool: "compare_airports",
    args: { iatas: ["DFW", "AUS"], user_words: "Dallas and Austin", metric: "congestion" },
    failure: "the model picked DFW itself and bypassed the ambiguity check (DAL and DFW)",
  },
];
