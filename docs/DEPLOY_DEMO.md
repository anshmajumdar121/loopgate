# Deploy a public Loopgate demo

There are two ways to give people a clickable link:

| | GitHub Pages preview | Hosted demo (Render) |
|---|---|---|
| What runs | Nothing. A recorded real run replays in the browser. | The real backend, on the offline fake LLM |
| Visitors can | watch the loop, click every node and task, replay | start their own batches (capped) |
| Cost / setup | free, GitHub only, ~2 min | free Render account, ~10 min |

## GitHub Pages preview (GitHub only)

The page states in a fixed banner that it is a demo preview, not the full project.

1. Merge `feat/public-demo-mode` into `main` and push it.
2. On GitHub, open the repo's **Settings → Pages**. Under **Build and deployment → Source**,
   choose **GitHub Actions**.
3. Open **Actions → Demo preview (GitHub Pages) → Run workflow**. Pushes to `main` that touch
   `ui/` also redeploy it automatically.
4. When the workflow finishes, the link is `https://anshmajumdar121.github.io/loopgate/`. The
   README's "Live demo preview" line already points there.

To re-record the run after changing the loop (it captures every WebSocket message and REST
snapshot of a real backend run on the fake LLM, with local paths scrubbed):

```powershell
cd backend; node --import tsx scripts/demo/record-static-demo.mjs   # writes ui/src/staticDemo/recording.json
```

To check the Pages build locally:

```powershell
cd ui; $env:VITE_STATIC_DEMO = "1"; npx vite build --base /loopgate/ --outDir dist-pages; npx vite preview --base /loopgate/ --outDir dist-pages
# → http://localhost:4173/loopgate/
```

## Hosted demo (Render)

The normal backend trusts its local user and **must never be exposed** (no auth, plaintext
API keys, arbitrary workdirs). `LOOP_PUBLIC_DEMO=1` turns it into a locked-down sandbox
that is safe to put on the internet. In that mode one process serves the UI, the API and
the WebSocket, and every run uses the bundled offline fake LLM.

### Steps (Render, free)

1. **Get the deploy files onto `main`.** Render deploys the repo's default branch. Merge
   `feat/public-demo-mode` into `main` and push it.
2. **Create a Render account** at <https://dashboard.render.com/register>. Sign up with
   GitHub so Render can see the repo.
3. **Create the service from the Blueprint.** In the dashboard, click **New → Blueprint**,
   connect GitHub if Render asks, pick `anshmajumdar121/loopgate`, keep the defaults and
   click **Deploy Blueprint**. Render reads [`render.yaml`](../render.yaml): one free Docker
   web service named `loopgate-demo`.
4. **Env vars: nothing to set.** `render.yaml` sets `LOOP_PUBLIC_DEMO=1` and
   `LOOP_HOST=0.0.0.0`. Render injects `PORT`, plus `RENDER_EXTERNAL_HOSTNAME`, which is
   added to the Host/Origin allowlist automatically. Only for a custom domain, add
   `LOOP_ALLOWED_HOSTS=demo.yourdomain.com`.
5. **Wait for the first build** (about 5–10 min). The URL is shown at the top of the service
   page, e.g. `https://loopgate-demo.onrender.com`. Render adds a suffix if that name is
   taken.
6. **Check it** (PowerShell):
   ```powershell
   $u = "https://loopgate-demo.onrender.com"   # your URL
   irm "$u/api/demo"                            # → publicDemo: True
   try { irm -Method Post "$u/api/connections" -ContentType application/json -Body '{}' } catch { $_.Exception.Response.StatusCode }   # → Forbidden
   ```
   Then open the URL. You should see the amber "Public demo" banner. Click **Batch** and use
   template `Build a landing page for {{item}}` with items `Acme Coffee`, `Nimbus Cloud` and
   `FAIL-ME Corp`.
7. **Optional: link it from the README**, next to the "Live demo preview" line. That line points
   to the GitHub Pages preview.

**Free-tier behaviour:** the service sleeps after 15 minutes without traffic, and the first
visit after that takes about a minute to wake it. Each restart or deploy starts with an empty
demo (data lives in `/tmp`).

