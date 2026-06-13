import cv2
import torch
import time
import threading
import sys
from PIL import Image
from transformers import AutoModelForCausalLM, AutoTokenizer

# Configure print to be unbuffered to see logs immediately
sys.stdout.reconfigure(line_buffering=True)

print("="*60)
print("             MOONDREAM 0.5B WEBCAM TESTER")
print("="*60)
print("Loading Moondream 0.5B model from Hugging Face...")

# Use the stable Moondream 2 repository which hosts the lightweight VLM
model_id = "vikhyatk/moondream2"
revision = "2025-01-09"  # Recommended pinned revision

# Determine best hardware acceleration available
device = "cpu"
if torch.cuda.is_available():
    device = "cuda"
elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
    device = "mps"

print(f"Selected device: {device.upper()}")

# Load model and tokenizer
try:
    print(f"Loading checkpoint '{revision}'...")
    model = AutoModelForCausalLM.from_pretrained(
        model_id, 
        trust_remote_code=True, 
        revision=revision
    ).to(device)
    tokenizer = AutoTokenizer.from_pretrained(model_id, revision=revision)
    print("Model loaded successfully!")
except Exception as e:
    print(f"\n[Warning] Failed loading revision {revision}: {e}")
    print("Retrying with latest model version (no revision tag)...")
    try:
        model = AutoModelForCausalLM.from_pretrained(
            model_id, 
            trust_remote_code=True
        ).to(device)
        tokenizer = AutoTokenizer.from_pretrained(model_id)
        print("Model loaded successfully!")
    except Exception as e2:
        print(f"\n[Error] Failed to load model: {e2}")
        sys.exit(1)

# Global variables for thread safety
current_frame = None
frame_lock = threading.Lock()
running = True
prompt_mode = "auto"  # 'auto' for automatic interval, 'manual' to ask on keypress
user_query = ""

def inference_loop():
    global current_frame, running, user_query
    
    print("\n" + "="*50)
    print("INSTRUCTIONS:")
    print(" - The VLM will automatically analyze the camera feed every 2 seconds.")
    print(" - To ask custom questions: type them in this console and press Enter!")
    print(" - Press 'q' in the camera window or Ctrl+C in the console to exit.")
    print("="*50 + "\n")
    
    # Run a quick warm-up inference to compile/load everything
    print("[VLM] Initializing warm-up run...")
    dummy_img = Image.new('RGB', (100, 100), color='white')
    try:
        if hasattr(model, 'query'):
            model.query(dummy_img, "test")
        else:
            enc = model.encode_image(dummy_img)
            model.answer_question(enc, "test", tokenizer)
        print("[VLM] Warm-up complete! Inference thread is ready.\n")
    except Exception as e:
        print(f"[VLM Warm-up Warning] {e}")

    last_auto_time = time.time()
    
    while running:
        time.sleep(0.1)
        now = time.time()
        
        # Decide prompt and check trigger
        active_prompt = ""
        is_custom = False
        
        if user_query.strip():
            active_prompt = user_query.strip()
            user_query = ""
            is_custom = True
        elif now - last_auto_time >= 3.0:  # Every 3 seconds auto-analyze
            active_prompt = "Describe what you see in front of the camera, highlighting any potential path obstacles."
            last_auto_time = now
            
        if not active_prompt:
            continue
            
        # Get latest frame
        with frame_lock:
            if current_frame is None:
                continue
            # Convert BGR to RGB
            img_rgb = cv2.cvtColor(current_frame, cv2.COLOR_BGR2RGB)
            pil_img = Image.fromarray(img_rgb)
            
        try:
            print(f"\n[VLM Query] -> '{active_prompt}'")
            start_t = time.time()
            
            # Execute query based on available Moondream model API methods
            if hasattr(model, 'query'):
                res = model.query(pil_img, active_prompt)
                answer = res.get("answer", "No response.")
            else:
                enc_image = model.encode_image(pil_img)
                answer = model.answer_question(enc_image, active_prompt, tokenizer)
                
            elapsed = time.time() - start_t
            prefix = "[VLM Custom Answer]" if is_custom else "[VLM Auto Description]"
            print(f"{prefix} ({elapsed:.2f}s): {answer}")
            print("Enter custom question: ", end="", flush=True)
            
        except Exception as e:
            print(f"\n[VLM Inference Error] {e}")
            print("Enter custom question: ", end="", flush=True)

def console_input_loop():
    global user_query, running
    while running:
        try:
            # Blocking input read
            inp = input()
            if inp.strip().lower() in ['exit', 'quit', 'q']:
                running = False
                break
            user_query = inp
        except (KeyboardInterrupt, EOFError):
            running = False
            break

# Initialize camera
cap = cv2.VideoCapture(0)
if not cap.isOpened():
    print("[Error] Could not access the webcam (device 0). Make sure no other app is using it.")
    running = False
    sys.exit(1)

# Grab first frame to guarantee current_frame is not None
ret, frame = cap.read()
if ret:
    current_frame = frame.copy()

# Start background loops
inf_thread = threading.Thread(target=inference_loop, daemon=True)
inf_thread.start()

console_thread = threading.Thread(target=console_input_loop, daemon=True)
console_thread.start()

print("Webcam stream live. Focus the GUI window and press 'q' to quit.")

try:
    while running:
        ret, frame = cap.read()
        if not ret:
            print("[Warning] Failed to grab frame from webcam.")
            time.sleep(0.1)
            continue
            
        with frame_lock:
            current_frame = frame.copy()
            
        # Annotate GUI window
        h, w, _ = frame.shape
        cv2.putText(frame, "Moondream VLM 0.5B - Live Feed", (15, 35), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
        cv2.putText(frame, "Check CLI console to see descriptions or ask questions", (15, h - 20), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
        
        cv2.imshow("NavCane VLM Tester", frame)
        
        key = cv2.waitKey(30) & 0xFF
        if key == ord('q'):
            running = False
            break
            
except KeyboardInterrupt:
    print("\nKeyboardInterrupt received.")
finally:
    running = False
    cap.release()
    cv2.destroyAllWindows()
    print("Cleaned up webcam and window resources. Goodbye!")
