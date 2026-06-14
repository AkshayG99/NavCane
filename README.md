# Ally — Vision Assistant

A real-time vision assistant that detects people in camera frames and routes image understanding to the right model, with YOLO object detection as the primary source of truth:

- **No person detected** → **Google Gemini 2.5 Flash** (vision AI, cloud)
- **Person detected** → **Ollama open-source VLM** (llava, local)
- **Object identification** → **YOLO11m** (purpose-built detector, 80+ classes)

---

## Quick Start

### 1. Set up Python environment

```bash
python3 -m venv venv
source venv/bin/activate
pip install -U pip
pip install -r requirements.txt
```

### 2. (Optional) Install Ollama for person detection path

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh

ollama pull llava:7b
ollama serve
```

### 3. Run the server

```bash
python3 main.py
```

Open **http://localhost:8000** in your browser.

---

## How It Works

```
User asks question → Capture frame → YOLO11m detection (primary)
                        ↓
              Objects found (ground truth)
              + Gemini scene context
                        ↓
              ┌── Person? ──┐
              ↓              ↓
        Ollama VLM    Gemini 2.5 Flash
     (open-source)    (Google Vision)
              ↓              ↓
         Streamed response via SSE
              ↓
        Frontend displays tokens
```

### Object Identification (YOLO-first approach)
1. YOLO11m runs on every frame — detects 80+ object types with bounding boxes and confidence scores
2. Objects are **always reported as ground truth** — the user is told exactly what's detected and where (left/center/right)
3. The vision model adds context around the YOLO detections (scene type, relationships, hazards)

### Model Routing
1. User asks a question → current camera frame is captured
2. YOLO11m detects all objects + checks for people
3. **No person** → Gemini 2.5 Flash describes the scene with full vision capability
4. **Person detected** → Ollama's open-source model describes the entire image
5. YOLO detections are **injected as text context** so the model never misses small objects
6. Response is **streamed** via Server-Sent Events

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Frontend UI |
| `/api/detect` | POST | YOLO object detection on image |
| `/api/ask` | POST | Ask question about image (streams SSE) |
| `/api/health` | GET | Server status |

### `/api/ask`
- **Input**: `file` (image) + `question` (text) as multipart form
- **Output**: Server-Sent Events stream
  ```
  data: {"token": "I can see...", "done": false}
  data: {"token": " a bottle", "done": false}
  ...
  data: {"token": "", "done": true, "model": "google/gemini-2.5-pro"}
  ```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_API_KEY` | (provided) | Google GenAI API key |
| `VISION_MODEL` | `gemini-2.5-flash` | Model for non-person images |
| `YOLO_MODEL` | `yolo11m.pt` | YOLO model variant (n/s/m/l/x) |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llava:7b` | Model for person images |
| `PERSON_CONFIDENCE` | `0.5` | YOLO confidence for person detection |
| `MIN_DETECT_CONF` | `0.3` | Minimum confidence for all detections |
| `MAX_TOKENS` | `1024` | Max response tokens |
| `PORT` | `8000` | Server port |

---

## Performance Notes

- **YOLO11m** runs in ~60-100ms per frame — detects small objects like bottles, cups, phones reliably
- **Gemini 2.5 Flash** via Google API achieves ~200-800ms TTFT (fast, capable vision model)
- **Ollama + llava:7b** achieves ~200-400ms TTFT on Apple Silicon
- Detection runs every 1.5s; all processing is async
- Object identification is **YOLO-driven**, not VLM-driven — small object accuracy is significantly better
