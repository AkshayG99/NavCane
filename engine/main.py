import re
import io
import base64
import cv2
from pywhispercpp.model import Model as WhisperModel
import numpy as np
from PIL import Image
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import requests
from dotenv import load_dotenv
import os
from pathlib import Path

load_dotenv(Path(__file__).parent / ".env")

GEMINI_KEY = os.environ["GEMINI_API_KEY"]
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemma-4-e4b-it")
_GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_KEY}"

DETECT_PROMPT = (
    "You are a guide for a blind person. "
    "Describe what is directly ahead in 1-2 sentences — "
    "name any people, objects, or obstacles and where they are "
    "(left, right, center, close, far). "
    "End with a clear direction like \"Move left\" or \"Stop, obstacle ahead\"."
)

app = FastAPI(title="NavCane API (Gemma 4 E4B)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

print(f"Gemma 4 E4B via Gemini API (model: {GEMINI_MODEL}).")

print("Loading whisper.cpp (base)...")
_whisper = WhisperModel("base", n_threads=8)
print("whisper.cpp loaded.")

_cap = cv2.VideoCapture(0)
if not _cap.isOpened():
    print("Warning: Could not open webcam at startup.")
else:
    print("Webcam opened.")


class DetectResponse(BaseModel):
    detail: str
    steer: str


class AskRequest(BaseModel):
    prompt: str


class AskResponse(BaseModel):
    answer: str


def _capture_frame() -> str:
    global _cap
    if _cap is None or not _cap.isOpened():
        _cap = cv2.VideoCapture(0)
    if not _cap.isOpened():
        raise HTTPException(500, "Could not open webcam")

    ret, frame = _cap.read()
    if not ret:
        raise HTTPException(500, "Failed to read frame from webcam")

    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    pil_img = Image.fromarray(rgb).resize((448, 448), Image.LANCZOS)
    buf = io.BytesIO()
    pil_img.save(buf, format="JPEG", quality=60)
    return base64.b64encode(buf.getvalue()).decode()


def _ask_vlm(user_prompt: str, max_tokens: int = 150) -> str:
    b64 = _capture_frame()
    body = {
        "contents": [{
            "parts": [
                {"inline_data": {"mime_type": "image/jpeg", "data": b64}},
                {"text": user_prompt},
            ]
        }],
        "generationConfig": {
            "maxOutputTokens": max_tokens,
            "temperature": 0.0,
        },
    }
    resp = requests.post(_GEMINI_URL, json=body, timeout=30)
    if resp.status_code == 429:
        raise HTTPException(503, "VLM rate-limited, wait a moment")
    if resp.status_code != 200:
        raise HTTPException(502, f"Gemini API error {resp.status_code}: {resp.text[:200]}")
    parts = resp.json()["candidates"][0]["content"]["parts"]
    return "".join(p["text"] for p in parts if not p.get("thought"))


_DIRECTION_WORDS = [
    "left", "right", "straight", "ahead", "forward", "back",
    "stop", "wait", "careful", "slow", "up", "down",
]


def _extract_steer(text: str) -> str:
    last_sentence = text.split(".")[-1].strip().lower()
    for word in _DIRECTION_WORDS:
        if word in last_sentence:
            return last_sentence
    return ""


@app.get("/detect", response_model=DetectResponse)
def detect():
    raw = _ask_vlm(DETECT_PROMPT)
    return DetectResponse(detail=raw, steer=_extract_steer(raw))


@app.post("/ask", response_model=AskResponse)
def ask(req: AskRequest):
    answer = _ask_vlm(req.prompt)
    return AskResponse(answer=answer)


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    import subprocess, tempfile, os, wave

    data = await audio.read()

    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    wav_path = tmp_path + ".wav"
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", tmp_path, "-ar", "16000", "-ac", "1",
             "-sample_fmt", "s16", wav_path],
            capture_output=True, check=True,
        )

        with wave.open(wav_path, "rb") as wav:
            frames = wav.readframes(wav.getnframes())
        audio_arr = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    finally:
        os.unlink(tmp_path)
        if os.path.exists(wav_path):
            os.unlink(wav_path)

    segments = _whisper.transcribe(audio_arr)
    text = "".join(seg.text for seg in segments)
    return {"text": text.strip()}


@app.get("/")
def root():
    return {"status": "ok", "model": f"gemma-4-e4b-it (via Gemini API)"}


@app.on_event("shutdown")
def shutdown():
    if _cap is not None and _cap.isOpened():
        _cap.release()
