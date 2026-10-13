# Demo video script (target 2:45)

**Lead with the real Echo Dot.** A phone on a tripod filming the Dot (with its light ring) and the Hearth terminal is the most convincing footage you can give the Alexa+ judges. Use the simulator screen capture for the MCP App card and the trace panel, which a screenless Dot can't show.

Record the simulator at 1440×900 in Chrome with "Speak replies aloud" on. Run `npm run seed` right before recording so the data story is fresh. Use your own voice or plain text-to-speech. No copyrighted music.

| Time | Screen | Say / do |
|---|---|---|
| 0:00–0:15 | Title card, then the ambient Echo Show screen | "More than fifty million Americans care for a family member, and many do it from a distance. Hearth makes Alexa+ the shared memory between a parent and the family looking after her." |
| 0:15–0:35 | **Echo Dot** (camera) + Hearth terminal inset. "Alexa, did I take my pills this morning?" | Alexa+ calls `whats_due` on Hearth and reads out the overdue morning meds. |
| 0:35–0:50 | **Echo Dot.** "I just took my lisinopril and metformin." | `record_dose` ×2. Alexa mentions that metformin is running low. |
| 0:50–1:20 | **Echo Dot.** "I tripped on the rug and I feel dizzy." | `log_checkin` → urgent → Alexa offers to alert Sarah → "yes" → `notify_family`. **The ntfy push lands on a phone in shot.** (In the simulator the same moment appears as the elicitation overlay; show it briefly as a picture-in-picture.) |
| 1:20–1:55 | **Simulator**, speaking as **Sarah**: "How has Mom been doing this week?" It sees what Mom just told the Echo Dot. | The **MCP App card** renders: 88% adherence, rising pain trend, missed atorvastatin, refill, an appointment with no driver. Alexa gives a two-sentence summary. |
| 1:55–2:15 | "Mom's knee appointment needs a driver." | `schedule_appointment` → driver picker elicitation → say "David" → "David is driving and has been notified." |
| 2:15–2:35 | Terminal: `npm run probe` and a glimpse of the account-linking PIN page | "Hearth is a standard MCP 2025-11-25 server with OAuth account linking for Alexa+. Our open-source probe checks any server against the transport spec. Hearth passes all 23 checks, and the probe catches servers that skip Origin validation." |
| 2:35–2:45 | README architecture diagram | "Hearth: one household, every device, and nobody has to remember everything alone." |

Tips: keep the trace panel visible; judges look for real MCP traffic. If the live model takes a second, cut the dead air in editing.
