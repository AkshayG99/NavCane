let stream = null;
let detectInterval = null;
let cameraActive = false;
let lastSpeechTime = 0;

function speak(text) {
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.9;
  window.speechSynthesis.speak(u);
}

function writeLog(detail, steer) {
  const el = document.getElementById("log");
  const t = new Date().toLocaleTimeString();
  el.innerHTML += `<span class="time">[${t}]</span> <span class="detail">${detail}</span> → <span class="steer">${steer || "clear path"}</span>\n`;
  el.scrollTop = el.scrollHeight;
}

async function toggleCamera() {
  const video = document.getElementById("video");
  const btn = document.getElementById("cam-btn");
  const placeholder = document.getElementById("placeholder");
  const badge = document.getElementById("status-badge");

  if (cameraActive) {
    stopCamera();
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });

    video.srcObject = stream;
    video.style.display = "block";
    placeholder.style.display = "none";
    cameraActive = true;

    btn.textContent = "📷 Disable Camera";
    btn.classList.add("active");
    badge.textContent = "CAMERA ON";
    badge.classList.add("active");
    document.getElementById("status").textContent = "Starting analysis...";
    document.getElementById("log").textContent = "";

    startDetectionLoop();
  } catch (err) {
    alert("Camera error: " + err.message + "\n\nMake sure your webcam is not being used by another app.");
  }
}

function stopCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  document.getElementById("video").style.display = "none";
  document.getElementById("placeholder").style.display = "flex";
  document.getElementById("cam-btn").textContent = "📷 Enable Camera";
  document.getElementById("cam-btn").classList.remove("active");
  document.getElementById("status-badge").textContent = "CAMERA OFF";
  document.getElementById("status-badge").classList.remove("active");
  document.getElementById("status").textContent = "Camera off";
  document.getElementById("steer-hud").style.display = "none";
  if (detectInterval) { clearInterval(detectInterval); detectInterval = null; }
  cameraActive = false;
}

async function sendFrame() {
  const video = document.getElementById("video");
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext("2d");

  if (!cameraActive || video.readyState < 2) return;

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.55);

  document.getElementById("status").textContent = "⏳ Analyzing with Gemma...";

  try {
    const res = await fetch("/api/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl })
    });
    const data = await res.json();

    if (data.ok) {
      writeLog(data.detail || "(empty)", data.description || "(clear)");

      const steerHud = document.getElementById("steer-hud");
      const steerText = document.getElementById("steer-text");
      const descText = document.getElementById("desc-text");

      if (data.detail) {
        document.getElementById("status").textContent = "👁 " + data.detail;
      }

      if (data.description) {
        steerText.textContent = data.description.toUpperCase();
        descText.textContent = data.detail || "";
        steerHud.style.display = "block";
        steerHud.className = "steer-hud" + (data.danger_level >= 3 ? " danger" : data.danger_level >= 1 ? " warning" : "");
      } else {
        steerHud.style.display = "none";
      }

      const now = Date.now();
      if (data.detail && now - lastSpeechTime > 8000) {
        const msg = data.description ? data.detail + ". " + data.description : data.detail;
        speak(msg);
        lastSpeechTime = now;
      }
    } else {
      document.getElementById("status").textContent = "❌ API error";
    }
  } catch (err) {
    console.error("API Error:", err);
    document.getElementById("status").textContent = "❌ " + err.message;
  }
}

function startDetectionLoop() {
  // Send one immediately, then every 10 seconds
  sendFrame();
  detectInterval = setInterval(sendFrame, 10000);
}
