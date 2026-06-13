import re
import cv2
import torch
import mlx_whisper
import numpy as np
from PIL import Image
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from transformers import AutoModelForCausalLM

app = FastAPI(title="Moondream VLM")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

print("Loading Moondream2...")
_model = AutoModelForCausalLM.from_pretrained(
    "vikhyatk/moondream2",
    trust_remote_code=True,
    dtype=torch.bfloat16,
    device_map="mps",
)
print("Moondream2 loaded.")

print("Will use mlx-whisper (tiny) for transcription.")

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


@app.get("/detect", response_model=DetectResponse)
def detect():
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

    reply = _model.query(
        pil_img,
        "Describe the surroundings ahead for a visually impaired person. "
        "Mention any obstacles or people in the path. "
        "End with danger level 0-3 (0=clear, 3=immediate danger)."
    )

    description = reply.get("answer", str(reply)) if isinstance(reply, dict) else str(reply)
    digits = re.findall(r"\b[0-3]\b", description)
    danger_level = int(digits[-1]) if digits else 0

    return DetectResponse(caption=description, danger_level=danger_level)


@app.post("/ask", response_model=AskResponse)
def ask(req: AskRequest):
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

    reply = _model.query(pil_img, req.prompt)
    answer = reply.get("answer", str(reply)) if isinstance(reply, dict) else str(reply)

    return AskResponse(answer=answer)


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    import subprocess, tempfile, os, wave, io

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

    result = mlx_whisper.transcribe(audio_arr)
    return {"text": result["text"].strip()}


@app.get("/")
def root():
    return {"status": "ok", "model": "moondream2"}


@app.on_event("shutdown")
def shutdown():
    if _cap is not None and _cap.isOpened():
        _cap.release()
