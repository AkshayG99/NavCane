import re
import io
import base64
import cv2
from faster_whisper import WhisperModel
import numpy as np
from PIL import Image
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from huggingface_hub import InferenceClient
from dotenv import load_dotenv
import os
from pathlib import Path

load_dotenv(Path(__file__).parent / ".env")

HF_TOKEN = os.environ["HF_TOKEN"]
HF_MODEL = os.environ["HF_MODEL"]
DETECT_PROMPT = (
    "Describe the surroundings ahead for a visually impaired person. "
    "Mention any obstacles or people in the path. "
    "End with danger level 0-3 (0=clear, 3=immediate danger)."
)

app = FastAPI(title="NavCane API (Gemma 4)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

print("Initializing HF Inference client...")
_client = InferenceClient(token=HF_TOKEN)
print("Connected to HF Inference API.")

print("Loading faster-whisper (tiny, int8)...")
_whisper = WhisperModel("tiny", device="cpu", compute_type="int8")
print("faster-whisper loaded.")

_cap = cv2.VideoCapture(0)
if not _cap.isOpened():
    print("Warning: Could not open webcam at startup.")
else:
    print("Webcam opened.")


class DetectResponse(BaseModel):
    caption: str
    danger_level: int


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
    pil_img = Image.fromarray(rgb)
    buf = io.BytesIO()
    pil_img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()


def _ask_gemma(user_prompt: str, max_tokens: int = 512) -> str:
    b64 = _capture_frame()
    result = _client.chat.completions.create(
        model=HF_MODEL,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                {"type": "text", "text": user_prompt},
            ],
        }],
        max_tokens=max_tokens,
        temperature=1.0,
        top_p=0.95,
    )
    return result.choices[0].message.content


@app.get("/detect", response_model=DetectResponse)
def detect():
    description = _ask_gemma(DETECT_PROMPT)
    digits = re.findall(r"\b[0-3]\b", description)
    danger_level = int(digits[-1]) if digits else 0
    return DetectResponse(caption=description, danger_level=danger_level)


@app.post("/ask", response_model=AskResponse)
def ask(req: AskRequest):
    answer = _ask_gemma(req.prompt)
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

    segments, _info = _whisper.transcribe(audio_arr, language="en")
    text = "".join(seg.text for seg in segments)
    return {"text": text.strip()}


@app.get("/")
def root():
    return {"status": "ok", "model": "gemma-4-26B-A4B-it"}


@app.on_event("shutdown")
def shutdown():
    if _cap is not None and _cap.isOpened():
        _cap.release()
