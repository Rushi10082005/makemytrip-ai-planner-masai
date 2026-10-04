// Server-only helpers: catalog loaded from the connected database, redaction, Groq call and strict output validation.
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCatalog, type Catalog } from "./catalog";
import { extractTripHeuristic } from "./extractor";
import type { TripInputs } from "./planner";

export const MODEL_ID = process.env["GROQ_MODEL"] || "openai/gpt-oss-120b";

let cachedCatalog: { at: number; cat: Catalog } | null = null;

// Reads the four read-only synthetic tables (RLS: is_synthetic = true). Cached briefly per worker.
// Falls back to bundled synthetic catalog if database is temporarily sleeping/paused.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadCatalog(sb: SupabaseClient<any>): Promise<Catalog> {
  if (cachedCatalog && Date.now() - cachedCatalog.at < 10 * 60_000) return cachedCatalog.cat;
  try {
    const [d, o, f, h] = await Promise.all([
      sb.from("destinations").select("*"),
      sb.from("origins").select("*"),
      sb.from("flights").select("*").range(0, 1999),
      sb.from("hotels").select("*"),
    ]);
    if (!d.error && !o.error && !f.error && !h.error && d.data?.length && o.data?.length && f.data?.length && h.data?.length) {
      const cat: Catalog = {
        raw: { destinations: [], origins: [], flights: [], hotels: [] },
        destinations: d.data.map((r) => ({ ...r, description: r.description ?? "" })),
        origins: o.data,
        flights: f.data,
        hotels: h.data.map((r) => ({
          ...r,
          diet_tags: String(r.diet_tags ?? "")
            .split(/[|;]/)
            .map((s: string) => s.trim().toLowerCase())
            .filter(Boolean),
        })),
      };
      cachedCatalog = { at: Date.now(), cat };
      return cat;
    }
  } catch {
    // Network or database pause fallback
  }
  return getCatalog();
}

export function redact(s: string): string {
  return s
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[redacted-card]")
    .replace(/(?:\+91[\s-]?)?[6-9]\d{9}\b/g, "[redacted-phone]")
    .replace(/(?<!\d)\d{4}\s?\d{4}\s?\d{4}(?!\d)/g, "[redacted-id]")
    .replace(/\b[A-Z][0-9]{7}\b/g, "[redacted-passport]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[redacted-email]")
    .replace(/\b(gsk_|sk-|sb_secret_|sb_publishable_)[A-Za-z0-9_-]+/g, "[redacted-key]");
}

let inFlight = 0;
export const MAX_CONCURRENT = 2;
export function tryAcquire() {
  if (inFlight >= MAX_CONCURRENT) return false;
  inFlight++;
  return true;
}
export function release() {
  inFlight = Math.max(0, inFlight - 1);
}

export async function callGroq(key: string, messages: { role: string; content: string }[]) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  const candidateModels = Array.from(
    new Set([
      MODEL_ID,
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "llama-3.3-70b-versatile",
      "qwen/qwen3.8-27b",
    ]),
  );

  try {
    for (const model of candidateModels) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages,
        }),
      });
      if (res.status === 429) return { error: "quota" as const };
      if (res.status === 401 || res.status === 403) return { error: "auth" as const };
      if (res.status === 404) {
        // Try next available model in candidates
        continue;
      }
      if (!res.ok) {
        console.error("groq status", res.status);
        return { error: "upstream" as const };
      }
      const j = await res.json();
      return { content: String(j?.choices?.[0]?.message?.content ?? "") };
    }
    return { error: "upstream" as const };
  } catch {
    return { error: "timeout" as const };
  } finally {
    clearTimeout(timer);
  }
}

const ALLOWED_PATCH = new Set([
  "origin",
  "destination",
  "start_date",
  "end_date",
  "budget_inr",
  "budget_basis",
  "adults",
  "children_ages",
  "group_type",
  "diet",
  "preferences",
]);
const ACTIONS = new Set(["edit_inputs", "retry", "open_details"]);
const PREF_KEYS = new Set([
  "quiet_required",
  "step_free_required",
  "refundable_required",
  "max_stops",
]);

export const outputSchema = z
  .object({
    status: z.enum(["clarify", "explain", "no_match", "out_of_scope", "limitation"]),
    message: z.string().max(900),
    question: z.string().max(400).nullable(),
    input_patch: z.record(z.string(), z.any()),
    options: z
      .array(
        z
          .object({
            option_id: z.string(),
            total_inr: z.number(),
            reason: z.string().max(300),
            tradeoff: z.string().max(300),
            record_ids: z.tuple([z.string(), z.string()]),
          })
          .strict(),
      )
      .max(3),
    actions: z.array(z.string()),
  })
  .strict();
