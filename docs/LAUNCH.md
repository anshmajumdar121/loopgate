# Launch plan

Reach plan for after the hackathon submission. Everything below sticks to claims the
README already makes. Replace `<REPO_URL>` with the GitHub link before posting.

**The story, in order:**

1. **Problem:** AI agents say "done" when they aren't, and prompts like "don't touch `.env`" are
   only hopes.
2. **Proof:** Loop Agent enforces its guarantees in code, and an attack scoreboard
   (`npm run demo:trust`) shows 11/11 holding.
3. **Try it:** run the whole thing offline in 60 seconds, no API key.

## 1. GitHub "About" and topics

**Description** (under 300 characters):

> Delegate "the same step, N times" to AI. Every item gets its own plan, make and independent verify loop. No self-approval, write policy, crash-resume: enforced in code, not prompts, proven by an 11/11 attack scoreboard. Runs offline in 60 seconds.

**Website:** leave blank (or the demo video once it exists).

**Topics** (12):

```
ai-agents  llm  agent-orchestration  claude-code  developer-tools  automation
typescript  react-flow  hono  ai-safety  workflow-automation  batch-processing
```

## 2. Social preview image (1280x640)

Upload under Settings, Social preview. Keep important text inside a 40 px margin.

- **Title:** Loop Agent
- **Subtitle:** Delegate "the same step, N times" to AI. Verified in code, not prompts.
- **Proof strip (small, bottom):** `11/11 guarantees hold` · runs offline in 60 seconds · MIT
- **Visual:** the plan, make, verify diagram from the README, or a screenshot of the Batch
  view with one item escalated and the rest approved. Dark background, one accent color.

## 3. Ready-to-post drafts

### X / Twitter thread (5 posts)

**1/5**
> AI agents love saying "done." They're often not.
>
> I built Loop Agent so that "done" has to be earned: every item in a batch is planned, made, and verified by a separate verifier before it counts.
>
> <REPO_URL>

**2/5**
> The problem with most agent loops: the guarantees live in the prompt.
>
> "Don't touch .env." "The verifier decides." Then you hope.
>
> Loop Agent enforces them in code instead.

