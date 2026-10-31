# Serves src/ read-only, injecting stub.js into panel.html.
# python3 tests/harness/serve.py [port] [src dir], then open http://localhost:<port>/src/panel.html
import http.server, pathlib, sys
HERE = pathlib.Path(__file__).resolve().parent
SRC = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else HERE.parents[1] / "src").resolve()
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
TYPES = {".js": "text/javascript", ".css": "text/css", ".html": "text/html"}
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/stub.js": f = HERE / "stub.js"
        elif path.startswith("/src/"): f = (SRC / path[5:]).resolve()
        else: return self.send_error(404)
        if not f.is_file() or (f.parent != SRC and f.parent != HERE): return self.send_error(404)
        body = f.read_bytes()
        if f.name == "panel.html":
            body = body.replace(b"<head>", b'<head>\n  <script src="/stub.js"></script>', 1)
        self.send_response(200)
        self.send_header("Content-Type", TYPES.get(f.suffix, "application/octet-stream"))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
