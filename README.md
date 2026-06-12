# 🧭 CANE-NAV: Campus Navigation & Obstacle Avoidance Assistant

CANE-NAV is a premium web application designed to assist visually impaired individuals with campus navigation and real-time obstacle avoidance. The project combines **OSRM Foot Routing**, **YOLOv8 Computer Vision**, and a **Web Audio Sonar Feedback Engine** to provide spatial awareness and voice steering guidance.

---

## 🌟 Core Features

### 1. Real-time Campus Navigation
- Calculates walking paths between University of Waterloo (UW) landmarks using the **OSRM Foot Router**.
- Uses the browser's Geolocation API (`watchPosition`) to track current coordinates.
- Speaks turn-by-turn navigation instructions dynamically using the **Web Speech API** (`window.speechSynthesis`).

### 2. Live GPS Path Simulator
- Allows developer testing from a desk without being physically on campus.
- Mocks walking speed (interpolating along the OSRM path coordinates every second).
- Automatically triggers next steps and reads vocal prompts as the simulated position nears turn waypoints (radius < 15m).

### 3. YOLOv8 Obstacle Detection
- Receives camera frames compressed to JPEG base64 every 300ms from the user's phone.
- Runs **YOLOv8** (`yolov8n.pt`) on the backend to detect sidewalk obstacles:
  - **People**
  - **Trash Bins / Canisters** (maps COCO `suitcase`, `toilet`, and `refrigerator` misclassifications)
  - **Seating / Benches / Chairs**
  - **Vehicles / Bicycles**
  - **Personal Items / Bags**
- Automatically falls back to OpenCV's built-in **HOG Pedestrian Detector** if YOLO is unavailable, ensuring high reliability.

### 4. AR Viewfinder HUD & Sonar Feedback
- Displays the camera feed with color-coded bounding boxes overlaid dynamically on a Canvas.
- **Audio Sonar warning**: Synthesizes warning chirps using the **Web Audio API** (no external MP3 downloads required). Pitch and beeping rate increase as obstacles get closer, mimicking a parking sensor.
- **Steer Avoidance Guide**: A HUD panel slides up and flashes steering directions (e.g., `AVOID: SLIGHT LEFT`, `AVOID: SLIGHT RIGHT`, or `AVOID: STOP`) based on the obstacle's horizontal location and relative width.

---

## 📂 Modular Architecture & File Structure

The project is structured cleanly with separate files for backend routing, computer vision, HTML templates, CSS styles, and client-side JavaScript controllers:

```
JamHacks/
├── app.py                   # Main Flask server entry point & web route configurations
├── routing.py               # Campus landmarks, Haversine distance helper, and OSRM walking path API
├── vision.py                # YOLOv8 object detector, fallback HOG detector, and image processing
├── templates/
│   └── index.html           # Main HTML5 page template with Jinja2 option loops
└── static/
    ├── css/
    │   └── style.css        # Premium dark glassmorphism styling sheet
    └── js/
        └── nav.js           # Client GPS navigation, path simulator, audio osc synth, and steering HUD
```

### Module Descriptions

*   **`app.py`**: The entry point for the Flask server. It defines routes for serving the home page (`/`), route planning (`/api/route`), location coordinate checking (`/api/check_step`), and camera frame obstacle detection (`/api/detect`).
*   **`routing.py`**: Contains the landmark coordinate dictionary, mathematical `haversine` formula, navigation instruction parser, and handles fetch request construction to the external Open Source Routing Machine (OSRM).
*   **`vision.py`**: Houses the preloaded YOLOv8 model instance, target obstacle class mappings, risk assessment logic (assigning `danger_level` based on proximity and threat angle), and standard HOG detection fallback.
*   **`templates/index.html`**: Clean HTML5 semantic markup structure representing status indicators, controls panel, viewfinder container, warning overlay, and instructions card.
*   **`static/css/style.css`**: Defines modern, dark glassmorphism design parameters, responsive layouts, alert pulse keyframes, status pills, control grids, and HUD styling rules.
*   **`static/js/nav.js`**: Core client-side execution loop managing browser Geolocation, coordinate simulator interval, speech synthesis queues, Web Audio oscillator beeps, canvas rendering contexts for bounding box overlays, and steering computations.

---

## 🚀 How to Run and Test

### 1. Start the Flask Backend
Navigate to the project root directory and run the server using the virtual environment:
```bash
./path/to/venv/bin/python -u app.py
```
The server will start over standard HTTP on port `8080` (listening on all local network interfaces: `0.0.0.0`).

### 2. Test Locally in a Desktop Browser
1. Open **`http://localhost:8080`** in Chrome or Safari.
2. Select a **Start Location** and a **Destination**.
3. Toggle **Route Simulation Mode** on.
4. Click **Start Navigation** to watch the simulated GPS marker move along the path, count down distances, and speak instructions.
5. Click **Enable Camera Vision** to authorize webcam access and test obstacle overlays.

### 3. Test on your iPhone (with Camera & Haptics)
Modern mobile browsers block camera access (`getUserMedia`) on raw IP addresses over HTTP. To bypass this securely, use a proxy tunnel like **Localtunnel** to expose the server over a trusted HTTPS domain:

1. Keep your Flask server running on port `8080`.
2. In a separate terminal window, open a secure tunnel:
   ```bash
   npx localtunnel --port 8080
   ```
3. Copy the secure public URL generated (e.g., `https://nasty-peaches-allow.loca.lt`).
4. Find your machine's public IPv4 address (run `curl icanhazip.com` or look it up).
5. Open Safari on your iPhone, enter the public URL, and input the public IP when prompted by the Localtunnel anti-phishing splash screen.
6. Once the page loads, click **Enable Camera Vision** and grant camera permissions!

---

## ⚙️ Development Configs

- **Avoidance Steering Math**: Steers left or right depending on whether the obstacle's center of gravity lies in the left-center or right-center of the camera column.
- **Audio Synth Details**: Web Audio API oscillator generates `sine` waves starting at 650Hz (warning) up to 1100Hz (extreme danger) with custom envelope decays to make beeps comfortable yet urgent.
- **Vibration Haptics**: Uses `navigator.vibrate` to provide tactile alert pulses directly to the cane user's hand.
