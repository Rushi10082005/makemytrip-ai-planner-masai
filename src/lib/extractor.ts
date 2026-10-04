import type { TripInputs } from "./planner";

const KNOWN_ORIGINS = [
  "Delhi",
  "Mumbai",
  "Bengaluru",
  "Hyderabad",
  "Chennai",
  "Kolkata",
  "Ahmedabad",
  "Pune",
  "Jaipur",
  "Lucknow",
  "Kochi",
  "Goa",
  "Guwahati",
  "Chandigarh",
  "Bhubaneswar",
  "Indore",
  "Nagpur",
  "Varanasi",
  "Thiruvananthapuram",
  "Coimbatore",
  "Udaipur",
  "Mysuru",
  "Amritsar",
  "Rishikesh",
  "Shimla",
  "Manali",
  "Darjeeling",
  "Gangtok",
  "Srinagar",
  "Leh",
  "Agra",
  "Pondicherry",
  "Ooty",
  "Madurai",
  "Puri",
  "Khajuraho",
];

const KNOWN_DESTS = [
  "Goa",
  "Jaipur",
  "Udaipur",
  "Agra",
  "Varanasi",
  "Kochi",
  "Munnar",
  "Alleppey",
  "Manali",
  "Shimla",
  "Srinagar",
  "Amritsar",
  "Rishikesh",
  "Ooty",
  "Pondicherry",
  "Darjeeling",
  "Gangtok",
  "Jaisalmer",
  "Jodhpur",
  "Khajuraho",
];

