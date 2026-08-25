/**
 * Bilingual (English / Hebrew) strings for the deterministic transparency layer.
 *
 * The assumptions, uncertainty, and panel labels are owned by the code — not the
 * LLM — so they stay trustworthy and consistent. Keeping them here (rather than
 * asking the model to translate) means the Hebrew and English wording are both
 * reviewed and fixed. The agent detects the user's language and the scoring/tools
 * layers return the matching strings.
 */

export type Lang = "en" | "he";

// Hebrew Unicode block (U+0590–U+05FF), written as escapes so detection is robust
// regardless of source-file encoding.
const HEBREW_PATTERN = /[֐-׿]/;

/** Pick a language from free text: any Hebrew letter → Hebrew, else English. */
export function detectLang(text: string): Lang {
  return HEBREW_PATTERN.test(text) ? "he" : "en";
}

/** Text direction for a piece of text: Hebrew → right-to-left, else left-to-right. */
export function dirFor(text: string): "rtl" | "ltr" {
  return HEBREW_PATTERN.test(text) ? "rtl" : "ltr";
}

interface BiList {
  en: string[];
  he: string[];
}
interface Bi {
  en: string;
  he: string;
}

export const ASSUMPTIONS: {
  congestion: BiList;
  unmet: BiList;
  expansion: BiList;
} = {
  congestion: {
    en: [
      "Congestion is proxied by operational strain: departure delays, the share of " +
        "flights delayed >15 min, cancellations, and seat load factor.",
      "Metrics are compared as rates (per-flight / per-seat), not totals, so large " +
        "hubs and small airports are judged on the same footing.",
    ],
    he: [
      "העומס נאמד לפי מדדי לחץ תפעולי: עיכובי המראה, שיעור הטיסות שעוכבו מעל 15 דקות, " +
        "ביטולים, ומקדם התפוסה של המושבים.",
      "המדדים מושווים כשיעורים (לכל טיסה / לכל מושב) ולא כסכומים מוחלטים, כך שנמלים " +
        "גדולים וקטנים נמדדים באותו קנה מידה.",
    ],
  },
  unmet: {
    en: [
      "'Unmet demand' has no direct public measurement (bookings that never happened " +
        "aren't observable in free data). We estimate it as a composite lower-bound proxy.",
      "Load factor is the primary signal: sustained high seat utilization implies " +
        "demand that current supply cannot absorb.",
      "Growth measured against roughly fixed runway capacity indicates a widening gap.",
    ],
    he: [
      "ל'ביקוש שאינו נענה' אין מדידה ציבורית ישירה (הזמנות שמעולם לא בוצעו אינן נראות " +
        "בנתונים חופשיים). אנו אומדים אותו כמדד-קירוב מורכב המהווה חסם תחתון.",
      "מקדם התפוסה הוא הסימן המרכזי: ניצול מושבים גבוה ומתמשך מעיד על ביקוש שההיצע " +
        "הנוכחי אינו יכול לספוג.",
      "גידול הנמדד אל מול קיבולת מסלולים קבועה יחסית מצביע על פער שהולך וגדל.",
    ],
  },
  expansion: {
    en: [
      "Investment thesis: terminal expansion is most profitable where strong, growing " +
        "demand meets a capacity-constrained airport — so renovation unlocks revenue " +
        "rather than adding idle space.",
      "Score blends demand growth, current congestion, seat load pressure, and passenger " +
        "volume; weights are documented and adjustable.",
      "Airport scope is limited to the bundled dataset (major + selected mid-size U.S. airports).",
    ],
    he: [
      "תזת ההשקעה: הרחבת טרמינל רווחית ביותר במקום שבו ביקוש חזק וגדל פוגש נמל תעופה " +
        "מוגבל-קיבולת — כך שהשיפוץ משחרר הכנסה במקום להוסיף שטח לא מנוצל.",
      "הציון משלב גידול בביקוש, עומס נוכחי, לחץ תפוסת מושבים ונפח נוסעים; המשקלים " +
        "מתועדים וניתנים לכוונון.",
      "היקף הנמלים מוגבל למאגר הנתונים המצורף (נמלים מרכזיים ובינוניים נבחרים בארה״ב).",
    ],
  },
};

