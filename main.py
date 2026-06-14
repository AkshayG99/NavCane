import base64
import json
import logging
import os
import time
from typing import AsyncGenerator

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
from openai import OpenAI
import io

import httpx
from elevenlabs.client import ElevenLabs
from gtts import gTTS
import uvicorn
from ultralytics import YOLO

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "AIzaSyDjpIY3PcGHaQOleGHqNtJ9WmBF7VfkF6A")
VISION_MODEL = os.getenv("VISION_MODEL", "gemini-2.5-flash")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llava:7b")
YOLO_MODEL = os.getenv("YOLO_MODEL", "yolo11m.pt")
PERSON_CONF = float(os.getenv("PERSON_CONFIDENCE", "0.5"))
MIN_DETECT_CONF = float(os.getenv("MIN_DETECT_CONF", "0.3"))
MAX_TOKENS = int(os.getenv("MAX_TOKENS", "128"))
VLM_IMAGE_MAX = int(os.getenv("VLM_IMAGE_MAX", "480"))
VLM_JPEG_QUALITY = int(os.getenv("VLM_JPEG_QUALITY", "80"))
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "sk_1039e2421ea3e171de6ff0e5784756651d2966a2a855df22")

SYSTEM_PROMPT = (
    "You are Ally, a real-time navigation assistant for a blind user. "
    "Look at the scene and identify obstacles (people, furniture, objects, hazards). "
    "For each obstacle, describe what it is and where it is, then tell the user "
    "exactly which direction to move: 'Move left', 'Move right', or 'Stop'. "
    "Keep responses short and actionable. "
    "Examples: 'Chair on your left. Move right.' — "
    "'Person directly ahead. Stop.' — "
    "'Table on your right. Move left.' — "
    "'Bicycle on the left. Move right.' — "
    "'Clear path ahead. No obstacles.'"
)

yolo = YOLO(YOLO_MODEL)
logger.info(f"YOLO model loaded: {YOLO_MODEL}")

vision_client = genai.Client(api_key=GOOGLE_API_KEY)
logger.info(f"Google AI client initialized, model: {VISION_MODEL}")

ollama_client = OpenAI(
    base_url=f"{OLLAMA_URL}/v1",
    api_key="ollama",
)

eleven_client = ElevenLabs(api_key=ELEVENLABS_API_KEY) if ELEVENLABS_API_KEY else None

COCO_CLASSES = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train",
    "truck", "boat", "traffic light", "fire hydrant", "stop sign",
    "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag",
    "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite",
    "baseball bat", "baseball glove", "skateboard", "surfboard",
    "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon",
    "bowl", "banana", "apple", "sandwich", "orange", "broccoli", "carrot",
    "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant",
    "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote",
    "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear",
    "hair drier", "toothbrush"
]


async def warmup_model():
    logger.info(f"Warming up vision model: {VISION_MODEL}...")
    try:
        dummy = np.zeros((10, 10, 3), dtype=np.uint8)
        _, buf = cv2.imencode(".jpg", dummy)
        image_part = types.Part.from_bytes(data=buf.tobytes(), mime_type="image/jpeg")
        _ = vision_client.models.generate_content(
            model=VISION_MODEL,
            contents=["describe", image_part],
        )
        logger.info(f"Vision model {VISION_MODEL} warmed up successfully")
    except Exception as e:
        logger.warning(f"Vision model warmup failed (non-critical): {e}")


app = FastAPI(title="Ally Vision Assistant", on_startup=[warmup_model])
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
os.makedirs(STATIC_DIR, exist_ok=True)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def get_zone(x1, x2, frame_w):
    cx = (x1 + x2) / 2
    ratio = cx / frame_w
    if ratio < 0.33:
        return "left"
    elif ratio > 0.66:
        return "right"
    return "center"


def run_yolo_detection(img):
    results = yolo(img, verbose=False, conf=MIN_DETECT_CONF)
    detections = []
    person_detected = False

    for r in results:
        for box in r.boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            conf = box.conf[0].item()
            cls_id = int(box.cls[0].item())
            label = r.names[cls_id] if cls_id < len(r.names) else "unknown"
            if label == "person" and conf >= PERSON_CONF:
                person_detected = True
            detections.append({
                "bbox": [round(v, 1) for v in (x1, y1, x2, y2)],
                "confidence": round(conf, 3),
                "label": label,
            })

    return detections, person_detected


def resize_for_vlm(img: np.ndarray, max_size: int = VLM_IMAGE_MAX):
    h, w = img.shape[:2]
    if max(h, w) > max_size:
        scale = max_size / max(h, w)
        new_w, new_h = int(w * scale), int(h * scale)
        img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return img


@app.get("/")
async def index():
    html_path = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(html_path):
        with open(html_path) as f:
            return HTMLResponse(f.read())
    return HTMLResponse("<h1>Ally Vision Assistant</h1><p>Frontend not found.</p>")


@app.get("/api/health")
async def health():
    ollama_ok = False
    try:
        import httpx
        r = httpx.get(f"{OLLAMA_URL}/api/tags", timeout=3.0)
        ollama_ok = r.status_code == 200
    except Exception:
        pass
    return {
        "status": "ok",
        "vision_model": VISION_MODEL,
        "yolo_model": YOLO_MODEL,
        "ollama": ollama_ok,
        "ollama_model": OLLAMA_MODEL,
        "yolo": "loaded",
    }


@app.post("/api/detect")
async def detect_objects(file: UploadFile = File(...)):
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        return {"detections": [], "person": False, "error": "bad image"}

    detections, person_detected = run_yolo_detection(img)
    return {"detections": detections, "person": person_detected, "count": len(detections)}


