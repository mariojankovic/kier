"""Shared loopback boundary; imported before loading model dependencies."""
import hmac
import json
import os
import re
import socket
import stat
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 2 * 1024 * 1024
REQUEST_SECONDS = 120
TOKEN = os.environ.get("KIER_SIDECAR_TOKEN", "")
if not re.fullmatch(r"[a-f0-9]{64}", TOKEN):
    raise RuntimeError("SIDECAR_TOKEN_REQUIRED")

class SecureServer(ThreadingHTTPServer):
    address_family = socket.AF_UNIX
    request_queue_size = 4
    daemon_threads = True
    def __init__(self, address, handler):
        parent = os.path.dirname(address)
        info = os.lstat(parent)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise RuntimeError("SIDECAR_DIRECTORY_IDENTITY")
        if os.path.lexists(address):
            info = os.lstat(address)
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise RuntimeError("SIDECAR_SOCKET_IDENTITY")
            # Only remove a stale endpoint, never steal a live worker's socket.
            with socket.socket(socket.AF_UNIX) as probe:
                try:
                    probe.connect(address)
                except ConnectionRefusedError:
                    os.unlink(address)
                else:
                    raise RuntimeError("SIDECAR_ALREADY_RUNNING")
        self.slots = threading.BoundedSemaphore(4)
        os.umask(0o077)
        super().__init__(address, handler)
        os.chmod(address, 0o600)
    def server_bind(self):
        self.socket.bind(self.server_address)
        self.server_name = "kier-sidecar"
        self.server_port = 0
    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise
    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()
    def handle_error(self, request, address):
        print('{"code":"SIDECAR_REQUEST_FAILED"}', flush=True)

class SecureHandler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(5)
        self.body_deadline = threading.Timer(10, self.expire_input)
        self.body_deadline.daemon = True
        self.body_deadline.start()
    def expire_input(self):
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
    def finish(self):
        self.body_deadline.cancel()
        super().finish()
    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.write(data)
    def authorized(self):
        self.close_connection = True
        expected = "kier-sidecar"
        for key in ("host", "x-kier-token", "content-type", "content-length", "origin"):
            if len(self.headers.get_all(key, [])) > 1:
                self.reply(400, {"error": "SIDECAR_HEADERS"}); return False
        if self.headers.get("host") != expected or self.headers.get("origin") is not None:
            self.reply(403, {"error": "SIDECAR_HOST"}); return False
        given = self.headers.get("x-kier-token", "").encode()
        if not hmac.compare_digest(given, TOKEN.encode()):
            self.reply(401, {"error": "SIDECAR_AUTH"}); return False
        return True
    def dispatch(self, post=False):
        if not self.authorized():
            return
        if post:
            if self.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
                return self.reply(415, {"error": "SIDECAR_JSON_REQUIRED"})
            length = self.headers.get("content-length", "")
            if self.headers.get("transfer-encoding") or not re.fullmatch(r"[0-9]{1,9}", length):
                return self.reply(400, {"error": "SIDECAR_LENGTH"})
            size = int(length)
            if size > MAX_BODY:
                return self.reply(413, {"error": "SIDECAR_BODY_LIMIT"})
            try:
                raw = self.rfile.read(size)
                if len(raw) != size:
                    raise ValueError()
                self.body = json.loads(raw)
                if not isinstance(self.body, dict):
                    raise ValueError()
            except (ValueError, UnicodeError, socket.timeout):
                return self.reply(400, {"error": "SIDECAR_JSON_INVALID"})
        self.body_deadline.cancel()
        # Native inference cannot safely be cancelled in a Python thread. A hard
        # deadline terminates this disposable worker; the daemon restarts it.
        timer = threading.Timer(REQUEST_SECONDS, lambda: os._exit(70))
        timer.daemon = True
        timer.start()
        try:
            (self.post if post else self.get)()
        except Exception:
            self.reply(503, {"error": "SIDECAR_REQUEST_FAILED"})
        finally:
            timer.cancel()
    def do_GET(self):
        self.dispatch()
    def do_POST(self):
        self.dispatch(post=True)
    def log_message(self, *args):
        pass
