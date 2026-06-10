# GroundedSAM roof-segmentation endpoint for Home Studio's /api/segment route.
#
# Deploy this as a Hugging Face Space (SDK: Gradio, GPU recommended) OR adapt it
# to a dedicated Inference Endpoint. Then set in Vercel:
#   HF_SEGMENT_URL        = https://<your-space>.hf.space/segment   (this route)
#   HUGGINGFACE_API_TOKEN = your HF token
#
# Contract expected by /api/segment:
#   POST JSON { "image_base64": "<png/jpg base64>", "prompt": "roof" }
#   ->  JSON { "polygon": [[x, y], ...], "width": W, "height": H }
#        polygon = largest roof contour, in image pixel coordinates.
#
# This template uses Grounding DINO (open-vocab detection) + SAM (segmentation),
# i.e. "GroundedSAM". Swap in GroundedSAM 2 / your own weights as needed.

import base64
import io
import json

import numpy as np
import cv2
from PIL import Image
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

# --- Load your models once at startup (pseudo-wired; install the real deps) ---
# from groundingdino.util.inference import load_model, predict
# from segment_anything import sam_model_registry, SamPredictor
# dino = load_model(...); sam = SamPredictor(sam_model_registry["vit_h"](checkpoint=...))

app = FastAPI()


def segment_roof(image: np.ndarray, prompt: str = "roof"):
    """Return the largest roof contour as a list of [x, y] pixel points.

    Replace the body with your GroundedSAM inference. The reference flow:
      1. boxes = grounding_dino(image, text=prompt)
      2. masks = sam(image, boxes)          # boolean HxW mask(s)
      3. union the masks, take the largest external contour
    Below is the contour-extraction step given a boolean `mask`.
    """
    # mask = run_grounded_sam(image, prompt)  # -> HxW bool
    # --- placeholder so the Space boots; returns the image bounding box ---
    h, w = image.shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)
    mask[h // 4 : 3 * h // 4, w // 4 : 3 * w // 4] = 1  # TODO: real mask

    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return [], w, h
    c = max(contours, key=cv2.contourArea)
    eps = 0.01 * cv2.arcLength(c, True)
    approx = cv2.approxPolyDP(c, eps, True)
    poly = [[int(p[0][0]), int(p[0][1])] for p in approx]
    return poly, w, h


@app.post("/segment")
async def segment(request: Request):
    body = await request.json()
    b64 = body.get("image_base64") or body.get("inputs")
    prompt = body.get("prompt", "roof")
    if not b64:
        return JSONResponse({"error": "image_base64 required"}, status_code=400)
    img = np.array(Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB"))
    poly, w, h = segment_roof(img, prompt)
    return {"polygon": poly, "width": w, "height": h}
