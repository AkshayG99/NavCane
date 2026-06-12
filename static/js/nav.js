let steps          = [];
let stepIdx        = 0;
let watchId        = null;
let routeGeometry  = [];
let isSimulated    = false;
let simInterval    = null;
let simIndex       = 0;

// Camera and object detection states
let stream         = null;
let detectInterval = null;
let cameraActive   = false;
let isSending      = false;

// Audio alerts state
let audioCtx       = null;
let soundMuted     = false;
let lastSpeechTime = 0;
let beepFrameCounter = 0;

const ADVANCE_RADIUS = 15; // meters

function speak(text) {
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.95;
  window.speechSynthesis.speak(u);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, p = Math.PI/180;
  const a = Math.sin((lat2-lat1)*p/2)**2 +
            Math.cos(lat1*p)*Math.cos(lat2*p)*Math.sin((lon2-lon1)*p/2)**2;
  return 2*R*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

function playBeep(frequency, duration) {
  try {
    if (!audioCtx) initAudio();
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    osc.type = 'sine';
    osc.frequency.value = frequency;
    
    gainNode.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
    
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + duration);
  } catch (err) {
    console.error("Web Audio Beep Error:", err);
  }
}

function getDirectionArrow(modifier) {
  const mod = (modifier || "").toLowerCase();
  if (mod.includes("left")) {
    if (mod.includes("slight")) return "↖️";
    if (mod.includes("sharp")) return "↩️";
    return "⬅️";
  }
  if (mod.includes("right")) {
    if (mod.includes("slight")) return "↗️";
    if (mod.includes("sharp")) return "↪️";
    return "➡️";
  }
  if (mod.includes("uturn")) return "🔄";
  if (mod.includes("arrive")) return "✅";
  return "⬆️";
}

function showStep(idx) {
  const stepBox = document.getElementById("step-box");
  const progressFill = document.getElementById("progress-fill");
  
  if (idx >= steps.length) {
    stepBox.style.display = "block";
    document.getElementById("step-num").textContent = "";
    document.getElementById("step-text").innerHTML = "<span style='color: var(--accent-green);'>✅ Arrived!</span>";
    document.getElementById("step-dist").textContent = "";
    document.getElementById("step-icon").textContent = "✅";
    document.getElementById("progress").textContent = "";
    progressFill.style.width = "100%";
    progressFill.style.backgroundColor = "var(--accent-green)";
    progressFill.style.boxShadow = "var(--glow-green)";
    
    speak("You have arrived at your destination.");
    stopNav();
    return;
  }
  
  const s = steps[idx];
  stepBox.style.display = "block";
  document.getElementById("step-num").textContent = `Step ${idx+1} of ${steps.length}`;
  document.getElementById("step-text").textContent = s.instruction;
  document.getElementById("step-dist").textContent = `~${s.distance}m away`;
  document.getElementById("step-icon").textContent = getDirectionArrow(s.modifier);
  document.getElementById("progress").textContent = `${steps.length - idx - 1} steps remaining`;
  
  // Update progress bar percentage
  const pct = (idx / steps.length) * 100;
  progressFill.style.width = `${pct}%`;
  progressFill.style.backgroundColor = "var(--accent-blue)";
  progressFill.style.boxShadow = "var(--glow-blue)";
  
  speak(s.instruction);
}

function onPosition(pos) {
  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
  const sourceText = isSimulated ? "Simulated GPS" : "Live GPS";
  
  document.getElementById("status").textContent =
    `${sourceText}: ${lat.toFixed(5)}, ${lon.toFixed(5)} (±${Math.round(pos.coords.accuracy || 3)}m)`;

  if (stepIdx >= steps.length) return;

  const next = steps[stepIdx];
  const dist = haversine(lat, lon, next.lat, next.lon);

  document.getElementById("step-dist").textContent = `~${Math.round(dist)}m away`;

  if (dist < ADVANCE_RADIUS) {
    stepIdx++;
    showStep(stepIdx);
  }
}

function toggleSim() {
  isSimulated = document.getElementById("sim-toggle").checked;
  const statusEl = document.getElementById("status");
  const gpsPill = document.getElementById("gps-pill");
  
  if (isSimulated) {
    statusEl.textContent = "Simulation Mode selected. Pick route and click Start.";
    gpsPill.className = "status-pill gps-simulated";
    gpsPill.textContent = "SIMULATOR";
    if (watchId) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  } else {
    statusEl.textContent = "Real GPS selected. Pick route and click Start.";
    gpsPill.className = "status-pill gps-inactive";
    gpsPill.textContent = "GPS INACTIVE";
    if (simInterval) {
      clearInterval(simInterval);
      simInterval = null;
    }
  }
}

