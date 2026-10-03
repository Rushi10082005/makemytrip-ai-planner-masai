import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { SyntheticNotice } from "@/components/trip/SyntheticNotice";
import { decodeTrip, retrieve, inr, type TripOption } from "@/lib/planner";
import { getDetails } from "@/lib/trip.functions";

export const Route = createFileRoute("/details/$optionId")({
  validateSearch: (s) =>
    z
      .object({
        t: z.string().default(""),
        trip: z.string().optional(),
        v: z.coerce.number().optional(),
      })
      .parse(s),
  head: () => ({
    meta: [
      { title: "Option details — Synthetic trip demo" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Details,
});

function Details() {
  const { optionId } = Route.useParams();
  const { t, trip, v } = Route.useSearch();

  const [serverState, setServerState] = useState<{
    status: "idle" | "loading" | "ok" | "stale" | "not_found" | "retrieval_error" | "error";
    option?: TripOption;
  }>({ status: trip && v !== undefined ? "loading" : "idle" });

  useEffect(() => {
    if (trip && v !== undefined) {
      getDetails({ data: { trip_id: trip, trip_version: v, option_id: optionId } })
        .then((res) => {
          if (res.status === "ok") {
            setServerState({ status: "ok", option: res.option });
          } else {
            setServerState({ status: res.status });
          }
        })
        .catch(() => {
          setServerState({ status: "error" });
        });
    }
  }, [trip, v, optionId]);

  // Fallback to offline decoded trip if no server params are provided
  const offlineTrip = !trip && t ? decodeTrip(t) : null;
  const offlineResult = offlineTrip ? retrieve(offlineTrip) : null;
  const offlineOption =
    offlineResult && offlineResult.status !== "invalid"
      ? offlineResult.options.find((x) => x.option_id === optionId)
      : undefined;

  const o = serverState.status === "ok" ? serverState.option : offlineOption;

  return (
    <div>
      <SyntheticNotice />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-3xl">Option details</h1>

        {serverState.status === "loading" && (
          <p className="mt-4 text-muted-foreground">Verifying option with server storage…</p>
        )}

        {serverState.status === "stale" && (
          <div className="panel mt-6 border-warning/40 bg-warning-soft p-5">
            <h2 className="text-lg font-semibold">Stale option reference</h2>
            <p className="mt-1 text-sm">
              This option is no longer current for the confirmed version of your trip. The trip
              inputs were modified since this link was opened.
            </p>
            <p className="mt-3">
              <Link to="/" className="text-primary underline font-medium">
                Return to Planner
              </Link>
            </p>
          </div>
        )}

        {serverState.status === "not_found" && !offlineOption && (
          <div className="panel mt-6 border-destructive/40 bg-destructive/10 p-5">
            <h2 className="text-lg font-semibold">Trip not found</h2>
            <p className="mt-1 text-sm">
              No saved trip matching this identifier was found in your private session.
            </p>
            <p className="mt-3">
              <Link to="/" className="text-primary underline font-medium">
                Return to Planner
              </Link>
            </p>
          </div>
        )}

        {o && (
          <div className="panel mt-6 space-y-3 p-6 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
              <span className="chip bg-primary text-primary-foreground font-mono text-xs">
                {o.option_id}
              </span>
              {trip && v !== undefined && serverState.status === "ok" ? (
                <span className="chip bg-success-soft text-success text-xs">
                  ✓ Verified server record (Trip {trip.slice(0, 8)}… v{v})
                </span>
              ) : (
                <span className="chip bg-muted text-muted-foreground text-xs">
                  Offline unauthenticated view
                </span>
              )}
            </div>

            <p>
              <strong>{o.flight.label}</strong> ({o.flight.flight_id}) · {o.flight.stops_each_way}{" "}
              stop(s) each way · baggage {o.flight.baggage_kg} kg · cancellation fee{" "}
              {inr(o.flight.cancellation_inr_per_person)}/person
            </p>

            <p>
              <strong>{o.hotel.label}</strong> ({o.hotel.hotel_id}) · {o.hotel.cancellation_terms} ·{" "}
              {[
                o.hotel.quiet && "Quiet",
                o.hotel.step_free && "Step-free",
                o.hotel.refundable ? "Refundable" : "Non-refundable",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>

            <div className="rounded-lg bg-muted/60 p-3">
              <p className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">
                Cost Breakdown
              </p>
              <div className="mt-2 grid grid-cols-2 gap-1 text-xs">
                <span>Flights ({o.breakdown.P} pax):</span>
                <span className="text-right font-mono">{inr(o.breakdown.flights_inr)}</span>
                <span>
                  Stay ({o.breakdown.R} room, {o.breakdown.N} nights):
                </span>
                <span className="text-right font-mono">{inr(o.breakdown.stay_inr)}</span>
                <span>Meals allowance:</span>
                <span className="text-right font-mono">{inr(o.breakdown.meals_inr)}</span>
                <span>Transfers allowance:</span>
                <span className="text-right font-mono">{inr(o.breakdown.transfers_inr)}</span>
                <span>Buffer (10% rounded up):</span>
                <span className="text-right font-mono">{inr(o.breakdown.buffer_inr)}</span>
              </div>
              <div className="mt-2 flex justify-between border-t border-border pt-1 font-bold">
                <span>Total:</span>
                <span className="font-mono text-base">{inr(o.breakdown.total_inr)}</span>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Diet tags aren't allergen guarantees; step-free isn't an accessibility certification.
              Fictional student demo. No booking is made.
            </p>

            <div className="pt-2">
              <Link to="/" className="text-primary underline text-sm">
                ← Back to Trip Planner
              </Link>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
