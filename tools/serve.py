"""Local server for Hero Tracker: like `python -m http.server`, plus `Cache-Control: no-cache`,
so the browser always revalidates the app's modules and never runs a stale copy after an update.

    python tools/serve.py [port]      (default 8000; serves the repo root)
"""
import functools, http.server, os, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript", ".onnx": "application/octet-stream"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    handler = functools.partial(Handler, directory=root)
    print(f"Hero Tracker on http://localhost:{port}/  (Ctrl+C to stop)")
    http.server.ThreadingHTTPServer(("localhost", port), handler).serve_forever()
