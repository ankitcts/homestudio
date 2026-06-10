# GroundedSAM roof-segmentation endpoint for Home Studio's /api/segment route.
#
# Pipeline: Grounding DINO (open-vocab detection of "roof") -> SAM (masks for the
# detected boxes) -> largest external contour -> polygon in image-pixel coords.
#
# Contract (matches app/api/segment/route.js):
#   POST /segment  JSON { "image_base64": "<base64>", "prompt": "roof" }
#     -> { "polygon": [[x, y], ...], "width": W, "height": H }
#
# Deploy as a Hugging Face **Docker** Space (GPU recommended). The public Space
# URL's /segment path becomes HF_SEGMENT_URL in Vercel, e.g.
#   https://ankitcts-homestudio-roof-segmenter.hf.space/segment

import base64
import io

import cv2
import numpy as np
import torch
from PIL import Image
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from transformers import (
    AutoModelForZeroShotObjectDetection,
    AutoProcessor,
    SamModel,
    SamProcessor,
)

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DINO_ID = "IDEA-Research/grounding-dino-tiny"
SAM_ID = "facebook/sam-vit-base"

dino_processor = AutoProcessor.from_pretrained(DINO_ID)
dino = AutoModelForZeroShotObjectDetection.from_pretrained(DINO_ID).to(DEVICE)
sam = SamModel.from_pretrained(SAM_ID).to(DEVICE)
sam_processor = SamProcessor.from_pretrained(SAM_ID)

app = FastAPI()


def detect_boxes(image, prompt):
    text = prompt.strip()
    if not text.endswith("."):
        text += "."
    inputs = dino_processor(images=image, text=text, return_tensors="pt").to(DEVICE)
    with torch.no_grad():
        outputs = dino(**inputs)
    target_sizes = [image.size[::-1]]
    # transformers renamed box_threshold -> threshold; support both.
    try:
        results = dino_processor.post_process_grounded_object_detection(
            outputs, inputs.input_ids, threshold=0.25, text_threshold=0.25, target_sizes=target_sizes,
        )
    except TypeError:
        results = dino_processor.post_process_grounded_object_detection(
            outputs, inputs.input_ids, box_threshold=0.25, text_threshold=0.25, target_sizes=target_sizes,
        )
    return results[0]["boxes"].cpu().numpy().tolist()


def union_mask(image, boxes):
    if not boxes:
        return None
    inputs = sam_processor(image, input_boxes=[boxes], return_tensors="pt").to(DEVICE)
    with torch.no_grad():
        outputs = sam(**inputs)
    masks = sam_processor.image_processor.post_process_masks(
        outputs.pred_masks.cpu(), inputs["original_sizes"].cpu(), inputs["reshaped_input_sizes"].cpu()
    )[0].numpy()  # (num_boxes, masks_per_box, H, W)
    union = np.zeros(masks.shape[-2:], dtype=bool)
    for b in range(masks.shape[0]):
        union |= masks[b, 0]
    return union


@app.get("/")
def health():
    return {"status": "ok", "device": DEVICE}


@app.post("/segment")
async def segment(request: Request):
    body = await request.json()
    b64 = body.get("image_base64") or body.get("inputs")
    prompt = body.get("prompt", "roof")
    if not b64:
        return JSONResponse({"error": "image_base64 required"}, status_code=400)
    image = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
    w, h = image.size
    try:
        boxes = detect_boxes(image, prompt)
        mask = union_mask(image, boxes)
        if mask is None:
            return {"polygon": [], "width": w, "height": h}
        contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return {"polygon": [], "width": w, "height": h}
        c = max(contours, key=cv2.contourArea)
        eps = 0.01 * cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, eps, True)
        poly = [[int(p[0][0]), int(p[0][1])] for p in approx]
        return {"polygon": poly, "width": w, "height": h}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=500)
