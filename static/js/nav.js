let steps          = [];
let stepIdx        = 0;
let watchId        = null;
let routeGeometry  = [];
let isSimulated    = false;
let simInterval    = null;
let simIndex       = 0;

// Leaflet map variables
let map = null;
let routePolyline = null;
let userMarker = null;

// Camera and object detection states
let stream         = null;
let detectInterval = null;
let cameraActive   = false;
let isSending      = false;

// Audio alerts state
let audioCtx       = null;
let soundMuted     = false;
let driftAudioMuted = false;
let lastSpeechTime = 0;
let beepFrameCounter = 0;

// Path alignment and turning correction states
let deviceHeading = null;
let wasDrifting = false;
let wasMisaligned = false;
let lastDriftCorrectionTime = 0;
let lastHeadingCorrectionTime = 0;
let currentSimBasePt = null;

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

function getBearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const lat1Rad = lat1 * Math.PI / 180;
  const lat2Rad = lat2 * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
  let brng = Math.atan2(y, x) * 180 / Math.PI;
  return (brng + 360) % 360;
}

function getSegmentBearing(a, b) {
  return getBearing(a[1], a[0], b[1], b[0]);
}

function getCrossTrackError(p, a, b) {
  // p: [lon, lat], a: [lon, lat], b: [lon, lat]
  const latRef = a[1];
  const cosLat = Math.cos(latRef * Math.PI / 180);
  
  // Convert coordinates to local Cartesian in meters
  const ax = 0;
  const ay = 0;
  const bx = (b[0] - a[0]) * 111320 * cosLat;
  const by = (b[1] - a[1]) * 110540;
  const px = (p[0] - a[0]) * 111320 * cosLat;
  const py = (p[1] - a[1]) * 110540;
  
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  
  const L2 = vx * vx + vy * vy;
  let t = 0;
  if (L2 > 0) {
    t = (wx * vx + wy * vy) / L2;
    t = Math.max(0, Math.min(1, t));
  }
  
  const cx = ax + t * vx;
  const cy = ay + t * vy;
  
  const dx = px - cx;
  const dy = py - cy;
  const distance = Math.sqrt(dx * dx + dy * dy);
  
  const cross = vx * wy - vy * wx;
  let side = "on_path";
  if (cross > 0.01) {
    side = "left";
  } else if (cross < -0.01) {
    side = "right";
  }
  
  const projLon = a[0] + cx / (111320 * cosLat);
  const projLat = a[1] + cy / 110540;
  
  return {
    distance: distance,
    side: side,
    projectedPoint: [projLon, projLat]
  };
}

function findClosestSegment(p, geometry) {
  if (geometry.length < 2) return null;
  let minDistance = Infinity;
  let closestSegmentIdx = 0;
  let closestProjectedPt = null;
  let closestSide = "on_path";
  
  for (let i = 0; i < geometry.length - 1; i++) {
    const a = geometry[i];
    const b = geometry[i+1];
    const res = getCrossTrackError(p, a, b);
    if (res.distance < minDistance) {
      minDistance = res.distance;
      closestSegmentIdx = i;
      closestProjectedPt = res.projectedPoint;
      closestSide = res.side;
    }
  }
  
  return {
    index: closestSegmentIdx,
    distance: minDistance,
    projectedPoint: closestProjectedPt,
    side: closestSide
  };
}

window.addEventListener("deviceorientation", (event) => {
  if (event.webkitCompassHeading !== undefined) {
    deviceHeading = event.webkitCompassHeading;
  } else if (event.alpha !== null) {
    deviceHeading = (360 - event.alpha) % 360;
  }
});

window.addEventListener("deviceorientationabsolute", (event) => {
  if (event.alpha !== null) {
    deviceHeading = (360 - event.alpha) % 360;
  }
});


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
    stepBox.style.display = "flex";
    document.getElementById("step-num").style.display = "none";
    document.getElementById("step-text").innerHTML = "<span style='color: var(--accent-green);'>✅ Arrived!</span>";
    document.getElementById("step-dist").textContent = "Arrived";
    document.getElementById("step-icon").textContent = "✅";
    document.getElementById("progress").textContent = "";
    progressFill.style.width = "100%";
    
    speak("You have arrived at your destination.");
    stopNav();
    return;
  }
  
  const s = steps[idx];
  stepBox.style.display = "flex";
  document.getElementById("step-num").style.display = "block";
  document.getElementById("step-num").textContent = `Step ${idx+1} of ${steps.length}`;
  document.getElementById("step-text").textContent = s.instruction;
  document.getElementById("step-dist").textContent = `~${s.distance}m`;
  document.getElementById("step-icon").textContent = getDirectionArrow(s.modifier);
  document.getElementById("progress").textContent = `${steps.length - idx - 1} steps remaining`;
  
  // Update progress bar percentage
  const pct = (idx / steps.length) * 100;
  progressFill.style.width = `${pct}%`;
  
  speak(s.instruction);
}