function startSimulation() {
  if (simInterval) clearInterval(simInterval);
  simIndex = 0;
  
  if (routeGeometry.length === 0) {
    document.getElementById("status").textContent = "Error: No route geometry to simulate.";
    return;
  }
  
  document.getElementById("status").textContent = "Simulation starting...";
  
  simInterval = setInterval(() => {
    if (simIndex >= routeGeometry.length) {
      clearInterval(simInterval);
      // Trigger final arrival coordinate
      const finalPt = routeGeometry[routeGeometry.length - 1];
      onPosition({
        coords: {
          latitude: finalPt[1],
          longitude: finalPt[0],
          accuracy: 1
        }
      });
      return;
    }
    
    const pt = routeGeometry[simIndex];
    onPosition({
      coords: {
        latitude: pt[1],
        longitude: pt[0],
        accuracy: 3
      }
    });
    
    simIndex++;
  }, 1200); // Advances coordinate every 1.2s
}

async function startNav() {
  const start = document.getElementById("start").value;
  const end   = document.getElementById("end").value;
  if (!start || !end) { alert("Please select both a start and destination."); return; }
  if (start === end)  { alert("Start and destination cannot be the same."); return; }

  // Initialise Audio Context on user click
  initAudio();

  document.getElementById("go-btn").disabled = true;
  document.getElementById("start").disabled = true;
  document.getElementById("end").disabled = true;
  document.getElementById("sim-toggle").disabled = true;
  document.getElementById("stop-btn").disabled = false;
  document.getElementById("status").textContent = "Retrieving campus route...";

  try {
    const res  = await fetch(`/api/route?start=${start}&end=${end}`);
    const data = await res.json();
    if (data.error) {
      document.getElementById("status").textContent = "Error: " + data.error;
      stopNav();
      return;
    }

    steps          = data.steps;
    routeGeometry  = data.geometry || [];
    stepIdx        = 0;

    const gpsPill = document.getElementById("gps-pill");

    if (isSimulated) {
      gpsPill.className = "status-pill gps-simulated";
      gpsPill.textContent = "SIMULATOR";
      startSimulation();
    } else {
      gpsPill.className = "status-pill gps-active";
      gpsPill.textContent = "GPS LIVE";
      
      if (!navigator.geolocation) {
        alert("Geolocation is not supported by your browser.");
        stopNav();
        return;
      }
      
      watchId = navigator.geolocation.watchPosition(
        onPosition,
        err => { document.getElementById("status").textContent = "GPS Error: " + err.message; },
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
      );
    }

    showStep(0);
  } catch (err) {
    document.getElementById("status").textContent = "Fetch failed: " + err.message;
    stopNav();
  }
}

function stopNav() {
  if (watchId) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (simInterval) {
    clearInterval(simInterval);
    simInterval = null;
  }
  
  document.getElementById("go-btn").disabled = false;
  document.getElementById("start").disabled = false;
  document.getElementById("end").disabled = false;
  document.getElementById("sim-toggle").disabled = false;
  document.getElementById("stop-btn").disabled = true;
  
  const gpsPill = document.getElementById("gps-pill");
  gpsPill.className = "status-pill gps-inactive";
  gpsPill.textContent = "GPS INACTIVE";
  
  document.getElementById("status").textContent = "Navigation stopped.";
}

// ── Camera and Obstacle Detection logic ──────────────────────────────────────

async function toggleCamera() {
  const video = document.getElementById("video");
  const camBtn = document.getElementById("cam-btn");
  const placeholder = document.getElementById("cam-placeholder");
  
  initAudio(); // Initialize audio context on click
  
  if (cameraActive) {
    stopCamera();
    return;
  }
  
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 640 },
        height: { ideal: 480 }
      },
      audio: false
    });
    
    video.srcObject = stream;
    video.style.display = "block";
    placeholder.style.display = "none";
    cameraActive = true;
    
    camBtn.textContent = "📷 Disable Camera Vision";
    camBtn.classList.add("btn-active");
    
    startDetectionLoop();
  } catch (err) {
    alert("Camera initialization error: " + err.message + "\nNote: To run on your iPhone, host using HTTPS or access over local network (using local IP address).");
    console.error(err);
  }
}

