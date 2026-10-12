# Demo video script (target 2:45)

Record the simulator at 1440×900 in Chrome with "Speak replies aloud" on. Run `npm run seed` right before recording so the data story is fresh. Use your own voice or plain text-to-speech. No copyrighted music.

| Time | Screen | Say / do |
|---|---|---|
| 0:00–0:15 | Title card, then the ambient Echo Show screen | "More than fifty million Americans care for a family member, and many do it from a distance. Hearth makes Alexa+ the shared memory between a parent and the family looking after her." |
| 0:15–0:35 | Speaking: **Asha**. Mic: "Alexa, did I take my pills this morning?" | The trace shows `whats_due`. Alexa lists the overdue morning meds. |
| 0:35–0:50 | "I just took my lisinopril and metformin." | Two parallel `record_dose` calls. Alexa mentions that metformin is running low. |
| 0:50–1:20 | "I tripped on the rug and I'm a bit dizzy." | `log_checkin` → **elicitation overlay**: *"Should I alert Priya right away?"* Say "yes". Show the ntfy push arriving on a phone held up to the camera (or the outbox entry). |
| 1:20–1:55 | Switch to **Priya**. "How has Mom been doing this week?" | The **MCP App card** renders: 88% adherence, rising pain trend, missed atorvastatin, refill, an appointment with no driver. Alexa gives a two-sentence summary. |
| 1:55–2:15 | "Mom's knee appointment needs a driver." | `schedule_appointment` → driver picker elicitation → say "Raj" → "Raj is driving and has been notified." |
| 2:15–2:35 | Terminal: `npm run probe` | "Hearth implements MCP 2025-11-25 over Streamable HTTP. Our open-source probe checks any server against the transport spec. Hearth passes all 23 checks, and the probe catches servers that skip Origin validation." |
| 2:35–2:45 | README architecture diagram | "Hearth: one household, every device, and nobody has to remember everything alone." |

Tips: keep the trace panel visible; judges look for real MCP traffic. If the live model takes a second, cut the dead air in editing.