@app.post("/api/ask")
async def ask_question(file: UploadFile = File(...), question: str = Form(...)):
    contents = await file.read()

    nparr = np.frombuffer(contents, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    h, w, _ = img.shape

    detections, person_detected = run_yolo_detection(img)

    img_vlm = resize_for_vlm(img)
    _, vlm_buf = cv2.imencode(".jpg", img_vlm, [cv2.IMWRITE_JPEG_QUALITY, VLM_JPEG_QUALITY])
    vlm_contents = vlm_buf.tobytes()

    yolo_summary = ""
    if detections:
        obj_groups: dict[str, list[str]] = {}
        for d in detections:
            label = d["label"]
            zone = get_zone(d["bbox"][0], d["bbox"][2], w)
            if label not in obj_groups:
                obj_groups[label] = []
            if zone not in obj_groups[label]:
                obj_groups[label].append(zone)

        parts = []
        for label, zones in sorted(obj_groups.items()):
            quantity = sum(1 for d in detections if d["label"] == label)
            qty_str = f"{quantity}x " if quantity > 1 else ""
            parts.append(f"{qty_str}{label} ({', '.join(zones)})")

        yolo_summary = (
            "\n\n[Objects detected by sensor — always trust this as ground truth]:\n"
            + "\n".join(f"  - {p}" for p in parts)
            + "\n"
        )

    if person_detected:
        model_name = OLLAMA_MODEL
        client = ollama_client
        model_used = f"ollama/{model_name}"
        api_type = "openai"
        logger.info(f"[ROUTE] Person detected → using {model_used}")
    else:
        model_name = VISION_MODEL
        client = vision_client
        model_used = f"google/{model_name}"
        api_type = "gemini"
        logger.info(f"[ROUTE] No person → using {model_used}")

    full_prompt = f"{question}{yolo_summary}"

    async def generate() -> AsyncGenerator[str, None]:
        try:
            t0 = time.time()
            first_token = True

            if api_type == "openai":
                image_b64 = base64.b64encode(vlm_contents).decode("utf-8")
                image_data_url = f"data:image/jpeg;base64,{image_b64}"
                messages = [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": full_prompt},
                            {
                                "type": "image_url",
                                "image_url": {"url": image_data_url, "detail": "low"},
                            },
                        ],
                    },
                ]
                response = client.chat.completions.create(
                    model=model_name,
                    messages=messages,
                    stream=True,
                    max_tokens=MAX_TOKENS,
                    temperature=0.7,
                )
                for chunk in response:
                    if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
                        content = chunk.choices[0].delta.content
                        if first_token:
                            ttft = (time.time() - t0) * 1000
                            logger.info(f"[TTFT] {ttft:.0f}ms | {model_used}")
                            first_token = False
                        yield f"data: {json.dumps({'token': content, 'done': False})}\n\n"
            else:
                image_part = types.Part.from_bytes(
                    data=vlm_contents,
                    mime_type="image/jpeg",
                )
                response = client.models.generate_content_stream(
                    model=model_name,
                    contents=[full_prompt, image_part],
                    config=types.GenerateContentConfig(
                        system_instruction=SYSTEM_PROMPT,
                    ),
                )
                for chunk in response:
                    if chunk.text:
                        if first_token:
                            ttft = (time.time() - t0) * 1000
                            logger.info(f"[TTFT] {ttft:.0f}ms | {model_used}")
                            first_token = False
                        yield f"data: {json.dumps({'token': chunk.text, 'done': False})}\n\n"

            yield f"data: {json.dumps({'token': '', 'done': True, 'model': model_used})}\n\n"

        except Exception as e:
            logger.error(f"[STREAM ERROR] {e}")
            yield f"data: {json.dumps({'token': f'Error: {str(e)}', 'done': True, 'model': model_used})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/tts")
async def text_to_speech(request: Request):
    try:
        body = await request.json()
    except Exception:
        return StreamingResponse(iter(["invalid json"]), media_type="text/plain", status_code=400)
    text = body.get("text", "")
    lang = body.get("lang", "en")
    tld = body.get("tld", "com")
    if not text:
        return StreamingResponse(iter(["no text"]), media_type="text/plain", status_code=400)

    # Try ElevenLabs first if configured
    if ELEVENLABS_API_KEY:
        voice_id = body.get("voice_id", "")
        if voice_id:
            try:
                async with httpx.AsyncClient() as client:
                    resp = await client.post(
                        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream",
                        headers={"xi-api-key": ELEVENLABS_API_KEY},
                        json={"text": text, "model_id": "eleven_v3", "output_format": "mp3_44100_128"},
                    )
                    if resp.is_success:
                        async def gen_el():
                            async for chunk in resp.aiter_bytes():
                                yield chunk
                        return StreamingResponse(gen_el(), media_type="audio/mpeg")
                    logger.warning(f"ElevenLabs returned {resp.status_code}, falling back to gTTS")
            except Exception as e:
                logger.warning(f"ElevenLabs error: {e}, falling back to gTTS")

    # gTTS fallback (free, no key needed)
    try:
        tts = gTTS(text=text, lang=lang, tld=tld)
        buf = io.BytesIO()
        tts.write_to_fp(buf)
        buf.seek(0)
        return StreamingResponse(iter([buf.read()]), media_type="audio/mpeg")
    except Exception as e:
        logger.error(f"gTTS error: {e}")
        return StreamingResponse(iter([str(e)]), media_type="text/plain", status_code=500)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    logger.info(f"Starting Ally server on 0.0.0.0:{port}")
    logger.info(f"Vision model: {VISION_MODEL}, YOLO model: {YOLO_MODEL}, Ollama model: {OLLAMA_MODEL}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