export const UNCERTAINTY: { congestion: Bi; unmet: Bi; expansion: Bi } = {
  congestion: {
    en:
      "Delay data reflects annual averages; short-term peaks (holidays, weather events) " +
      "are smoothed out. Delays also mix weather with true capacity saturation.",
    he:
      "נתוני העיכובים משקפים ממוצעים שנתיים; שיאים קצרי-טווח (חגים, אירועי מזג אוויר) " +
      "מוחלקים. כמו כן, עיכובים מערבבים בין מזג אוויר לבין רוויית קיבולת אמיתית.",
  },
  unmet: {
    en:
      "This is a lower-bound proxy. True unmet demand (searches that didn't convert, " +
      "fares that priced people out) requires proprietary GDS/OAG data not available for free.",
    he:
      "זהו מדד-קירוב של חסם תחתון. ביקוש שאינו נענה אמיתי (חיפושים שלא הבשילו להזמנה, " +
      "מחירים שתמחרו נוסעים החוצה) מצריך נתוני GDS/OAG קנייניים שאינם זמינים בחינם.",
  },
  expansion: {
    en:
      "Score reflects demand-side opportunity only. It does not model construction cost, " +
      "land/gate availability, or local regulatory limits (e.g. noise curfews), which a " +
      "full investment case would weigh.",
    he:
      "הציון משקף הזדמנות מצד הביקוש בלבד. הוא אינו ממדל עלויות בנייה, זמינות קרקע/שערים, " +
      "או מגבלות רגולטוריות מקומיות (למשל עוצר רעש), שאותם ניתוח השקעה מלא היה שוקל.",
  },
};

/** Dataset-scope assumption (dynamic airport count). */
export function scopeAssumption(count: number, lang: Lang): string {
  return lang === "he"
    ? `היקף מאגר הנתונים מוגבל ל-${count} נמלי תעופה בארה״ב.`
    : `Dataset scope is limited to ${count} U.S. airports.`;
}

/** Haul-mix assumptions (dynamic distance thresholds). */
export function haulAssumptions(
  t: { short_max: number; long_min: number },
  lang: Lang,
): string[] {
  if (lang === "he") {
    return [
      `סיווג טווח הטיסה נקבע לפי מרחק המסלול (מעגל גדול) מנתוני T-100: קצר <${t.short_max} ` +
        `מייל, בינוני ${t.short_max}-${t.long_min} מייל, ארוך >${t.long_min} מייל.`,
      "האחוזים הם נתחים מתוך ההמראות שבוצעו, ולא מתוך נוסעים או מושבים.",
    ];
  }
  return [
    `Haul class is by great-circle route distance from T-100 segment data: short ` +
      `<${t.short_max} mi, medium ${t.short_max}-${t.long_min} mi, long >${t.long_min} mi.`,
    "Percentages are shares of departures performed, not passengers or seats.",
  ];
}

/** Assumptions and caveat for the live flights tool. */
export function liveFlightsAssumptions(lang: Lang): string[] {
  if (lang === "he") {
    return [
      "המיקומים בזמן אמת מגיעים מעדכון ADS-B קהילתי (adsb.lol), עבור מטוסים ברדיוס של " +
        "כ-30 מייל ימי סביב הנמל ברגע השאלה.",
      "הכיסוי תלוי בקולטנים סמוכים, ולכן הספירה היא חסם תחתון לתנועה בפועל; מטוסים על " +
        "הקרקע נספרים בנפרד.",
    ];
  }
  return [
    "Live positions come from a community ADS-B feed (adsb.lol), for aircraft within " +
      "about 30 nautical miles of the airport at the moment you asked.",
    "Coverage depends on nearby receivers, so the count is a lower bound on real " +
      "traffic; aircraft on the ground are counted separately.",
  ];
}

export const LIVE_FLIGHTS_UNCERTAINTY: Bi = {
  en:
    "This is a real-time snapshot, not a schedule — the numbers change minute to " +
    "minute, and low-altitude or non-ADS-B aircraft may be missed.",
  he:
    "זהו תצלום מצב בזמן אמת, לא לוח זמנים — המספרים משתנים מדקה לדקה, ומטוסים בגובה " +
    "נמוך או ללא ADS-B עלולים להישמט.",
};

/** UI labels for the assumptions & uncertainty panel. */
export const PANEL_LABELS = {
  title: { en: "Assumptions & uncertainty", he: "הנחות ואי-ודאות" },
  assumptions: { en: "Assumptions", he: "הנחות" },
  uncertainty: { en: "Uncertainty", he: "אי-ודאות" },
  dataVintage: { en: "Data vintage", he: "מקור הנתונים" },
  tools: { en: "Tools", he: "כלים" },
} as const;
