import cv2
import numpy as np
import base64
from google import genai
from google.genai import types

API_KEY = "AIzaSyCzJUCUdtY-pQj_Ho7MAi629_me0KPfrE4"
MODEL = "gemma-4-26b-a4b-it"
client = genai.Client(api_key=API_KEY)

PROMPT = (
    "You are a blind person's navigation guide. "
    "Name only what is in your way and its position (e.g. 'person close left', 'chair ahead', 'clear'). "
    "Then give a short steering direction (<6 words). "
    "Format: OBSTACLE: ... | DIRECTION: ..."
)

def analyze_frame(img_data_str):
    if "," in img_data_str:
        img_data_str = img_data_str.split(",")[1]

    try:
        img_bytes = base64.b64decode(img_data_str)
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            return None, "Failed to decode image"
    except Exception as e:
        return None, f"Failed to parse image: {str(e)}"

    h, w, _ = img.shape
    description = ""
    detail = ""

    try:
        img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        _, buf = cv2.imencode(".jpg", img_rgb)
        img_part = types.Part.from_bytes(data=buf.tobytes(), mime_type="image/jpeg")

        resp = client.models.generate_content(model=MODEL, contents=[img_part, PROMPT])
        raw = resp.text.strip()
        print(f"[Gemma] {raw}")

        parts = raw.split("| DIRECTION:", 1)
        if len(parts) == 2:
            detail = parts[0].replace("OBSTACLE:", "").strip()
            description = parts[1].strip()
        else:
            detail = raw
            description = ""

        lower = description.lower()
        if "clear path" in lower or not description:
            danger_level = 0
            description = ""
        else:
            danger_level = 3 if any(k in lower for k in ["stop", "close", "directly", "front"]) else 2

    except Exception as e:
        print("Gemma error:", e)
        return None, "Analysis failed"

    return {
        "detections": [],
        "danger_level": danger_level,
        "description": description,
        "detail": detail,
        "frame_width": w,
        "frame_height": h
    }, None