function onPosition(pos) {
  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
  const sourceText = isSimulated ? "Simulated" : "Live GPS";
  
  document.getElementById("status").textContent =
    `${sourceText}: ${lat.toFixed(5)}, ${lon.toFixed(5)} (±${Math.round(pos.coords.accuracy || 3)}m)`;

  // Update Leaflet map marker
  if (map) {
    const userLatLng = [lat, lon];
    const userIcon = L.divIcon({
      className: 'custom-user-marker',
      html: '<div class="user-location-dot"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });
    
    if (!userMarker) {
      userMarker = L.marker(userLatLng, { icon: userIcon }).addTo(map);
      map.setView(userLatLng, 18);
    } else {
      userMarker.setLatLng(userLatLng);
      map.panTo(userLatLng);
    }
  }

  if (stepIdx >= steps.length) return;

  const next = steps[stepIdx];
  const dist = haversine(lat, lon, next.lat, next.lon);

  document.getElementById("step-dist").textContent = `~${Math.round(dist)}m`;

  if (dist < ADVANCE_RADIUS) {
    stepIdx++;
    showStep(stepIdx);
  }

  // --- PATH ALIGNMENT & DRIFT MONITORING ---
  if (routeGeometry && routeGeometry.length >= 2) {
    const closest = findClosestSegment([lon, lat], routeGeometry);
    if (closest) {
      const segA = routeGeometry[closest.index];
      const segB = routeGeometry[closest.index + 1];
      const pathHeading = getSegmentBearing(segA, segB);
      
      // Determine user heading (live or simulated)
      let userHeading = null;
      if (isSimulated && pos.coords.heading !== undefined && pos.coords.heading !== null) {
        userHeading = pos.coords.heading;
      } else if (deviceHeading !== null) {
        userHeading = deviceHeading;
      } else if (pos.coords.heading !== null && pos.coords.heading !== undefined) {
        userHeading = pos.coords.heading;
      }
      
      // Update HUD panel
      updateHUD(closest.distance, closest.side, pathHeading, userHeading);
      
      // Update dynamic remaining metrics in Apple drawer
      const remainingDist = getRemainingDistance([lon, lat], closest.index, routeGeometry);
      const remainingMin = Math.max(1, Math.round(remainingDist / 1.3 / 60));
      updateTripMetrics(remainingDist, remainingMin);
      
      // Check for Drift and Turning corrections
      handleDriftAndTurnCorrections(closest.distance, closest.side, pathHeading, userHeading);
    }
  }
}

function updateHUD(driftDist, driftSide, pathHeading, userHeading) {
  const hudPanel = document.getElementById("hud-panel");
  if (!hudPanel) return;
  
  hudPanel.style.display = "block";
  
  // Update drift visual
  const driftValEl = document.getElementById("hud-drift-value");
  const driftFillEl = document.getElementById("hud-drift-fill");
  
  let driftText = "On Path";
  let fillPct = 50; // center
  let fillClass = "hud-fill-aligned";
  
  if (driftDist > 0.5) {
    if (driftSide === "left") {
      driftText = `${driftDist.toFixed(1)}m Left`;
      fillPct = Math.max(10, 50 - (driftDist / 5) * 50); // move left
      fillClass = driftDist > 2.0 ? "hud-fill-danger" : "hud-fill-warning";
    } else if (driftSide === "right") {
      driftText = `${driftDist.toFixed(1)}m Right`;
      fillPct = Math.min(90, 50 + (driftDist / 5) * 50); // move right
      fillClass = driftDist > 2.0 ? "hud-fill-danger" : "hud-fill-warning";
    }
  }
  
  driftValEl.textContent = driftText;
  driftFillEl.style.left = `${fillPct}%`;
  driftFillEl.className = `hud-drift-marker ${fillClass}`;
  
  // Update heading visual
  const pathHeadingEl = document.getElementById("hud-path-heading");
  const userHeadingEl = document.getElementById("hud-user-heading");
  const devEl = document.getElementById("hud-heading-deviation");
  
  pathHeadingEl.textContent = `${Math.round(pathHeading)}°`;
  
  if (userHeading !== null) {
    userHeadingEl.textContent = `${Math.round(userHeading)}°`;
    
    // Calculate deviation: -180 to 180
    const dev = ((userHeading - pathHeading + 180) % 360 + 360) % 360 - 180;
    let devText = `${dev > 0 ? "+" : ""}${Math.round(dev)}°`;
    
    devEl.textContent = devText;
    
    if (Math.abs(dev) > 35) {
      devEl.className = "hud-value text-danger";
      document.getElementById("hud-heading-status").textContent = "TURN TOO MUCH";
      document.getElementById("hud-heading-status").className = "hud-status-badge status-danger";
    } else if (Math.abs(dev) > 20) {
      devEl.className = "hud-value text-warning";
      document.getElementById("hud-heading-status").textContent = "SLIGHTLY DEVIATED";
      document.getElementById("hud-heading-status").className = "hud-status-badge status-warning";
    } else {
      devEl.className = "hud-value text-success";
      document.getElementById("hud-heading-status").textContent = "ALIGNED";
      document.getElementById("hud-heading-status").className = "hud-status-badge status-success";
    }
  } else {
    userHeadingEl.textContent = "--";
    devEl.textContent = "--";
    document.getElementById("hud-heading-status").textContent = "NO COMPASS";
    document.getElementById("hud-heading-status").className = "hud-status-badge status-inactive";
  }
  
  // Show/hide simulator sliders based on whether it is active
  const simControls = document.getElementById("sim-controls-panel");
  if (simControls) {
    simControls.style.display = isSimulated ? "block" : "none";
  }
}

function handleDriftAndTurnCorrections(driftDist, driftSide, pathHeading, userHeading) {
  const now = Date.now();
  
  // 1. DRIFT CORRECTION
  if (driftDist > 2.0) {
    if (now - lastDriftCorrectionTime > 6000) {
      wasDrifting = true;
      if (!driftAudioMuted) {
        if (driftSide === "left") {
          speak("You are drifting left. Walk slightly right.");
        } else if (driftSide === "right") {
          speak("You are drifting right. Walk slightly left.");
        }
      }
      lastDriftCorrectionTime = now;
    }
  } else if (wasDrifting && driftDist <= 1.0) {
    if (!driftAudioMuted) {
      speak("Back on path.");
    }
    wasDrifting = false;
  }
  
  // 2. HEADING/TURN CORRECTION
  if (userHeading !== null) {
    const dev = ((userHeading - pathHeading + 180) % 360 + 360) % 360 - 180;
    if (Math.abs(dev) > 35) {
      if (now - lastHeadingCorrectionTime > 6000) {
        wasMisaligned = true;
        if (!driftAudioMuted) {
          if (dev > 35) {
            speak("You have turned too far right. Turn left to face the path.");
          } else if (dev < -35) {
            speak("You have turned too far left. Turn right to face the path.");
          }
        }
        lastHeadingCorrectionTime = now;
      }
    } else if (wasMisaligned && Math.abs(dev) <= 15) {
      if (!driftAudioMuted) {
        speak("Heading aligned.");
      }
      wasMisaligned = false;
    }
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
  currentSimBasePt = null;
  
  if (routeGeometry.length === 0) {
    document.getElementById("status").textContent = "Error: No route geometry to simulate.";
    return;
  }
  
  document.getElementById("status").textContent = "Simulation starting...";
  
  simInterval = setInterval(() => {
    if (simIndex >= routeGeometry.length) {
      clearInterval(simInterval);
      const finalPt = routeGeometry[routeGeometry.length - 1];
      onPosition({
        coords: {
          latitude: finalPt[1],
          longitude: finalPt[0],
          accuracy: 1,
          heading: null
        }
      });
      return;
    }
    
    const pt = routeGeometry[simIndex];
    currentSimBasePt = pt;
    
    let simLat = pt[1];
    let simLon = pt[0];
    let simHeading = null;
    
    const driftOffset = parseFloat(document.getElementById("sim-drift-slider")?.value || 0);
    const headingDev = parseFloat(document.getElementById("sim-heading-slider")?.value || 0);
    
    let nextPt = routeGeometry[simIndex + 1] || pt;
    if (simIndex === routeGeometry.length - 1 && simIndex > 0) {
      nextPt = pt;
      const prevPt = routeGeometry[simIndex - 1];
      const bearing = getBearing(prevPt[1], prevPt[0], pt[1], pt[0]);
      simHeading = (bearing + headingDev + 360) % 360;
    } else {
      const bearing = getBearing(pt[1], pt[0], nextPt[1], nextPt[0]);
      simHeading = (bearing + headingDev + 360) % 360;
      
      if (driftOffset !== 0) {
        const perpBearing = (bearing + 90) * Math.PI / 180;
        const dLat = (driftOffset * Math.cos(perpBearing)) / 110540;
        const dLon = (driftOffset * Math.sin(perpBearing)) / (111320 * Math.cos(pt[1] * Math.PI / 180));
        simLat += dLat;
        simLon += dLon;
      }
    }
    
    onPosition({
      coords: {
        latitude: simLat,
        longitude: simLon,
        accuracy: 3,
        heading: simHeading
      }
    });
    
    simIndex++;
  }, 1200); // Advances coordinate every 1.2s
}

function updateSimulationParameters() {
  if (!isSimulated || !currentSimBasePt || simIndex <= 0) return;
  
  const pt = currentSimBasePt;
  let simLat = pt[1];
  let simLon = pt[0];
  let simHeading = null;
  
  const driftOffset = parseFloat(document.getElementById("sim-drift-slider")?.value || 0);
  const headingDev = parseFloat(document.getElementById("sim-heading-slider")?.value || 0);
  
  let nextPt = routeGeometry[simIndex] || pt;
  if (simIndex >= routeGeometry.length && routeGeometry.length > 1) {
    nextPt = pt;
    const prevPt = routeGeometry[routeGeometry.length - 2];
    const bearing = getBearing(prevPt[1], prevPt[0], pt[1], pt[0]);
    simHeading = (bearing + headingDev + 360) % 360;
  } else {
    const bearing = getBearing(pt[1], pt[0], nextPt[1], nextPt[0]);
    simHeading = (bearing + headingDev + 360) % 360;
    
    if (driftOffset !== 0) {
      const perpBearing = (bearing + 90) * Math.PI / 180;
      const dLat = (driftOffset * Math.cos(perpBearing)) / 110540;
      const dLon = (driftOffset * Math.sin(perpBearing)) / (111320 * Math.cos(pt[1] * Math.PI / 180));
      simLat += dLat;
      simLon += dLon;
    }
  }
  
  onPosition({
    coords: {
      latitude: simLat,
      longitude: simLon,
      accuracy: 3,
      heading: simHeading
    }
  });
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

    // Toggle Apple Maps layout cards
    document.getElementById("pre-nav-card").style.display = "none";
    document.getElementById("step-box").style.display = "flex";
    document.getElementById("trip-drawer").style.display = "flex";

    // Plot Leaflet path geometry
    if (map && routeGeometry.length > 1) {
      const leafletCoords = routeGeometry.map(pt => [pt[1], pt[0]]);
      if (routePolyline) map.removeLayer(routePolyline);
      
      routePolyline = L.polyline(leafletCoords, {
        color: '#007aff',
        weight: 6,
        opacity: 0.85,
        lineJoin: 'round'
      }).addTo(map);
      
      map.fitBounds(routePolyline.getBounds(), { padding: [50, 50] });
    }

    // Set initial ETA metrics
    updateTripMetrics(data.total_distance, data.total_minutes);

    const gpsPill = document.getElementById("gps-pill");

    if (isSimulated) {
      gpsPill.className = "status-pill gps-simulated floating-gps";
      gpsPill.textContent = "SIMULATOR";
      startSimulation();
    } else {
      gpsPill.className = "status-pill gps-active floating-gps";
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
  
  // Toggle Apple Maps layout cards
  document.getElementById("pre-nav-card").style.display = "block";
  document.getElementById("step-box").style.display = "none";
  document.getElementById("trip-drawer").style.display = "none";
  document.getElementById("trip-drawer").classList.remove("drawer-expanded");
  const chevron = document.querySelector(".drawer-chevron");
  if (chevron) chevron.textContent = "▲";

  // Remove Leaflet elements
  if (routePolyline && map) {
    map.removeLayer(routePolyline);
    routePolyline = null;
  }
  if (userMarker && map) {
    map.removeLayer(userMarker);
    userMarker = null;
  }
  
  const gpsPill = document.getElementById("gps-pill");
  gpsPill.className = "status-pill gps-inactive floating-gps";
  gpsPill.textContent = "GPS INACTIVE";
  
  document.getElementById("status").textContent = "Navigation stopped.";
  
  // Reset HUD and alignment states
  const hudPanel = document.getElementById("hud-panel");
  if (hudPanel) hudPanel.style.display = "block"; // Keep styled inside drawer
  
  wasDrifting = false;
  wasMisaligned = false;
  currentSimBasePt = null;
  
  // Reset sliders if present
  const driftSlider = document.getElementById("sim-drift-slider");
  if (driftSlider) driftSlider.value = 0;
  const headingSlider = document.getElementById("sim-heading-slider");
  if (headingSlider) headingSlider.value = 0;
  
  const driftValEl = document.getElementById("sim-drift-val");
  if (driftValEl) driftValEl.textContent = "0.0m";
  const headingValEl = document.getElementById("sim-heading-val");
  if (headingValEl) headingValEl.textContent = "0°";
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

function toggleDriftAudio() {
  driftAudioMuted = !driftAudioMuted;
  const driftBtn = document.getElementById("drift-audio-btn");
  driftBtn.textContent = driftAudioMuted ? "🔇 Drift Audio Muted" : "🔊 Drift Audio";
  driftBtn.classList.toggle("btn-active", !driftAudioMuted);
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

// ── Leaflet & Drawer Helper Operations ────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  try {
    // Initialize Leaflet Map centered on MC landmark
    map = L.map('map', {
      zoomControl: false,
      attributionControl: false
    }).setView([43.47240, -80.54641], 17);

    // Dark Matter map tiles
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 20
    }).addTo(map);

    console.log("Leaflet map initialized successfully.");
  } catch (err) {
    console.error("Leaflet initialization failed:", err);
  }
});

function toggleDrawer() {
  const drawer = document.getElementById("trip-drawer");
  const chevron = document.querySelector(".drawer-chevron");
  if (drawer) {
    drawer.classList.toggle("drawer-expanded");
    if (chevron) {
      chevron.textContent = drawer.classList.contains("drawer-expanded") ? "▼" : "▲";
    }
  }
}

function recenterMap() {
  if (map && userMarker) {
    map.panTo(userMarker.getLatLng());
  } else if (map && routeGeometry && routeGeometry.length > 0) {
    const firstPt = routeGeometry[0];
    map.panTo([firstPt[1], firstPt[0]]);
  }
}

function getRemainingDistance(userPt, closestSegIdx, geometry) {
  if (!geometry || geometry.length === 0) return 0;
  
  // Distance from user to next vertex
  const nextVertex = geometry[closestSegIdx + 1] || userPt;
  let dist = haversine(userPt[1], userPt[0], nextVertex[1], nextVertex[0]);
  
  // Sum remaining legs
  for (let i = closestSegIdx + 1; i < geometry.length - 1; i++) {
    dist += haversine(geometry[i][1], geometry[i][0], geometry[i+1][1], geometry[i+1][0]);
  }
  return dist;
}

function updateTripMetrics(totalDist, totalMin) {
  const durationEl = document.getElementById("trip-duration");
  const distanceEl = document.getElementById("trip-distance");
  const etaEl = document.getElementById("trip-eta");
  
  if (durationEl) durationEl.textContent = `${totalMin} min`;
  if (distanceEl) {
    if (totalDist >= 1000) {
      distanceEl.textContent = `${(totalDist / 1000).toFixed(1)} km`;
    } else {
      distanceEl.textContent = `${Math.round(totalDist)} m`;
    }
  }
  if (etaEl) {
    const etaDate = new Date();
    etaDate.setMinutes(etaDate.getMinutes() + totalMin);
    let hours = etaDate.getHours();
    const minutes = etaDate.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    etaEl.textContent = `${hours}:${minutes} ${ampm}`;
  }
}
