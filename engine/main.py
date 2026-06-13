import cv2
import base64
from io import BytesIO
from pywhispercpp.model import Model as WhisperModel
import numpy as np
from PIL import Image
from huggingface_hub import InferenceClient
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import os
from pathlib import Path

load_dotenv(Path(__file__).parent / ".env")

HF_TOKEN = os.environ["HF_TOKEN"]
_hf_client = InferenceClient(token=HF_TOKEN, model="google/gemma-4-E2B-it")

DETECT_PROMPT = (
    "You are a guide for a blind person. "
    "Describe what is directly ahead in 1-2 sentences — "
    "name any people, objects, or obstacles and where they are "
    "(left, right, center, close, far). "
    "End with a clear direction like \"Move left\" or \"Stop, obstacle ahead\"."
)

app = FastAPI(title="NavCane API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

print("whisper.cpp will be lazily loaded on first use.")

_whisper = None

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


def _capture_img() -> Image.Image:
    global _cap
    if _cap is None or not _cap.isOpened():
        _cap = cv2.VideoCapture(0)
    if not _cap.isOpened():
        raise HTTPException(500, "Could not open webcam")

    ret, frame = _cap.read()
    if not ret:
        raise HTTPException(500, "Failed to read frame from webcam")

    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    return Image.fromarray(rgb)


def _get_whisper():
    global _whisper
    if _whisper is None:
        print("Loading whisper.cpp (base)...")
        _whisper = WhisperModel("base", n_threads=8)
        print("whisper.cpp loaded.")
    return _whisper


def _ask_vlm(user_prompt: str, max_tokens: int = 500) -> str:
    pil_img = _capture_img()
    buffered = BytesIO()
    pil_img.save(buffered, format="PNG")
    img_b64 = base64.b64encode(buffered.getvalue()).decode("utf-8")

    reply = _hf_client.chat_completion(
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
                    {"type": "text", "text": user_prompt},
                ],
            },
        ],
        max_tokens=max_tokens,
    )
    return reply.choices[0].message.content.strip()


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

    segments = _get_whisper().transcribe(audio_arr)
    text = "".join(seg.text for seg in segments)
    return {"text": text.strip()}


@app.get("/")
def root():
    return {"status": "ok", "model": "google/gemma-4-E2B-it (HF Inference API)"}


@app.on_event("shutdown")
def shutdown():
    if _cap is not None and _cap.isOpened():
        _cap.release()
