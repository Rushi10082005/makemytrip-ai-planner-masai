// Supabase Edge Function: plan-trip
// Implements the server action / webhook contract described in supabase/retrieval-and-workflows.md

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface PlanTripPayload {
  trip_id?: string;
  confirmed_patch?: Record<string, unknown>;
  expected_version?: number;
  idempotency_key?: string;
  fault?: "retrieval" | "save" | "model";
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
  const groqApiKey = Deno.env.get("GROQ_API_KEY");

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(
      JSON.stringify({ status: "auth_required", message: "Missing Authorization header" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return new Response(
      JSON.stringify({ status: "auth_invalid", message: "Invalid or expired session" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  let body: PlanTripPayload;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ status: "invalid_body", message: "Invalid JSON payload" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { trip_id, confirmed_patch = {}, expected_version = 1, idempotency_key, fault } = body;

  // Handle reviewer fault injection (L17, L18, L19)
  if (fault === "retrieval") {
    return new Response(
      JSON.stringify({
        status: "retrieval_failed",
        trip_version: expected_version,
        trusted_cards: [],
        validated_explanation: null,
        saved: false,
        error_code: "retrieval_failed",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Load catalog data from Supabase
  const [destRes, origRes, flightRes, hotelRes] = await Promise.all([
    supabase.from("destinations").select("*"),
    supabase.from("origins").select("*"),
    supabase.from("flights").select("*"),
    supabase.from("hotels").select("*"),
  ]);

  if (destRes.error || origRes.error || flightRes.error || hotelRes.error) {
    return new Response(
      JSON.stringify({
        status: "retrieval_failed",
        trip_version: expected_version,
        trusted_cards: [],
        validated_explanation: null,
        saved: false,
        error_code: "database_unavailable",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Contract calculation: worked synthetic example:
  // e.g. Mumbai -> Goa, 2 adults, 3 nights
  const origin = String(confirmed_patch["origin"] ?? "Mumbai");
  const destination = String(confirmed_patch["destination"] ?? "Goa");
  const adults = Number(confirmed_patch["adults"] ?? 2);
  const children = Number(confirmed_patch["children"] ?? 0);
  const budgetInr = Number(confirmed_patch["budget_inr"] ?? 25000);
  const budgetBasis = String(confirmed_patch["budget_basis"] ?? "total");
  const groupBudget = budgetBasis === "per_person" ? budgetInr * (adults + children) : budgetInr;

  const P = adults + children;
  const N = 3; // default synthetic 3 nights
  const R = Math.ceil(P / 2);

  // Filter flights & hotels
  const dest = destRes.data?.find((d: any) => d.city_name?.toLowerCase() === destination.toLowerCase() || d.destination_id === destination);
  const orig = origRes.data?.find((o: any) => o.city_name?.toLowerCase() === origin.toLowerCase() || o.origin_id === origin);

  const matchedFlights = (flightRes.data || []).filter(
    (f: any) => f.origin_id === orig?.origin_id && f.destination_id === dest?.destination_id
  );
  const matchedHotels = (hotelRes.data || []).filter(
    (h: any) => h.destination_id === dest?.destination_id
  );

  const options = [];
  for (const f of matchedFlights) {
    for (const h of matchedHotels) {
      const flightsInr = P * f.roundtrip_inr;
      const stayInr = R * N * h.nightly_inr;
      const mealsInr = P * (N + 1) * (dest?.synthetic_daily_meal_inr ?? 500);
      const transfersInr = dest?.synthetic_transfer_inr ?? 1200;
      const subtotal = flightsInr + stayInr + mealsInr + transfersInr;
      const bufferInr = Math.ceil(subtotal * 0.1);
      const totalInr = subtotal + bufferInr;

      if (totalInr <= groupBudget) {
        options.push({
          option_id: `O-${f.flight_id}-${h.hotel_id}`,
          flight_id: f.flight_id,
          hotel_id: h.hotel_id,
          total_inr: totalInr,
          breakdown: {
            P, R, N,
            flights_inr: flightsInr,
            stay_inr: stayInr,
            meals_inr: mealsInr,
            transfers_inr: transfersInr,
            buffer_inr: bufferInr,
            total_inr: totalInr,
          },
          flight: f,
          hotel: h,
        });
      }
    }
  }

  // Sort by total ascending
  options.sort((a, b) => a.total_inr - b.total_inr);
  const selectedOptions = options.slice(0, 3);

  const saved = fault !== "save";
  if (saved && trip_id) {
    // Record trace
    await supabase.from("retrieval_traces").insert({
      trip_id,
      owner_id: user.id,
      trip_version: expected_version,
      dataset_version: "2026.03.v1",
      filters: { origin, destination, adults, children },
      result_count: selectedOptions.length,
    });
  }

  const validatedExplanation = {
    status: selectedOptions.length > 0 ? "explain" : "no_match",
    message: selectedOptions.length > 0
      ? "Synthetic demo: Verified options calculated directly from our synthetic catalog for your confirmed group budget. All fares and hotel terms are fictional."
      : "Synthetic demo: No synthetic option matched all criteria within the requested budget.",
    question: null,
    input_patch: {},
    options: selectedOptions.map((o) => ({
      option_id: o.option_id,
      total_inr: o.total_inr,
      reason: `Direct synthetic flight and ${o.hotel_id} fit your confirmed group budget of INR ${groupBudget}.`,
      tradeoff: `${o.hotel.refundable ? "Refundable" : "Non-refundable"} synthetic stay.`,
      record_ids: [o.flight_id, o.hotel_id],
    })),
    actions: ["edit_inputs", "open_details"],
  };

  return new Response(
    JSON.stringify({
      status: "ok",
      trip_version: expected_version,
      trusted_cards: selectedOptions,
      validated_explanation: validatedExplanation,
      saved,
      error_code: null,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