export function extractTripHeuristic(
  rawText: string,
  currentTrip?: Partial<TripInputs>,
): Partial<TripInputs> {
  const patch: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any

  // 1. Explicit directional matches
  for (const city of KNOWN_ORIGINS) {
    const rx = new RegExp(`\\bfrom\\s+${city}\\b|\\b${city}\\s+to\\b`, "i");
    if (rx.test(rawText)) {
      patch["origin"] = city;
      break;
    }
  }

  for (const city of KNOWN_DESTS) {
    const rx = new RegExp(`\\bto\\s+${city}\\b`, "i");
    if (rx.test(rawText) && patch["origin"] !== city) {
      patch["destination"] = city;
      break;
    }
  }

  // 2. Common Indian city aliases
  if (!patch["origin"]) {
    if (/\bnew\s+delhi\b/i.test(rawText)) patch["origin"] = "Delhi";
    else if (/\bbombay\b/i.test(rawText)) patch["origin"] = "Mumbai";
    else if (/\bbangalore\b/i.test(rawText)) patch["origin"] = "Bengaluru";
    else if (/\bcalcutta\b/i.test(rawText)) patch["origin"] = "Kolkata";
    else if (/\bcochin\b/i.test(rawText)) patch["origin"] = "Kochi";
    else if (/\bmysore\b/i.test(rawText)) patch["origin"] = "Mysuru";
  }

  // 3. Fallback destination matching (if destination not set yet and word appears in text)
  if (!patch["destination"]) {
    for (const city of KNOWN_DESTS) {
      const rx = new RegExp(`\\b${city}\\b`, "i");
      if (rx.test(rawText) && patch["origin"] !== city && currentTrip?.["origin"] !== city) {
        patch["destination"] = city;
        break;
      }
    }
  }

  // 4. Fallback origin matching (if origin not set yet and word appears in text)
  if (!patch["origin"]) {
    for (const city of KNOWN_ORIGINS) {
      const rx = new RegExp(`\\b${city}\\b`, "i");
      if (rx.test(rawText) && patch["destination"] !== city && currentTrip?.["destination"] !== city) {
        patch["origin"] = city;
        break;
      }
    }
  }

  const monthMap: Record<string, string> = {
    nov: "2026-11",
    dec: "2026-12",
    jan: "2027-01",
    feb: "2027-02",
    mar: "2027-03",
  };

  // Dates: look for ISO dates (YYYY-MM-DD)
  const isoDates = rawText.match(/\b(202\d-\d{2}-\d{2})\b/g);
  if (isoDates && isoDates.length >= 2) {
    patch["start_date"] = isoDates[0];
    patch["end_date"] = isoDates[1];
  } else {
    // Look for e.g. "10-13 nov" or "10 to 13 nov" or "10-13 november"
    const dmMatch = rawText.match(
      /\b(\d{1,2})\s*(?:to|-|–)\s*(\d{1,2})\s*(nov|dec|jan|feb|mar)[a-z]*/i,
    );
    if (dmMatch && dmMatch[1] && dmMatch[2] && dmMatch[3]) {
      const mPrefix = monthMap[dmMatch[3].slice(0, 3).toLowerCase()];
      if (mPrefix) {
        const d1 = String(dmMatch[1]).padStart(2, "0");
        const d2 = String(dmMatch[2]).padStart(2, "0");
        patch["start_date"] = `${mPrefix}-${d1}`;
        patch["end_date"] = `${mPrefix}-${d2}`;
      }
    } else {
      // Look for individual date mentions, e.g. "4 nov 2026 and return on 10 nov 2026"
      const dateMatches = Array.from(
        rawText.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(nov|dec|jan|feb|mar)[a-z]*(?:\s+(202[67]))?\b/gi),
      );
      const mFirst = dateMatches[0];
      const mSecond = dateMatches[1];
      if (mFirst && mSecond && mFirst[1] && mFirst[2] && mSecond[1] && mSecond[2]) {
        const d1 = String(mFirst[1]).padStart(2, "0");
        const m1 = mFirst[2].slice(0, 3).toLowerCase();
        const y1 = mFirst[3] || (m1 === "nov" || m1 === "dec" ? "2026" : "2027");

        const d2 = String(mSecond[1]).padStart(2, "0");
        const m2 = mSecond[2].slice(0, 3).toLowerCase();
        const y2 = mSecond[3] || (m2 === "nov" || m2 === "dec" ? "2026" : "2027");

        const mNum1 = m1 === "nov" ? "11" : m1 === "dec" ? "12" : m1 === "jan" ? "01" : m1 === "feb" ? "02" : "03";
        const mNum2 = m2 === "nov" ? "11" : m2 === "dec" ? "12" : m2 === "jan" ? "01" : m2 === "feb" ? "02" : "03";

        patch["start_date"] = `${y1}-${mNum1}-${d1}`;
        patch["end_date"] = `${y2}-${mNum2}-${d2}`;
      }
    }
  }

  // Budget
  const budgetMatch = rawText.match(
    /(?:(?:₹|inr|rs\.?|budget\s*(?:is|of|:)?)\s*(\d[\d,]*))|(\d[\d,]*)\s*(?:₹|inr|rs\.?|total|budget)/i,
  );
  if (budgetMatch) {
    const numStr = (budgetMatch[1] ?? budgetMatch[2] ?? "").replace(/,/g, "");
    const val = parseInt(numStr, 10);
    if (!isNaN(val) && val > 0 && val <= 10000000) {
      patch["budget_inr"] = val;
    }
  }

  if (/\bper\s+person\b/i.test(rawText)) {
    patch["budget_basis"] = "per_person";
  } else if (/\btotal\b|\bgroup\s+total\b/i.test(rawText)) {
    patch["budget_basis"] = "total";
  }

  // Travellers & party
  if (/\bsolo\b/i.test(rawText)) {
    patch["adults"] = 1;
    patch["group_type"] = "solo";
  } else if (/\bcouple\b/i.test(rawText)) {
    patch["adults"] = 2;
    patch["group_type"] = "couple";
  } else if (/\bfamily\b/i.test(rawText)) {
    patch["group_type"] = "family";
  } else if (/\bfriends\b/i.test(rawText)) {
    patch["group_type"] = "friends";
  }

  const adultMatch = rawText.match(/\b(\d+)\s*(?:adult|grown-up|traveller|person|people)\b/i);
  if (adultMatch && adultMatch[1]) {
    const count = parseInt(adultMatch[1], 10);
    if (count >= 1 && count <= 6) patch["adults"] = count;
  }

  // Diet
  if (/\bjain\b/i.test(rawText)) patch["diet"] = "jain";
  else if (/\bvegan\b/i.test(rawText)) patch["diet"] = "vegan";
  else if (/\bveg\b|\bvegetarian\b/i.test(rawText)) patch["diet"] = "vegetarian";

  // Preferences
  const prefs: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (/\bquiet\b/i.test(rawText)) prefs["quiet_required"] = true;
  if (/\bstep[- ]free\b|\bwheelchair\b|\belevator\b/i.test(rawText)) prefs["step_free_required"] = true;
  if (/\brefundable\b/i.test(rawText)) prefs["refundable_required"] = true;
  if (/\bdirect\s*(?:only|flight)?\b|\bnon[- ]stop\b/i.test(rawText)) prefs["max_stops"] = 0;
  if (Object.keys(prefs).length > 0) {
    patch["preferences"] = { ...(currentTrip?.preferences ?? {}), ...prefs };
  }

  return patch as Partial<TripInputs>;
}

export function formatExtractionNotice(patch: Partial<TripInputs>): { message: string; question: string | null } {
  const parts: string[] = [];
  if (patch.origin) parts.push(`Origin: ${patch.origin}`);
  if (patch.destination) parts.push(`Destination: ${patch.destination}`);
  if (patch.start_date && patch.end_date) parts.push(`Dates: ${patch.start_date} to ${patch.end_date}`);
  if (patch.budget_inr) parts.push(`Budget: ₹${patch.budget_inr.toLocaleString("en-IN")}`);
  if (patch.adults) parts.push(`Adults: ${patch.adults}`);

  const details = parts.length > 0 ? parts.join(", ") : "your request";
  const message = `I've updated your trip parameters (${details}). You can edit any field on the right at any time.`;

  let question: string | null = null;
  if (!patch.destination) {
    question = "Which domestic destination would you like to travel to?";
  } else if (!patch.start_date || !patch.end_date) {
    question = "What dates will you be travelling? (2–4 nights between Nov 2026 and Mar 2027)";
  } else if (!patch.budget_inr) {
    question = "What is your approximate budget in INR for this trip?";
  }

  return { message, question };
}