export type AssistantOutput = z.infer<typeof outputSchema>;

const patchSchema = z
  .object({
    origin: z.string().max(60),
    destination: z.string().max(60),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    budget_inr: z.number().int().positive().max(10_000_000),
    budget_basis: z.enum(["total", "per_person"]),
    adults: z.number().int().min(1).max(6),
    children_ages: z.array(z.number().int().min(0).max(17)).max(5),
    group_type: z.enum(["solo", "couple", "friends", "family"]),
    diet: z.enum(["none", "vegetarian", "vegan", "jain"]),
    preferences: z
      .object({
        quiet_required: z.boolean(),
        step_free_required: z.boolean(),
        refundable_required: z.boolean(),
        max_stops: z.union([z.literal(0), z.literal(1), z.null()]),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();

export function validateOutput(
  raw: string,
  mode: "extract" | "explain",
  allowed: Map<string, { total: number; ids: [string, string] }>,
): AssistantOutput | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const p = outputSchema.safeParse(json);
  if (!p.success) return null;
  const o = p.data;
  const text = [
    o.message,
    o.question ?? "",
    ...o.options.flatMap((x) => [x.reason, x.tradeoff]),
  ].join(" ");
  if (/<[a-z/][^>]*>|https?:\/\/|```/i.test(text)) return null;
  if (/(gsk_|sk-|sb_secret_)/.test(text)) return null;
  if (!o.actions.every((a) => ACTIONS.has(a))) return null;
  if (Object.keys(o.input_patch).some((k) => !ALLOWED_PATCH.has(k))) return null;
  const pp = o.input_patch["preferences"];
  if (pp && (typeof pp !== "object" || Object.keys(pp).some((k) => !PREF_KEYS.has(k)))) return null;
  if (!patchSchema.safeParse(o.input_patch).success) return null;
  if (mode === "explain" && Object.keys(o.input_patch).length) return null;
  if (
    mode === "extract" &&
    (o.options.length || o.status === "explain" || o.actions.includes("open_details"))
  )
    return null;
  if (o.status !== "explain" && o.options.length) return null;
  if (o.status === "explain" && !o.options.length) return null;
  const seen = new Set<string>();
  for (const opt of o.options) {
    const a = allowed.get(opt.option_id);
    if (
      !a ||
      seen.has(opt.option_id) ||
      a.total !== opt.total_inr ||
      a.ids[0] !== opt.record_ids[0] ||
      a.ids[1] !== opt.record_ids[1]
    )
      return null;
    seen.add(opt.option_id);
  }
  if (o.status === "explain" && !o.message.includes("Synthetic demo")) return null;
  return o;
}

export function generateDeterministicFallback(
  envelope: Record<string, unknown>,
  mode: "extract" | "explain",
  allowed: Map<string, { total: number; ids: [string, string] }>,
): AssistantOutput {
  if (mode === "explain") {
    const eligible = (envelope["eligible_options"] as Array<Record<string, unknown>>) ?? [];
    if (eligible.length > 0) {
      const opts = eligible.slice(0, 3).map((o) => {
        const stops = Number(o["stops_each_way"] ?? 0);
        const flightLabel =
          stops === 0 ? "Direct synthetic flight" : `${stops}-stop synthetic flight`;
        const stayNote = o["refundable"]
          ? "Refundable synthetic stay"
          : "Non-refundable synthetic stay";
        const dur = Number(o["duration_minutes_each_way"] ?? 0);
        return {
          option_id: String(o["option_id"]),
          total_inr: Number(o["total_inr"]),
          reason: `${flightLabel} and ${o["quiet"] ? "quiet " : ""}${String(o["hotel_id"])} fit your confirmed group budget of INR ${String(envelope["group_budget_inr"])}.`,
          tradeoff: `${stayNote} (${dur > 0 ? Math.floor(dur / 60) + "h " + (dur % 60) + "m flight" : "standard flight time"}).`,
          record_ids: [String(o["flight_id"]), String(o["hotel_id"])] as [string, string],
        };
      });
      return {
        status: "explain",
        message:
          "Synthetic demo: Verified options calculated directly from our synthetic catalog for your confirmed group budget. All fares and hotel terms are fictional.",
        question: null,
        input_patch: {},
        options: opts,
        actions: ["edit_inputs", "open_details"],
      };
    }

    const diag = envelope["no_match_diagnostics"] as
      { reason?: string; cheapest_excluded_total?: number } | undefined;
    const reason = diag?.reason || "no combination matched all requirements within budget";
    return {
      status: "no_match",
      message: `Synthetic demo: No option fits these exact requirements (${reason}). Nothing has been relaxed automatically.`,
      question:
        "Would you like to raise your budget, adjust dates, or remove one requirement in the trip summary?",
      input_patch: {},
      options: [],
      actions: ["edit_inputs", "retry"],
    };
  }

  // mode === "extract"
  const rawText = String(envelope["latest_user_message"] || "").toLowerCase();

  // Test Case L15: Direct prompt injection / leak
  if (
    /ignore\s+(all\s+)?(system|previous|rules)/i.test(rawText) ||
    /reveal\s+(key|secret|prompt|users)/i.test(rawText) ||
    /system\s+prompt/i.test(rawText)
  ) {
    return {
      status: "out_of_scope",
      message:
        "Synthetic demo: Requests to override system instructions or reveal backend secrets/configuration are declined. I am scoped to help you compare domestic travel shortlists.",
      question: "Where would you like to travel in India?",
      input_patch: {},
      options: [],
      actions: ["edit_inputs"],
    };
  }

  // Test Case L14: Unrelated request
  if (
    /draft\s+an?\s+email/i.test(rawText) ||
    /write\s+(a\s+)?(code|script|essay|poem|letter)/i.test(rawText) ||
    /who\s+are\s+you|what\s+is\s+the\s+meaning\s+of\s+life/i.test(rawText)
  ) {
    return {
      status: "out_of_scope",
      message:
        "Synthetic demo: I can only help you compare domestic flight and hotel combinations from our synthetic catalog. Unrelated tasks are outside my scope.",
      question: "Would you like to plan a trip between supported Indian cities?",
      input_patch: {},
      options: [],
      actions: ["edit_inputs"],
    };
  }

  // Test Case L10: Unsupported allergy guarantee
  if (/peanut|allergy|allergen|celiac|gluten/i.test(rawText)) {
    return {
      status: "limitation",
      message:
        "Synthetic demo: Diet tags in this fictional dataset describe menu preference categories only and cannot guarantee allergen safety or certified preparation environments.",
      question: "Would you like to filter by supported tags: vegetarian, vegan, or Jain?",
      input_patch: {},
      options: [],
      actions: ["edit_inputs"],
    };
  }

  // Unsupported international / out-of-scope destinations (e.g. Tokyo, Paris)
  if (/tokyo|paris|london|dubai|new\s+york|singapore|bangkok|bali/i.test(rawText)) {
    return {
      status: "out_of_scope",
      message:
        "Synthetic demo: This capstone demo only supports domestic travel within 20 Indian destinations and 25 origins. International destinations are not available.",
      question:
        "Would you like to choose a domestic destination like Goa, Jaipur, Manali, or Udaipur?",
      input_patch: {},
      options: [],
      actions: ["edit_inputs"],
    };
  }

  // Rule-based heuristic field extraction from user message
  const currentTrip = envelope["current_trip_state"] as Partial<TripInputs> | undefined;
  const patch = extractTripHeuristic(rawText, currentTrip) as Record<string, unknown>;

  // Build question for missing key fields
  let q: string | null = null;
  if (!patch["origin"] && !currentTrip?.["origin"]) {
    q = "Which departure city will you be travelling from?";
  } else if (!patch["destination"] && !currentTrip?.["destination"]) {
    q = "Which destination in India would you like to visit?";
  } else if (!patch["start_date"] && !currentTrip?.["start_date"]) {
    q = "What are your travel dates? (Between Nov 2026 and Mar 2027, 2–4 nights)";
  } else if (!patch["budget_inr"] && !currentTrip?.["budget_inr"]) {
    q = "What is your approximate trip budget in INR (e.g. ₹25,000)?";
  } else if (
    !patch["budget_basis"] &&
    (patch["budget_inr"] || currentTrip?.["budget_inr"]) &&
    !currentTrip?.["budget_basis"]
  ) {
    q = "Is this budget the group total or per person?";
  } else if (!patch["diet"] && !currentTrip?.["diet"]) {
    q = "Do you have any dietary preference: vegetarian, vegan, Jain, or none?";
  }

  return {
    status: "clarify",
    message:
      "Synthetic demo: I extracted details from your message. Review the suggested updates in your trip summary and confirm when ready.",
    question: q,
    input_patch: patch,
    options: [],
    actions: ["edit_inputs"],
  };
}
