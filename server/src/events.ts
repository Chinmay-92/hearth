// In-process fan-out for things Hearth decides on its own (overdue-dose
// reminders, care-team notes, alerts, weekly summaries). Every MCP session
// subscribes and forwards events to its client as logging notifications on the
// standalone GET SSE stream, so an idle Echo Show (or the simulator) can show
// them without being asked.
export type HearthEvent =
  | { kind: "dose_reminder"; stage: 1 | 2; medications: string[]; dueAt: string; spoken: string }
  | { kind: "alert"; to: string; urgency: "info" | "soon" | "urgent"; message: string }
  | { kind: "care_team_note"; from: string; text: string; noteId: number }
  | { kind: "weekly_summary"; to: string[]; subject: string };

export class EventHub {
  private subs = new Set<(e: HearthEvent) => void>();
  private log: { at: number; e: HearthEvent }[] = [];
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Recent reminders and care-team notes, so a screen that connects late can catch up. */
  recent(withinMs = 15 * 60_000): HearthEvent[] {
    const since = this.now() - withinMs;
    return this.log.filter((x) => x.at >= since).map((x) => x.e);
  }

  subscribe(fn: (e: HearthEvent) => void): () => void {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  }

  emit(e: HearthEvent) {
    if (e.kind === "dose_reminder" || e.kind === "care_team_note") {
      this.log.push({ at: this.now(), e });
      if (this.log.length > 20) this.log.shift();
    }
    for (const fn of this.subs) {
      try {
        fn(e);
      } catch {
        // one broken subscriber must not stop the others
      }
    }
  }
}
