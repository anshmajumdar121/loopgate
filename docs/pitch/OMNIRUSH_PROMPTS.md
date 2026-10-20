# OmniRush prompts: Loop Agent hackathon pitch

These are copy/paste prompts for the OmniRush session. They are intentionally
self-contained so OmniRush can draft the pitch without reading private app
credentials or the user's real task data.

## Product facts to keep true

- Product: **Loop Agent** — a trustworthy loop/graph orchestrator for repetitive engineering work.
- Core flow: one prompt template runs over N items; every item goes through **plan → make → independent verify**.
- Rejected items auto-iterate up to a cap; items that cannot converge escalate; completed items are not re-run after a crash.
- The offline demo is deterministic and uses a fake LLM; it makes no paid model calls.
- Trust scoreboard: **11/11 guarantees hold** in the isolated demo.
- Security/trust guarantees include strict verdict parsing, verifier-owned approval, maker write allowlists, denylisted files, request hardening, loopback/Host/Origin checks, and crash-resume batch checkpoints.
- The UI now has a live **Map** canvas node showing each batch item, status, attempts, progress, and the currently running item; the progress card is an evidence timeline.
- Do not claim that agents use tools autonomously: the current agents are single-completion planner/maker/verifier workers with deterministic checks where available.
- Do not invent customer names, revenue, benchmark numbers, integrations, or production deployments.

---

## Prompt 1 — two-minute live demo script

```text
You are a product storyteller helping me pitch Loop Agent at a hackathon.
Write a tight, natural 2-minute live demo script for a technical judge.

The demo uses the deterministic offline stack, not a paid model:
- fake LLM on port 4010
- isolated backend on port 3101
- UI at http://localhost:5174
- the user opens Batch and runs a prompt template over several items,
  including one item named FAIL-ME so the audience sees a controlled escalation
- the Map node on the canvas shows every item as a live status card
- the Follow live chip automatically follows the active item
- the evidence timeline shows plan, files written, verification evidence,
  and the final result
- the trust scoreboard ends at 11/11 guarantees hold

Structure the script as:
1. 10-second hook: the repetitive-work problem
2. 20-second explanation of plan → make → independent verify
3. 60-second click-by-click demo narration, with exact audience-visible moments
4. 20-second trust differentiator: guarantees enforced in code, not prompts
5. 15-second close: why this matters and what would come next

Make it sound like a builder speaking, not a marketing voiceover. Include
short stage directions in [brackets]. Keep every claim grounded in the facts
above. Do not mention private credentials or real customer data. End with one
memorable sentence under 12 words.
```

---

## Prompt 2 — five-slide pitch deck outline

```text
Create a five-slide hackathon pitch deck outline for Loop Agent.
For each slide provide:
- slide title (max 7 words)
- one-sentence thesis
- exact on-slide copy (minimal, readable from a room)
- suggested visual or screenshot
- 20-second speaker notes

Use this narrative:
1. Repetitive engineering work is where teams lose time and trust.
2. Loop Agent turns one template into N independently verified work items.
3. The live Map node makes every item visible: pending, running, done,
   escalated, attempts, and current active item.
4. Trust is enforced in code: verifier-owned verdicts, write allowlists,
   denylisted files, strict approval gates, crash-resume checkpoints.
5. The deterministic offline demo proves 11/11 guarantees today; next steps
   are tool-capable workers, stronger isolation, and parallel execution.

Tone: sharp, technical, visually sparse. Avoid generic AI words like
"revolutionary" and "seamless." Do not invent metrics or customers. The deck
must make the Map node and evidence timeline feel like the hero visuals.
```

---

## Prompt 3 — judge Q&A and objection handling

```text
Prepare a judge Q&A sheet for a hackathon demo of Loop Agent.
Give 10 likely questions and concise, confident answers (2–4 sentences each).
Cover:
- Why not just use a normal task queue?
- What does independent verification mean here?
- How do you stop a maker from approving its own work?
- What prevents writes outside the plan?
- What happens when one batch item fails?
- How does crash recovery work?
- Is the demo using a real paid LLM?
- What is still unfinished?
- Why is the Map node important?
- What would you build next?

Use only these truthful facts: the offline demo is deterministic and uses a
fake LLM; the trust scoreboard has 11/11 passing guarantees; the current
workers are single-completion planner/maker/verifier agents; batches run
sequentially today; the UI visibly shows each item and evidence; and the
roadmap includes tool-capable workers, stronger isolation, and parallelism.
Be honest about limitations without underselling the working guarantees.
```

---

## Prompt 4 — one-page written pitch

```text
Write a 350–450 word hackathon submission for Loop Agent.
Audience: engineering judges who are skeptical of agent demos.

Required sections:
- Problem
- What we built
- Why it is trustworthy
- What the live demo proves
- What comes next

Lead with the concrete behavior: one prompt template becomes N tasks, each
gets plan → make → independent verify, and the Map node lets the audience see
all items moving live. Mention the deterministic offline demo and its 11/11
trust scoreboard. Explain that the guarantees are enforced in code rather
than only requested in prompts. State the limitations plainly: current agents
are single completions, batches are sequential, and stronger sandboxing is a
next step.

Use crisp prose, no hype, no invented customer or business metrics, and no
claims that the verifier runs arbitrary code autonomously.
```

---

## Prompt 5 — final 30-second stage close

```text
Give me six alternative 30-second closing statements for the Loop Agent
hackathon demo. Each should:
- remind the audience that one template can run over many items
- mention independent verification or code-enforced trust
- make the visible Map node feel like the proof, not decoration
- end with a concrete invitation to imagine the next workflow

Builder voice, short sentences, no hype. Maximum 65 words each. Do not invent
metrics beyond the verified 11/11 trust scoreboard.
```
