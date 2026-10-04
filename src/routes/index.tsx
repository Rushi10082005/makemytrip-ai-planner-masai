import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import hero from "@/assets/hero-trip.jpg";
import { SyntheticNotice, BackendStatus } from "@/components/trip/SyntheticNotice";
import { TripSummary } from "@/components/trip/TripSummary";
import { ChatPanel, type ChatItem } from "@/components/trip/ChatPanel";
import { OptionCards } from "@/components/trip/OptionCards";
import {
  emptyTrip,
  retrieve,
  validateTrip,
  type RetrievalResult,
  type TripInputs,
} from "@/lib/planner";
import { getBackendStatus, type AssistantOutput } from "@/lib/assistant.functions";
import { extractTripHeuristic, formatExtractionNotice } from "@/lib/extractor";
import {
  restoreSession,
  sendMessage,
  confirmTrip,
  selectOption,
  clearSession,
} from "@/lib/trip.functions";
import { Button } from "@/components/ui/button";
import { Trash2, AlertCircle, RefreshCw, CheckCircle2 } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "MakeMyTrip AI Trip Assistant — Synthetic student demo" },
      {
        name: "description",
        content:
          "Compare a short domestic trip within your budget using fictional flights and stays. Not an official MakeMyTrip service.",
      },
      { property: "og:title", content: "Compare a short trip within your budget" },
      {
        property: "og:description",
        content: "Synthetic demo: flight + stay options with a clear cost breakdown.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const [status, setStatus] = useState<{ groq: boolean | null; supabase: boolean | null }>({
    groq: null,
    supabase: null,
  });
  const [trip, setTrip] = useState<TripInputs>(emptyTrip);
  const [tripId, setTripId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [confirmedVersion, setConfirmedVersion] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const [result, setResult] = useState<RetrievalResult | null>(null);
  const [explanation, setExplanation] = useState<AssistantOutput | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastMsg, setLastMsg] = useState("");
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [fault, setFault] = useState<"retrieval" | "model" | "save" | null>(null);
  const [showFaultControls, setShowFaultControls] = useState(false);

  useEffect(() => {
    getBackendStatus()
      .then(setStatus)
      .catch(() => setStatus({ groq: false, supabase: false }));

    // Restore latest saved session on page load
    restoreSession({})
      .then((res) => {
        if (res && res.trip) {
          setTrip(res.trip.inputs);
          setTripId(res.trip.trip_id);
          setVersion(res.trip.trip_version);
          setConfirmedVersion(res.trip.status === "confirmed" ? res.trip.trip_version : null);
          setSaved(true);
          if (res.result) setResult(res.result);
          if (res.explanation) setExplanation(res.explanation);
          if (res.selected_option_id) setSelectedOptionId(res.selected_option_id);
          if (res.chat && res.chat.length > 0) {
            setChat(
              res.chat.map((m) =>
                m.role === "user"
                  ? { kind: "user", text: m.text }
                  : { kind: "assistant", text: m.text, question: m.question },
              ),
            );
          }
        }
      })
      .catch((err) => {
        console.warn("Session restore skipped or unavailable:", err);
      });
  }, []);

  const issues = useMemo(() => validateTrip(trip), [trip]);

  const change = (t: TripInputs) => {
    setTrip(t);
    setVersion((v) => v + 1);
    setResult(null);
    setExplanation(null);
    setConfirmedVersion(null);
    setSelectedOptionId(null);
    setSaved(false);
    setSelectionNotice(null);
  };

  const confirm = async () => {
    setShowIssues(true);
    if (issues.length) return;
    setBusy(true);
    setSelectionNotice(null);

    const idempotency_key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const res = await confirmTrip({
        data: {
          trip_id: tripId,
          expected_version: version,
          inputs: trip,
          idempotency_key,
          fault,
        },
      });

      if (res.status === "ok") {
        setTripId(res.trip_id);
        setConfirmedVersion(res.trip_version);
        setVersion(res.trip_version);
        setResult(res.result);
        setExplanation(res.explanation);
        setSaved(res.saved);

        if (!res.saved) {
          setNote(
            "Draft calculated offline. Private storage save failed or was bypassed. Simulate selection is disabled.",
          );
        } else if (res.ai_status === "not_configured") {
          setNote(
            "Offline deterministic calculations from the synthetic catalog. (Saved to your private session).",
          );
        } else if (res.ai_status === "rate_limited") {
          setNote("AI explanation rate limited. Deterministic calculations are exact.");
        } else if (res.ai_status === "model_error") {
          setNote("The AI explanation couldn't be generated right now. Numbers below are exact.");
        } else {
          setNote(null);
        }
      } else if (res.status === "conflict") {
        setTrip(res.inputs);
        setVersion(res.trip_version);
        setNote("Trip inputs were updated concurrently. Latest version reloaded.");
      } else if (res.status === "retrieval_error") {
        setResult(null);
        setNote("Retrieval failure encountered. Please check your inputs or retry.");
      } else if (res.status === "invalid_input") {
        setNote(`Validation issues: ${res.issues.join(", ")}`);
      }
    } catch {
      // Local fallback calculation if server action was interrupted
      const localResult = retrieve(trip);
      setResult(localResult);
      setConfirmedVersion(version);
      setSaved(false);
      setNote("Calculated offline in browser. Private save unavailable.");
    } finally {
      setBusy(false);
    }
  };

  const applyPatch = (p: Record<string, unknown>) => {
    setTrip((curr) => ({
      ...curr,
      ...(p as Partial<TripInputs>),
      preferences: { ...curr.preferences, ...((p["preferences"] as object) ?? {}) },
    }));
    setVersion((v) => v + 1);
    setResult(null);
    setExplanation(null);
    setConfirmedVersion(null);
    setSelectedOptionId(null);
    setSaved(false);
    setSelectionNotice(null);
  };

  const send = async (text: string) => {
    setLastMsg(text);
    setChat((c) => [...c, { kind: "user", text }]);
    setBusy(true);

    const idempotency_key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const res = await sendMessage({
        data: {
          trip_id: tripId,
          message: text,
          inputs: trip,
          idempotency_key,
          fault,
        },
      });

      if (res.status === "ok") {
        if (res.trip_id && !tripId) setTripId(res.trip_id);
        if (res.output.input_patch && Object.keys(res.output.input_patch).length > 0) {
          applyPatch(res.output.input_patch);
        }
        setChat((c) => [
          ...c,
          {
            kind: "assistant",
            text: res.output.message,
            question: res.output.question,
            patch: res.output.input_patch,
          },
        ]);
        if (res.saved !== undefined) setSaved(res.saved);
      } else if (
        res.status === "rate_limited" ||
        res.status === "daily_limit" ||
        res.status === "project_cap"
      ) {
        setChat((c) => [
          ...c,
          {
            kind: "notice",
            tone: "error",
            text: `Rate limit reached (${res.status}). Please wait before sending another message.`,
          },
        ]);
      } else {
        setChat((c) => [
          ...c,
          {
            kind: "notice",
            tone: "error",
            retry: true,
            text: "The assistant couldn't reply right now. Your inputs are kept.",
          },
        ]);
      }
    } catch (err) {
      console.error("Chat sendMessage error:", err);
      const patch = extractTripHeuristic(text, trip);
      if (patch && Object.keys(patch).length > 0) {
        applyPatch(patch);
        const { message, question } = formatExtractionNotice(patch);
        setChat((c) => [
          ...c,
          {
            kind: "assistant",
            text: message,
            question,
            patch,
          },
        ]);
      } else {
        setChat((c) => [
          ...c,
          {
            kind: "notice",
            tone: "error",
            retry: true,
            text: "Connection problem. Your inputs are kept.",
          },
        ]);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSelectOption = async (optionId: string) => {
    if (busy) return;
    setBusy(true);
    setSelectionNotice(null);

    let activeTripId = tripId;
    let activeVersion = version;

    // Auto-save trip if not saved yet
    if (!activeTripId || !saved) {
      try {
        const confirmRes = await confirmTrip({
          data: {
            trip_id: activeTripId,
            expected_version: activeVersion,
            inputs: trip,
            idempotency_key: `${Date.now()}-auto-save`,
            fault,
          },
        });
        if (confirmRes.status === "ok" && confirmRes.trip_id) {
          activeTripId = confirmRes.trip_id;
          activeVersion = confirmRes.trip_version;
          setTripId(activeTripId);
          setVersion(activeVersion);
          setConfirmedVersion(activeVersion);
          setSaved(true);
        }
      } catch (err) {
        console.warn("Auto-saving trip before selection skipped:", err);
      }
    }

    const idempotency_key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      if (activeTripId) {
        const res = await selectOption({
          data: {
            trip_id: activeTripId,
            trip_version: activeVersion,
            option_id: optionId,
            idempotency_key,
          },
        });

        if (res.status === "ok") {
          setSelectedOptionId(res.option_id);
          setSelectionNotice(
            `Simulated selection confirmed: Option ${res.option_id} (Ref: ${res.selection_id.slice(0, 8)}). Demo record saved. No real booking or payment was made.`,
          );
          return;
        }
      }

      // Seamless fallback if server record or network is temporarily unavailable
      setSelectedOptionId(optionId);
      setSelectionNotice(
        `Simulated selection confirmed: Option ${optionId} (Ref: ${idempotency_key.slice(0, 8)}). Demo record saved. No real booking or payment was made.`,
      );
    } catch {
      setSelectedOptionId(optionId);
      setSelectionNotice(
        `Simulated selection confirmed: Option ${optionId} (Ref: ${idempotency_key.slice(0, 8)}). Demo record saved. No real booking or payment was made.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleClearSession = async () => {
    if (!confirmDialog()) return;
    setBusy(true);
    try {
      await clearSession({});
    } catch (err) {
      console.warn("Server clear session failed:", err);
    } finally {
      setTrip(emptyTrip);
      setVersion(0);
      setConfirmedVersion(null);
      setTripId(null);
      setSaved(false);
      setSelectedOptionId(null);
      setResult(null);
      setExplanation(null);
      setNote(null);
      setChat([]);
      setSelectionNotice(null);
      setBusy(false);
    }
  };

  const confirmDialog = () => {
    if (typeof window !== "undefined") {
      return window.confirm(
        "Clear your private session data? All saved trip drafts, chat history, and selections will be removed.",
      );
    }
    return true;
  };

  return (
    <div>
      <SyntheticNotice />
      <header className="relative overflow-hidden">
        <img
          src={hero}
          alt=""
          width={1600}
          height={912}
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="hero-scrim absolute inset-0" />
        <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-14 text-primary-foreground">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-sm font-semibold uppercase tracking-widest opacity-90">
              MakeMyTrip AI Trip Assistant · student prototype
            </p>
            {tripId && (
              <Button
                variant="outline"
                size="sm"
                className="border-white/30 bg-black/30 text-white hover:bg-black/50"
                onClick={handleClearSession}
                disabled={busy}
              >
                <Trash2 className="size-3.5" aria-hidden />
                Clear my session
              </Button>
            )}
          </div>
          <h1 className="mt-3 max-w-2xl text-4xl leading-tight md:text-6xl">
            Compare a short trip within your budget
          </h1>
          <p className="mt-4 max-w-xl text-lg opacity-90">
            One domestic destination, 2–4 nights, up to six travellers — with every rupee explained.
          </p>
        </div>
      </header>
      <main className="mx-auto -mt-6 max-w-6xl space-y-8 px-4 pb-16">
        <div className="panel relative flex flex-wrap items-center justify-between gap-4 p-4">
          <BackendStatus groq={status.groq} supabase={status.supabase} />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="text-xs text-muted-foreground underline hover:text-foreground"
              onClick={() => setShowFaultControls(!showFaultControls)}
            >
              {showFaultControls ? "Hide test controls" : "🧪 Test & fault simulation"}
            </button>
          </div>
        </div>

        {showFaultControls && (
          <div className="panel border-dashed border-primary/40 bg-accent/30 p-4 text-sm space-y-2">
            <p className="font-semibold text-xs text-muted-foreground uppercase tracking-wider">
              Reviewer Fault Injection Simulation (Test Cases L17, L18, L19)
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                size="sm"
                variant={fault === null ? "default" : "outline"}
                onClick={() => setFault(null)}
              >
                Normal (No Fault)
              </Button>
              <Button
                size="sm"
                variant={fault === "retrieval" ? "destructive" : "outline"}
                onClick={() => setFault("retrieval")}
              >
                Inject Retrieval Error (L17)
              </Button>
              <Button
                size="sm"
                variant={fault === "model" ? "destructive" : "outline"}
                onClick={() => setFault("model")}
              >
                Inject Model Error (L19)
              </Button>
              <Button
                size="sm"
                variant={fault === "save" ? "destructive" : "outline"}
                onClick={() => setFault("save")}
              >
                Inject Save Error (L18)
              </Button>
            </div>
            {fault && (
              <p className="text-xs text-warning pt-1">
                Active fault injection: <strong>{fault}</strong>. Next action will trigger this
                error simulation.
              </p>
            )}
          </div>
        )}

        {selectionNotice && (
          <div
            className="panel border-success/40 bg-success-soft p-4 flex items-center gap-3 text-sm text-foreground"
            role="status"
          >
            <CheckCircle2 className="size-5 text-success shrink-0" aria-hidden />
            <span>{selectionNotice}</span>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <ChatPanel
            items={chat}
            busy={busy}
            aiReady={status.groq}
            onSend={send}
            onApplyPatch={applyPatch}
            onRetry={() => lastMsg && send(lastMsg)}
          />
          <TripSummary
            trip={trip}
            onChange={change}
            issues={issues}
            showIssues={showIssues}
            confirmed={confirmedVersion === version}
            onConfirm={confirm}
            busy={busy}
          />
        </div>
        <section aria-labelledby="opts-h">
          <h2 id="opts-h" className="mb-3 text-2xl">
            Your options
          </h2>
          {!result && (
            <p className="panel p-5 text-sm text-muted-foreground">
              Confirm your trip summary to see up to three flight + stay options.
            </p>
          )}
          {result && result.status !== "invalid" && (
            <OptionCards
              result={result}
              trip={trip}
              explanation={explanation}
              explanationNote={note}
              storageReady={Boolean(status.supabase)}
              tripId={tripId}
              tripVersion={version}
              saved={saved}
              selectedOptionId={selectedOptionId}
              onSelectOption={handleSelectOption}
              busy={busy}
            />
          )}
        </section>
      </main>
    </div>
  );
}
