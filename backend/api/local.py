"""Loopback-only development server, intentionally without dotenv or AWS discovery."""
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlsplit
from backend.api.handler import handler


class LocalHandler(BaseHTTPRequestHandler):
    def dispatch(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400)
            return
        if length < 0 or length > 16384:
            self.send_error(413)
            return
        url = urlsplit(self.path)
        try:
            body = self.rfile.read(length).decode("utf-8")
        except UnicodeError:
            self.send_error(400)
            return
        result = handler({"rawPath": url.path, "headers": dict(self.headers), "body": body, "queryStringParameters": {k: v[-1] for k, v in parse_qs(url.query).items()}, "requestContext": {"http": {"method": self.command}}}, None)
        self.send_response(result["statusCode"])
        for key, value in result["headers"].items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(result["body"].encode())

    do_GET = do_POST = do_PATCH = do_DELETE = do_OPTIONS = dispatch

    def log_message(self, _format, *args):
        pass  # Do not emit URL query strings or request payloads.


if __name__ == "__main__":
    print("CloudVault simulator on http://127.0.0.1:8000; no AWS connection")
    HTTPServer(("127.0.0.1", 8000), LocalHandler).serve_forever()