function stopCamera() {
  const video = document.getElementById("video");
  const camBtn = document.getElementById("cam-btn");
  const placeholder = document.getElementById("cam-placeholder");
  
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }
  
  video.srcObject = null;
  video.style.display = "none";
  placeholder.style.display = "flex";
  cameraActive = false;
  
  camBtn.textContent = "📷 Enable Camera Vision";
  camBtn.classList.remove("btn-active");
  
  if (detectInterval) {
    clearInterval(detectInterval);
    detectInterval = null;
  }
  
  const avoidanceCard = document.getElementById("avoidance-card");
  if (avoidanceCard) {
    avoidanceCard.style.display = "none";
  }
  
  // Clear bounding box overlay
  const overlay = document.getElementById("canvas");
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  
  setHazardState(0);
}

function startDetectionLoop() {
  const video = document.getElementById("video");
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext("2d");
  
  if (detectInterval) clearInterval(detectInterval);
  isSending = false;
  
  detectInterval = setInterval(async () => {
    if (isSending || !cameraActive) return;
    if (video.readyState < 2) return; // Wait for video frame to be ready
    
    isSending = true;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.55);
    
    try {
      const res = await fetch("/api/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl })
      });
      const data = await res.json();
      isSending = false;
      
      if (data.ok) {
        drawDetections(data.detections, data.frame_width, data.frame_height);
        setHazardState(data.danger_level);
        handleSonarAndHaptics(data.danger_level, data.detections, data.frame_width, data.frame_height);
      }
    } catch (err) {
      console.error("Obstacle API Error:", err);
      isSending = false;
    }
  }, 300); // Run detection frames roughly every 300ms
}

function drawDetections(detections, fw, fh) {
  const overlay = document.getElementById("canvas");
  const ctx = overlay.getContext("2d");
  const video = document.getElementById("video");
  
  // Update canvas sizing to map perfectly over video box
  const rect = video.getBoundingClientRect();
  overlay.width = rect.width;
  overlay.height = rect.height;
  
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (detections.length === 0) return;
  
  const scaleX = overlay.width / fw;
  const scaleY = overlay.height / fh;
  
  detections.forEach(det => {
    const cname = (det.class_name || "").toLowerCase();
    const [x, y, w, h] = det.box;
    const sx = x * scaleX;
    const sy = y * scaleY;
    const sw = w * scaleX;
    const sh = h * scaleY;
    
    const cx = sx + sw/2;
    // Bounding boxes in the central 50% width are highlighted as core obstacles
    const isCenter = cx >= overlay.width * 0.25 && cx <= overlay.width * 0.75;
    
    // Custom colors depending on the class name
    let boxColor = "#ff9500"; // orange default
    if (cname === "person") boxColor = "#00c0ff"; // neon blue
    else if (cname.includes("bin")) boxColor = "#d45ffc"; // electric purple
    else if (cname.includes("chair") || cname.includes("bench")) boxColor = "#00ffcc"; // mint green
    
    ctx.lineWidth = 3;
    ctx.strokeStyle = isCenter ? "var(--accent-red)" : boxColor;
    ctx.strokeRect(sx, sy, sw, sh);
    
    // Bounding box labels
    ctx.fillStyle = isCenter ? "var(--accent-red)" : boxColor;
    ctx.font = "bold 12px sans-serif";
    const label = `${(det.class_name || "obstacle").toUpperCase()}: ${Math.round(det.confidence * 100)}%`;
    const textWidth = ctx.measureText(label).width;
    ctx.fillRect(sx, sy - 18, textWidth + 10, 18);
    
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, sx + 5, sy - 5);
  });
}

function setHazardState(level) {
  const camContainer = document.getElementById("camera-container");
  const banner = document.getElementById("alert-banner");
  
  camContainer.className = "camera-viewport";
  banner.style.display = "none";
  
  if (level === 1) {
    camContainer.classList.add("hazard-warning");
    banner.style.display = "block";
    banner.textContent = "⚠️ OBSTACLE AHEAD";
    banner.style.background = "#ff9500";
  } else if (level === 2) {
    camContainer.classList.add("hazard-danger");
    banner.style.display = "block";
    banner.textContent = "🚨 OBSTACLE CLOSE";
    banner.style.background = "var(--accent-red)";
  } else if (level === 3) {
    camContainer.classList.add("hazard-extreme");
    banner.style.display = "block";
    banner.textContent = "❌ DANGER: OBSTACLE IN PATH";
    banner.style.background = "var(--accent-red)";
  }
}