**Without the Blueprint:** choose **New → Web Service**, pick the repo, set **Language** to
**Docker** and **Instance type** to **Free**, then add the env vars `LOOP_PUBLIC_DEMO=1`
and `LOOP_HOST=0.0.0.0`.

### Other hosts (same Dockerfile)

- **Railway:** New Project → Deploy from GitHub repo. It detects the `Dockerfile`. Then go to
  Settings → Networking → Generate Domain. `PORT` and `RAILWAY_PUBLIC_DOMAIN` are injected and
  handled automatically.
- **Fly.io:** run `fly launch --no-deploy`, which detects the `Dockerfile`. Set
  `internal_port = 10000` in `fly.toml`, then run `fly deploy`. `<app>.fly.dev` is
  allowlisted via `FLY_APP_NAME`.

### Try the hosted mode locally

With Docker:

```powershell
docker build -t loopgate-demo .
docker run --rm -p 10000:10000 loopgate-demo     # → http://localhost:10000
```

Without Docker:

```powershell
cd ui; npm install; npm run build; cd ..\backend; npm install
$env:LOOP_PUBLIC_DEMO = "1"; npx tsx src/index.ts   # → http://localhost:3001
```

### What hosted demo mode locks down

| Risk on a public host | What demo mode does |
|---|---|
| Real LLM calls, keys, local `claude` / Mavis CLI | Only the bundled deterministic fake LLM runs (started in-process on loopback with its attack modes locked). Every requested model is pinned to it, and the agent spawner refuses anything else. `LOOP_LLM_API_KEY`, `LOOP_LOCAL_CLI`, `LOOP_MAVIS_CLI`, `LOOP_ALLOW_MOCK`, `LOOP_WORKDIR` and `LOOP_LLM_AGENT_SCRIPT` are scrubbed from the environment. |
| Stored connections / keys | Stored connections are never loaded. The one demo connection is in memory. Create, edit, delete and test calls return 403, and the store refuses them as well. |
| Server filesystem | `workdir`, `contextFiles`, `projectId` and `sessionId` are refused. `/api/fs/*` (folder browser), `/api/ratchet/*`, project and session writes, and task deletes return 403. Task workdirs must stay inside the temp workspace root. |
| Writes | Data and workspaces go to a fresh temp dir on every boot. |
| Running generated code | No `npm install/build/test`, no preview server and no headless-browser runtime check. The fake LLM also HTML-escapes visitor text. |
| Resource burn | At most 5 items per batch, 200 characters per item, 2,000 per prompt and 3 attempts. The instance gets 120 loops/hour, each client 30 loops/hour, and new runs stop at 500 stored tasks. Request bodies are capped at 64 KB. Runs are always autonomous, so none can park waiting for a human and block the single run slot. |
| Unknown endpoints | The gate is default-deny. Only allowlisted routes reach the app. |
| Browser attacks | Host/Origin allowlist (unchanged), plus a strict CSP, `X-Frame-Options: DENY` and `nosniff` on the UI. |

Tunables (all optional): `LOOP_DEMO_MAX_ITEMS`, `LOOP_DEMO_MAX_ITEM_CHARS`,
`LOOP_DEMO_MAX_PROMPT_CHARS`, `LOOP_DEMO_MAX_ATTEMPTS`, `LOOP_DEMO_LOOPS_PER_HOUR`,
`LOOP_DEMO_LOOPS_PER_CLIENT_PER_HOUR`, `LOOP_DEMO_MAX_TASKS`, `LOOP_DEMO_MAX_BODY_BYTES`,
`DEMO_LLM_DELAY_MS` (fake LLM latency, default 800) and `LOOP_UI_DIST` (built UI path,
default `../ui/dist`).

**Known limits:**

- All visitors share one instance. Everyone sees the same runs, one run executes at a time,
  and anyone can stop the current run.
- The per-client budget is keyed on `X-Forwarded-For` and is best effort. The instance-wide
  budget is the hard limit.
- Live preview links are disabled in the demo.
- There is still no authentication. Demo mode is safe to expose because nothing in it is
  worth stealing, not because access is controlled.
