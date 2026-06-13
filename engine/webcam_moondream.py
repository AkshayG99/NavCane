import cv2
import torch
from PIL import Image
from transformers import AutoModelForCausalLM

model = AutoModelForCausalLM.from_pretrained(
    "vikhyatk/moondream2",
    trust_remote_code=True,
    dtype=torch.bfloat16,
    device_map="mps",
)

settings = {"temperature": 0.5, "max_tokens": 128, "top_p": 0.3}

cap = cv2.VideoCapture(0)
if not cap.isOpened():
    print("Error: Could not open webcam.")
    exit(1)

print("Press 'q' to quit, 'c' to caption the current frame.")

frame_count = 0
while True:
    ret, frame = cap.read()
    if not ret:
        print("Error: Failed to read frame.")
        break

    frame_count += 1

    if frame_count % 30 == 0:
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        pil_img = Image.fromarray(rgb)

        caption = model.caption(pil_img, length="normal", settings=settings)
        print(f"Caption: {caption}")

    cv2.imshow("Moondream2 Webcam", frame)
    key = cv2.waitKey(1) & 0xFF
    if key == ord("q"):
        break
    elif key == ord("c"):
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        pil_img = Image.fromarray(rgb)
        caption = model.caption(pil_img, length="normal", settings=settings)
        print(f"Caption: {caption}")

cap.release()
cv2.destroyAllWindows()
