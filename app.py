from flask import Flask, request, jsonify, render_template
import routing
import vision

app = Flask(__name__)

@app.route("/")
def index():
    # Sort the landmarks alphabetically for a cleaner UI dropdown list
    sorted_landmarks = sorted(routing.LANDMARKS.keys())
    return render_template("index.html", landmarks=sorted_landmarks)

@app.route("/api/route")
def api_route():
    start = request.args.get("start", "").lower()
    end   = request.args.get("end", "").lower()
    if start not in routing.LANDMARKS or end not in routing.LANDMARKS:
        return jsonify({"error": "Unknown location"}), 400
    result = routing.get_route(start, end)
    if not result:
        return jsonify({"error": "Could not find route"}), 500
    return jsonify(result)

@app.route("/api/check_step")
def check_step():
    try:
        lat      = float(request.args["lat"])
        lon      = float(request.args["lon"])
        step_idx = int(request.args["step"])
    except (KeyError, ValueError):
        return jsonify({"error": "bad params"}), 400
    return jsonify({"ok": True})

@app.route("/obstacle")
def obstacle_page():
    return render_template("obstacle.html")

@app.route("/api/detect", methods=["POST"])
def api_detect():
    data = request.get_json(silent=True)
    if not data or "image" not in data:
        return jsonify({"error": "No image data"}), 400
    
    result, error_msg = vision.analyze_frame(data["image"])
    if error_msg:
        return jsonify({"error": error_msg}), 400
    
    result["ok"] = True
    return jsonify(result)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=True)