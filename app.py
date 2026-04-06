"""

SAP Vendor Risk Monitoring System

Flask Application

"""
 
import os
import json
import uuid
import time
import requests as http_requests
from flask import Flask, render_template, request, jsonify, redirect, url_for, session
from werkzeug.utils import secure_filename
from ml_model import run_vendor_risk_analysis
import numpy as np
 
app = Flask(__name__)

app.secret_key = "sap_vrm_secret_2024"
 
os.makedirs("uploads", exist_ok=True)

os.makedirs("results", exist_ok=True)
 
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
 
UPLOAD_FOLDER = os.path.join(BASE_DIR, "uploads")

RESULTS_FOLDER = os.path.join(BASE_DIR, "results")
 
ALLOWED_EXTENSIONS = {"csv"}
 
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER

app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024
 
 
# ---------------------------------------------------

# Ensure folders exist

# ---------------------------------------------------

os.makedirs(UPLOAD_FOLDER, exist_ok=True)

os.makedirs(RESULTS_FOLDER, exist_ok=True)
 
 
# ---------------------------------------------------

# Utility

# ---------------------------------------------------

def allowed_file(filename):

    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS
 
 
def convert_numpy(obj):

    """Convert numpy types for JSON serialization."""

    if isinstance(obj, (np.integer)):

        return int(obj)

    if isinstance(obj, (np.floating)):

        return float(obj)

    if isinstance(obj, (np.ndarray)):

        return obj.tolist()

    return obj


def cleanup_old_results(max_age_seconds=86400):
    """Delete result JSON files older than max_age_seconds (default: 24 hours)."""
    try:
        now = time.time()
        for fname in os.listdir(RESULTS_FOLDER):
            if not fname.endswith(".json"):
                continue
            fpath = os.path.join(RESULTS_FOLDER, fname)
            if now - os.path.getmtime(fpath) > max_age_seconds:
                os.remove(fpath)
    except Exception:
        pass
 
 
# ---------------------------------------------------

# Routes

# ---------------------------------------------------
 
@app.route("/")

def index():

    return render_template("index.html")
 
 
@app.route("/analyze", methods=["POST"])

def analyze():

    cleanup_old_results()   # purge result files older than 24 hours
 
    required = ["bsik_file", "lfa1_file", "lfb1_file"]

    saved_paths = {}
 
    for field in required:
 
        if field not in request.files:

            return jsonify({"error": f"Missing file: {field}"}), 400
 
        file = request.files[field]
 
        if file.filename == "":

            return jsonify({"error": f"No file selected for {field}"}), 400
 
        if not allowed_file(file.filename):

            return jsonify({"error": f"Invalid file type for {field}. Only CSV allowed."}), 400
 
        uid = str(uuid.uuid4())[:8]

        filename = uid + "_" + secure_filename(file.filename)
 
        path = os.path.join(app.config["UPLOAD_FOLDER"], filename)

        file.save(path)
 
        saved_paths[field] = path
 
    try:
 
        results = run_vendor_risk_analysis(

            bsik_path=saved_paths["bsik_file"],

            lfa1_path=saved_paths["lfa1_file"],

            lfb1_path=saved_paths["lfb1_file"],

        )
 
        # convert numpy values

        results = json.loads(json.dumps(results, default=convert_numpy))
 
    except Exception as e:

        return jsonify({"error": f"Analysis failed: {str(e)}"}), 500
 
    finally:

        for p in saved_paths.values():

            try:

                os.remove(p)

            except Exception:

                pass
 
    result_id = str(uuid.uuid4())[:12]

    result_file = os.path.join(RESULTS_FOLDER, f"{result_id}.json")
 
    with open(result_file, "w") as f:

        json.dump(results, f)
 
    session["result_id"] = result_id
 
    return jsonify({"status": "ok", "result_id": result_id})
 
 
@app.route("/results")

def results():
 
    result_id = session.get("result_id")
 
    if not result_id:

        return redirect(url_for("index", msg="no_session"))
 
    result_file = os.path.join(RESULTS_FOLDER, f"{result_id}.json")
 
    if not os.path.exists(result_file):

        session.pop("result_id", None)

        return redirect(url_for("index", msg="expired"))
 
    with open(result_file) as f:

        data = json.load(f)
 
    return render_template("results.html", data=json.dumps(data))
 
 
@app.route("/vendors")

def vendors():
 
    result_id = session.get("result_id")
 
    if not result_id:

        return redirect(url_for("index", msg="no_session"))
 
    result_file = os.path.join(RESULTS_FOLDER, f"{result_id}.json")
 
    if not os.path.exists(result_file):

        session.pop("result_id", None)

        return redirect(url_for("index", msg="expired"))
 
    with open(result_file) as f:

        data = json.load(f)
 
    return render_template("vendors.html", data=json.dumps(data))


@app.route("/intelligence")

def intelligence():

    result_id = session.get("result_id")

    if not result_id:

        return redirect(url_for("index", msg="no_session"))

    result_file = os.path.join(RESULTS_FOLDER, f"{result_id}.json")

    if not os.path.exists(result_file):

        session.pop("result_id", None)

        return redirect(url_for("index", msg="expired"))

    with open(result_file) as f:

        data = json.load(f)

    return render_template("intelligence.html", data=json.dumps(data))

 
@app.route("/api/claude", methods=["POST"])
def claude_proxy():
    """
    Server-side proxy for OpenRouter API calls.
    Avoids CORS issues when calling the API from the browser.
    Requires OPENROUTER_API_KEY environment variable to be set.
    """
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        return jsonify({"error": "OPENROUTER_API_KEY not set on server"}), 500

    try:
        payload = request.get_json(force=True)
    except Exception:
        return jsonify({"error": "Invalid JSON body"}), 400

    # Convert Anthropic-style payload to OpenRouter/OpenAI format
    messages = []
    system_prompt = payload.get("system", "")
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    for msg in payload.get("messages", []):
        messages.append({"role": msg["role"], "content": msg["content"]})

    openrouter_payload = {
        "model":      payload.get("model", "arcee-ai/trinity-large-preview:free"),
        "max_tokens": payload.get("max_tokens", 1000),
        "messages":   messages,
    }

    try:
        resp = http_requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Content-Type":  "application/json",
                "Authorization": f"Bearer {api_key}",
                "HTTP-Referer":  "http://localhost:5000",
                "X-Title":       "SAP Vendor Risk Monitor",
            },
            json=openrouter_payload,
            timeout=60,
        )
        data = resp.json()

        # Translate OpenAI-style response back to Anthropic-style
        # so intelligence.js doesn't need to change
        if resp.status_code == 200 and "choices" in data:
            text = data["choices"][0]["message"]["content"]
            return jsonify({
                "content": [{"type": "text", "text": text}]
            }), 200
        else:
            err_msg = data.get("error", {}).get("message", str(data))
            return jsonify({"error": err_msg}), resp.status_code

    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":

    import os

    port = int(os.environ.get("PORT", 5000))

    app.run(host="0.0.0.0", port=port, debug=False)