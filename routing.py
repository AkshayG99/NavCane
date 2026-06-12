import requests
import re
import math

OSRM_URL = "http://router.project-osrm.org/route/v1/foot"
HEADERS  = {"User-Agent": "UW-Cane-Navigation/1.0"}

LANDMARKS = {
    "dc":          (43.47285, -80.54404),
    "mc":          (43.47240, -80.54641),
    "e7":          (43.47068, -80.53966),
    "slc":         (43.47383, -80.54576),
    "dana porter": (43.46990, -80.54240),
    "phy":         (43.47077, -80.54503),
    "qnc":         (43.47101, -80.54118),
    "pac":         (43.47467, -80.54735),
    "eit":         (43.47175, -80.54107),
    "tml":         (43.47318, -80.54769),
}

def haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    p = math.pi / 180
    a = (math.sin((lat2-lat1)*p/2)**2 +
         math.cos(lat1*p)*math.cos(lat2*p)*math.sin((lon2-lon1)*p/2)**2)
    return 2*R*math.atan2(math.sqrt(a), math.sqrt(1-a))

def clean(text):
    return re.sub(r"<[^>]+>", "", text).strip()

def build_instruction(step):
    m     = step["maneuver"]
    mtype = m.get("type","")
    mmod  = m.get("modifier","")
    dist  = step["distance"]
    name  = step.get("name","").strip()
    loc   = f" on {name}" if name else ""
    d     = f"{int(round(dist))} metres"

    if mtype == "depart":
        dirs = {"north":"north","northeast":"northeast","east":"east",
                "southeast":"southeast","south":"south","southwest":"southwest",
                "west":"west","northwest":"northwest"}
        return f"Head {dirs.get(mmod,'forward')}{loc} for {d}"
    if mtype == "turn":
        turns = {"left":"Turn left","right":"Turn right",
                 "slight left":"Slight left","slight right":"Slight right",
                 "sharp left":"Sharp left","sharp right":"Sharp right",
                 "uturn":"Turn around"}
        return f"{turns.get(mmod,'Continue')}{loc}, then walk {d}"
    if mtype in ("new name","continue"):
        return f"Continue straight{loc} for {d}"
    return f"Continue{loc} for {d}"

def get_route(start_key, end_key):
    sc = LANDMARKS[start_key]
    ec = LANDMARKS[end_key]
    coords = f"{sc[1]},{sc[0]};{ec[1]},{ec[0]}"
    try:
        r = requests.get(f"{OSRM_URL}/{coords}",
                         params={"steps":"true","geometries":"geojson","overview":"full"},
                         headers=HEADERS).json()
        if r.get("code") != "Ok":
            return None
    except Exception as e:
        print("OSRM API Request failed:", e)
        return None

    route  = r["routes"][0]
    steps  = []

    for leg in route["legs"]:
        for step in leg["steps"]:
            if step["maneuver"]["type"] == "arrive":
                continue
            if step["distance"] < 5:
                continue
            loc = step["maneuver"]["location"]   # [lon, lat]
            steps.append({
                "instruction": build_instruction(step),
                "distance":    int(round(step["distance"])),
                "lat":         loc[1],
                "lon":         loc[0],
                "modifier":    step["maneuver"].get("modifier", "depart"),
            })

    return {
        "steps":         steps,
        "geometry":      route["geometry"]["coordinates"], # list of [lon, lat]
        "total_distance": int(route["distance"]),
        "total_minutes":  max(1, round(route["duration"]/60)),
    }
