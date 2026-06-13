import cv2, time
from google import genai
from google.genai import types

API_KEY = "AIzaSyCzJUCUdtY-pQj_Ho7MAi629_me0KPfrE4"
MODEL = "gemma-4-26b-a4b-it"
client = genai.Client(api_key=API_KEY)

print("Ready! Describing every 5 seconds. ESC to quit.\n")

cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
if not cap.isOpened():
    print("No camera")
    exit()

last_time = 0

while True:
    ret, frame = cap.read()
    if not ret:
        continue

    now = time.time()
    if now - last_time >= 5:
        _, buf = cv2.imencode(".jpg", frame)
        img_part = types.Part.from_bytes(data=buf.tobytes(), mime_type="image/jpeg")

        # Stage 1: detailed description with positions
        resp1 = client.models.generate_content(
            model=MODEL,
            contents=[img_part, "Describe this scene in detail for a blind person. Mention positions of people/obstacles relative to the frame (e.g. 'person middle-left', 'chair ahead'). Under 30 words."]
        )
        detail = resp1.text.strip()

        # Stage 2: parse into steering instruction
        resp2 = client.models.generate_content(
            model=MODEL,
            contents=f"Based on this: '{detail}', give a short steering instruction (<8 words) for a blind person. If clear say 'Clear path'."
        )
        instruction = resp2.text.strip()

        print(f"[Detail] {detail}")
        print(f"[Steer]  {instruction}\n")
        last_time = now

    cv2.putText(frame, "ESC to quit", (10, 30),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
    cv2.imshow("Gemma Test", frame)

    if cv2.waitKey(30) & 0xFF == 27:
        break

cap.release()
cv2.destroyAllWindows()