function toggleSound() {
  soundMuted = !soundMuted;
  const sndBtn = document.getElementById("sound-btn");
  sndBtn.textContent = soundMuted ? "🔇 Sound Muted" : "🔊 Sound Alerts";
  sndBtn.classList.toggle("btn-active", !soundMuted);
}

function handleSonarAndHaptics(level, detections, fw, fh) {
  const avoidanceCard = document.getElementById("avoidance-card");
  const avoidanceText = document.getElementById("avoidance-text");

  if (level === 0) {
    if (avoidanceCard) avoidanceCard.style.display = "none";
    return;
  }
  
  const now = Date.now();
  // Spoken voice alert: max once per 8 seconds to prevent overlapping speech synthesizer
  if (level >= 2 && now - lastSpeechTime > 8000 && detections) {
    // Find the closest threat in the center path to call it out specifically
    let threatLabel = "obstacle";
    let maxThreatRatio = 0;
    let threatBox = null;
    
    detections.forEach(det => {
      const cname = (det.class_name || "").toLowerCase();
      const [x, y, bw, bh] = det.box;
      const cx = x + bw / 2;
      const ncx = cx / fw;
      const nbh = bh / fh;
      
      // If it lies in the center 50%
      if (ncx >= 0.25 && ncx <= 0.75 && nbh > maxThreatRatio) {
        maxThreatRatio = nbh;
        threatBox = det.box;
        if (cname === "person") threatLabel = "person";
        else if (cname.includes("bin")) threatLabel = "bin";
        else if (cname.includes("chair") || cname.includes("bench")) threatLabel = "seating";
      }
    });
    
    // Calculate avoidance action based on threat position and size
    let avoidanceAction = "";
    let actionSpeak = "";
    
    if (threatBox) {
      const [tx, ty, tbw, tbh] = threatBox;
      const tcx = tx + tbw / 2;
      const ntcx = tcx / fw; // Normalized center x
      const ntbw = tbw / fw; // Normalized width
      const ntbh = tbh / fh; // Normalized height
      
      // If extremely close (large box height) or covers more than 40% of screen width
      if (ntbh > 0.55 || ntbw > 0.40) {
        avoidanceAction = "STOP";
        actionSpeak = "Stop.";
      } else if (ntcx < 0.5) {
        avoidanceAction = "SLIGHT RIGHT";
        actionSpeak = "Steer slight right.";
      } else {
        avoidanceAction = "SLIGHT LEFT";
        actionSpeak = "Steer slight left.";
      }
    }
    
    if (avoidanceCard && avoidanceText && avoidanceAction) {
      avoidanceText.textContent = `AVOID: ${avoidanceAction}`;
      avoidanceCard.style.display = "block";
      
      // Style color dynamically
      if (avoidanceAction === "STOP") {
        avoidanceText.style.color = "var(--accent-red)";
        avoidanceCard.style.borderColor = "var(--accent-red)";
      } else {
        avoidanceText.style.color = "var(--accent-green)";
        avoidanceCard.style.borderColor = "rgba(255, 255, 255, 0.1)";
      }
    }
    
    speak(`Warning: ${threatLabel} ahead. ${actionSpeak}`);
    lastSpeechTime = now;
  }
  
  // Vibration alert for iOS / iPhone devices (vibrates more intensely if closer)
  if (navigator.vibrate) {
    if (level === 3) {
      navigator.vibrate([200, 100, 200]);
    } else if (level === 2) {
      navigator.vibrate(150);
    } else if (level === 1) {
      navigator.vibrate(50);
    }
  }

  if (soundMuted) return;
  
  beepFrameCounter++;
  
  // Map beeping speed to danger level (synced with 300ms capture frequency)
  if (level === 3) {
    // Continuous warning beep
    playBeep(1100, 0.1);
  } else if (level === 2 && beepFrameCounter % 2 === 0) {
    // Beep every 600ms
    playBeep(850, 0.1);
  } else if (level === 1 && beepFrameCounter % 4 === 0) {
    // Beep every 1200ms
    playBeep(650, 0.1);
  }
}
