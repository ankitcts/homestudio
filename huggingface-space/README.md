---
title: Home Studio Roof Segmenter
emoji: 🏠
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
---

# Home Studio — Roof Segmenter (GroundedSAM)

FastAPI endpoint that segments the roof from a satellite image for the Home
Studio app's `/api/segment` route.

- `POST /segment` — body `{ "image_base64": "<base64>", "prompt": "roof" }`
  → `{ "polygon": [[x, y], ...], "width": W, "height": H }`
- `GET /` — health check.

Models: Grounding DINO (`IDEA-Research/grounding-dino-tiny`) + SAM
(`facebook/sam-vit-base`).

## Deploy (one time)

1. Create a new Space: https://huggingface.co/new-space
   - Owner: **ankitcts**, name e.g. **homestudio-roof-segmenter**
   - SDK: **Docker**
   - Hardware: a **GPU** tier (e.g. T4 small) is strongly recommended; CPU works but is slow.
   - Visibility: Public (simplest) — the app still sends your token, which is harmless.
2. Upload these files (`app.py`, `requirements.txt`, `Dockerfile`, `README.md`)
   to the Space (drag-drop in the web UI, or `git clone` the Space repo, copy
   the files in, and `git push`).
3. Wait for the build + first model download to finish.
4. Your endpoint is: `https://ankitcts-homestudio-roof-segmenter.hf.space/segment`

## Wire it into the app (Vercel)

Set in **Vercel → homestudio → Settings → Environment Variables**, then redeploy:

- `HF_SEGMENT_URL = https://ankitcts-homestudio-roof-segmenter.hf.space/segment`
- `HUGGINGFACE_API_TOKEN = <your HF token>`
- (and ensure the **Maps Static API** is enabled on the Google key)
