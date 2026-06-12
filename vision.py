import cv2
import numpy as np
import base64

# ── load vision model ────────────────────────────────────────────────────────
try:
    from ultralytics import YOLO
    # Pre-loads and downloads the yolov8n.pt model if needed (~6.2 MB)
    model = YOLO("yolov8n.pt")
    HAS_YOLO = True
    print("YOLOv8 model loaded successfully.")
except Exception as e:
    HAS_YOLO = False
    print("Failed to load YOLOv8 model, will fall back to HOG:", e)

OBSTACLE_CLASSES = {
    0: "person",
    1: "bicycle",
    2: "car",
    3: "motorcycle",
    5: "bus",
    7: "truck",
    11: "cone/hydrant",  # Cones often misclassified as fire hydrant
    12: "stop sign",
    13: "parking meter",
    14: "bench",
    24: "backpack",
    25: "umbrella",
    26: "handbag",
    28: "bin/suitcase",   # Trash cans often misclassified as suitcase
    56: "chair",
    58: "potted plant",   # Outdoor trash cans often misclassified as potted plants
    60: "dining table",
    61: "bin/toilet",     # Bins often misclassified as toilet
    72: "bin/refrigerator" # Dumpsters / large bins
}

_hog = None
def run_hog_detection(img):
    global _hog
    if _hog is None:
        _hog = cv2.HOGDescriptor()
        _hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    
    h, w = img.shape[:2]
    scale = 320.0 / w
    img_resized = cv2.resize(img, (320, int(h * scale)))
    
    rects, weights = _hog.detectMultiScale(img_resized, winStride=(8, 8), padding=(8, 8), scale=1.05)
    
    detections = []
    for i, (x, y, rw, rh) in enumerate(rects):
        ox = int(x / scale)
        oy = int(y / scale)
        ow = int(rw / scale)
        oh = int(rh / scale)
        
        conf = float(weights[i]) if i < len(weights) else 0.7
        norm_conf = min(1.0, max(0.3, conf / 1.5))
        
        detections.append({
            "box": [ox, oy, ow, oh],
            "confidence": norm_conf,
            "class_name": "person"
        })
    return detections

def analyze_frame(img_data_str):
    """
    Decodes a base64 image frame, runs object detection,
    and returns detected obstacle details and danger level.
    """
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
    detections = []
    danger_level = 0

    if HAS_YOLO:
        try:
            results = model(img, verbose=False)
            for r in results:
                boxes = r.boxes
                for box in boxes:
                    cls = int(box.cls[0].item())
                    if cls in OBSTACLE_CLASSES:
                        x1, y1, x2, y2 = box.xyxy[0].tolist()
                        conf = float(box.conf[0].item())
                        if conf > 0.35:  # lower threshold slightly for more robust detection
                            detections.append({
                                "box": [int(x1), int(y1), int(x2 - x1), int(y2 - y1)],
                                "confidence": conf,
                                "class_name": OBSTACLE_CLASSES[cls]
                            })
        except Exception as e:
            print("YOLO run failed, falling back to HOG:", e)
            detections = run_hog_detection(img)
    else:
        detections = run_hog_detection(img)

    # Calculate Danger Level
    for det in detections:
        x, y, bw, bh = det["box"]
        cx = x + bw / 2
        ncx = cx / w
        nbh = bh / h
        
        # Check if the obstacle overlaps with the middle 50% of the screen (0.25 to 0.75)
        if 0.25 <= ncx <= 0.75:
            # Danger level corresponds to height ratio of box in screen
            if nbh > 0.55:
                danger_level = max(danger_level, 3) # Extremely Close
            elif nbh > 0.35:
                danger_level = max(danger_level, 2) # Close
            elif nbh > 0.12:
                danger_level = max(danger_level, 1) # Alert (Warning)

    return {
        "detections": detections,
        "danger_level": danger_level,
        "frame_width": w,
        "frame_height": h
    }, None