**3/5**
> Proof, not promises. `npm run demo:trust` is an attack scoreboard:
>
> - "REJECT - cannot approve" is never an approval
> - the maker can't forge the verifier's verdict
> - writes to .env / package.json / auth/** are blocked
> - a hard kill mid-batch resumes cleanly
>
> 11/11 hold.

**4/5**
> It's built for the job that is "the same step, N times": write a template once, hand it a list. Each item gets its own loop. Rejections feed the next attempt. Items that can't converge are escalated while the rest keep going.

**5/5**
> Try it offline in 60 seconds. No API key, no network (after npm install):
>
> cd backend && npm install && npm run demo:stack
>
> Then open http://localhost:5174. Honest limits are in the README. MIT licensed. Feedback welcome: <REPO_URL>

### LinkedIn post

> Agents that say "done" when the work isn't done are the most expensive kind of bug, because you find out late.
>
> I just shipped Loop Agent, a loop orchestrator for repetitive work: "the same step, N times." You write the template once and hand it a list. Every item goes through its own plan, make, and independent verify loop. Rejections feed back into the next attempt, items that can't converge are escalated, and a crash resumes where it left off.
>
> The part I care about most: the guarantees are enforced in code, not in prompts. The maker can't approve its own work. "REJECT - cannot approve" is never treated as an approval. Writes outside the plan, like .env or package.json, are blocked.
>
> I don't want you to take my word for it, so there's an attack scoreboard (npm run demo:trust). It currently prints 11/11 guarantees hold.
>
> You can run the whole thing offline in 60 seconds, with no API key. It's open source under MIT, and the README lists the honest limitations too: agents are single LLM completions, and batches run items one at a time for now.
>
> <REPO_URL>
>
> I'd love to hear what you would attack first.

### Show HN

**Title** (under 80 characters):

> Show HN: Loop Agent – batch AI jobs where a separate verifier gates each item

**First comment:**

> Hi HN. I built this because agent loops kept telling me "done" when they weren't, and because most of the safety lives in the prompt ("don't touch .env"), which is a hope rather than a guarantee.
>
> Loop Agent is for the job that is "the same step, N times". You give it a template and a list; each item runs its own plan, make, independent verify loop. Rejections feed the next attempt, items that can't converge are escalated, and a crash resumes from per-item checkpoints.
>
> The guarantees are enforced in code: a strict verdict parser (only the leading keyword counts, unknown means REJECT), an approval gate that rejects an APPROVE contradicting its own checklist, a write policy in the bridge (reserved files, denylist, plan allowlist), and a Host/Origin allowlist on a 127.0.0.1 bind. `npm run demo:trust` boots an isolated backend against a deterministic fake LLM and runs the attacks. It prints 11/11.
>
> Try it offline: `cd backend && npm install && npm run demo:stack`, then open http://localhost:5174. No API key, no paid calls.
>
> Honest limitations: the agents are single LLM completions, not tool-using agents, and batches run items sequentially. There is no auth token, so it is for localhost only (see SECURITY.md). Connections can use an OpenAI/Anthropic-compatible API, the local `claude` CLI, or the Mavis CLI.
>
> Repo: <REPO_URL>. I'd especially like to hear which guarantee you'd try to break first.

### Reddit: r/ClaudeAI

**Title:** I made a batch loop where Claude's "done" has to be verified by a separate verifier (runs with your Claude Code login, no API key)

> Anyone who has run Claude on a list of repetitive tasks knows the failure mode: it says it finished, and it didn't.
>
> Loop Agent runs each item through plan, make, and an independent verify step. If the verifier rejects, the required fixes go into the next attempt. Items that never converge get escalated while the rest keep going.
>
> You can point a connection at the local `claude` CLI (your Claude Code login, no API key), or at an OpenAI/Anthropic-compatible API.
>
> The checks are in code, not the prompt: the maker can't approve its own work, writes to .env / package.json / auth/** are blocked, and "REJECT - cannot approve" is never read as approval. There's an attack scoreboard (`npm run demo:trust`) that prints 11/11.
>
> You can try it offline in 60 seconds with a fake LLM: `cd backend && npm install && npm run demo:stack`.
>
> Limits: single-completion agents, sequential batches, localhost only. MIT. <REPO_URL>
>
> What would you want a verifier to check that this doesn't?

### Reddit: r/LocalLLaMA

**Title:** Open-source batch orchestrator with an independent verifier per item, guarantees enforced in code, runs fully offline in the demo

> I built Loop Agent for "same step, N times" jobs: each item gets a plan, make, and independent verify loop, with rejections fed back automatically and a resume-after-crash checkpoint per item.
>
> Connections accept any OpenAI-compatible endpoint, so a local server that speaks that API is the intended fit. I have only run the offline demo against a deterministic fake LLM so far, so I don't have local-model results to share and I would like reports from people who try it.
>
> The interesting part for this crowd: a weaker model is exactly where "I'm done" can't be trusted, so the verdict parser is strict (unknown output means REJECT), the maker can't forge the verifier's verdict, and writes outside the plan are blocked by code. `npm run demo:trust` shows 11/11 attacks handled.
>
> Offline demo, no key, no network after install: `cd backend && npm install && npm run demo:stack`.
>
> Limits: single-completion agents (the maker emits whole files), sequential batches, localhost only, no auth. MIT. <REPO_URL>

### dev.to article outline

**Title:** "Your agent said 'done.' Prove it." Building a batch loop with guarantees enforced in code

1. **Hook:** the "done" that wasn't. A short, honest anecdote about an agent claiming completion.
2. **Why prompts aren't guarantees:** "don't touch `.env`" and "the verifier decides" are requests, not enforcement.
3. **The shape of the loop:** plan, make, independent verify, with auto-iterate and escalate (use the README diagram).
4. **Four guarantees, four code paths:** the strict verdict parser, the approval gate, the write policy in the bridge, and the Host/Origin allowlist. One short snippet or description each.
5. **The attack scoreboard:** how `npm run demo:trust` boots an isolated backend against a deterministic fake LLM, and the 11 lines of output.
6. **Surviving a crash:** per-item checkpoints and boot-time resume, with the hard-kill test.
7. **Run it yourself:** the 60-second offline demo and the `FAIL-ME` item that always escalates.
8. **Honest limitations and what's next:** single-completion agents, sequential batches, no auth. Sandboxed tool-capable workers and parallel workers as next steps.
9. **Call to action:** try to break a guarantee, open an issue, link `<REPO_URL>`.

## 4. Seven-day posting plan

Times are US Eastern. They follow common weekday-morning heuristics for these
communities, not data measured for this project. If you publish on a different weekday,
keep the order and skip weekends for Show HN and Reddit.

| Day | Channel | Time (ET) | Notes |
|---|---|---|---|
| Day 0 (tonight) | GitHub | any | Set About and topics, upload the social preview, add the demo GIF, check the README renders |
| Day 1 (Tue) | Show HN | 8:30 AM | Post the first comment right away; stay on the thread for the first 2 to 3 hours |
| Day 1 (Tue) | X thread | 9:30 AM | Thread of 5, pin it |
| Day 2 (Wed) | r/ClaudeAI | 9:00 AM | Lead with the `claude` CLI, no-API-key angle |
| Day 2 (Wed) | LinkedIn | 8:30 AM | Reply to every comment in the first hour |
| Day 3 (Thu) | r/LocalLLaMA | 10:00 AM | Ask for local-model reports |
| Day 3 (Thu) | X follow-up | 12:00 PM | Screenshot of the 11/11 scoreboard |
| Day 4 (Fri) | dev.to article | 9:00 AM | Link the repo and the HN thread |
| Day 5 (Sat) | GitHub | any | Triage issues, label good-first-issues, submit awesome-list PRs |
| Day 6 (Sun) | YouTube | 11:00 AM | Upload the short demo, link it in the README |
| Day 7 (Mon) | X + LinkedIn | 9:00 AM | Recap: what people tried, what broke, what you fixed |

## 5. Five ways to grow stars

1. **Demo GIF in the README.** Record 20 to 30 seconds: start `npm run demo:stack`, run a
   batch, show the `FAIL-ME` item escalating while the others finish. Put it right under
   the tagline.
2. **Good-first-issue labels.** Open small, well-scoped issues and label them: README fixes,
   Windows setup notes, extra example templates for the offline demo, and extra attack
   cases for the scoreboard. A first PR is the strongest follow signal.
3. **Comparison table.** Add a short "how this differs" table against plain agent loops. Only
   list things you can point to in code or in the scoreboard, and keep the honest
   limitations next to it.
4. **Awesome-list submissions.** Find the maintained "awesome" lists for AI agents, Claude
   Code and LLM developer tools. Read each list's contribution rules and open one PR per
   list with a one-line description.
5. **Short YouTube demo (about 90 seconds).** Problem in 15 seconds, the 11/11 scoreboard in
   30, the 60-second offline run in 30, the honest limits in 15. Put the link in the
   README and in every post.
