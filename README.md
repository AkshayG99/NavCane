# NavCane — Campus Navigation & Obstacle Avoidance Assistant

NavCane is a web application that helps visually impaired individuals navigate University of Waterloo campus. It combines **OSRM foot routing** with **Moondream VLM** for real-time obstacle avoidance and steering guidance.

---

## Core Features

### 1. Real-time Campus Navigation
- Walking paths between UW landmarks via the **OSRM Foot Router**.
- Browser Geolocation API (`watchPosition`) tracks your current position.
- Turn-by-turn voice instructions spoken via **Web Speech API**.

### 2. Live GPS Path Simulator
- Test from your desk without being on campus.
- Mocks walking speed along the route geometry.

### 3. Moondream VLM Obstacle Guidance
- Camera frames sent to the backend every 300ms.
- **Moondream 0.5B VLM** analyses the scene and returns short steering instructions (e.g. "go left, person ahead", "move right, bin in way").
- No YOLO or bounding boxes — pure natural-language scene understanding.

### 4. Audio Sonar & Haptic Feedback
- **Audio Sonar**: Beep pitch and rate increase as danger level rises (parking-sensor style).
- **Voice Alerts**: Spoken steering instructions through the Web Speech API.
- **Vibration Haptics**: `navigator.vibrate` pulses tactile alerts on supported devices.

---

## File Structure

```
NavCane/
├── app.py                   # Flask server entry point & web routes
├── routing.py               # Campus landmarks, OSRM routing, instruction builder
├── vision.py                # Moondream VLM — obstacle analysis & steering guidance
├── webcam_moondream.py      # Standalone webcam tester for Moondream
├── templates/
│   └── index.html           # Main HTML page
└── static/
    ├── css/
    │   └── style.css        # Dark glassmorphism styling
    └── js/
        └── nav.js           # Client-side navigation, camera, sonar, HUD
```

---

## How to Run

### 1. Start the Flask Backend
```bash
venv/bin/python -u app.py
```
Server starts on `http://0.0.0.0:8080`.

### 2. Test in Browser
1. Open `http://localhost:8080`.
2. Pick a start and destination.
3. Toggle **Route Simulation Mode** on for desk testing.
4. Click **Start Navigation**.
5. Click **Enable Camera Vision** to activate Moondream obstacle guidance.

### 3. Test on iPhone (Camera requires HTTPS)
Use a tunnel like **Localtunnel**:
```bash
npx localtunnel --port 8080
```

---

## How It Works

### Navigation Flow
1. User selects start/end landmarks.
2. Flask calls OSRM API for a foot-walking route.
3. Browser tracks GPS (real or simulated) and speaks turn instructions.
4. When within 15m of a waypoint, automatically advances to the next step.

### Obstacle Guidance Flow
1. Browser captures a 320×240 JPEG frame every 300ms.
2. Frame is sent to `/api/detect` on the Flask backend.
3. `vision.py` decodes the image and feeds it to Moondream VLM with a steering prompt.
4. Moondream returns a short steering instruction and `danger_level` (0 = clear, 2 = warning, 3 = danger).
5. Browser displays a HUD alert, speaks the instruction, plays sonar beeps, and vibrates.
