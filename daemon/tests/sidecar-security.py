import ast
import contextlib
import http.client
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

os.environ.setdefault('KIER_SIDECAR_TOKEN', 'a' * 64)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sidecar'))
from secure_http import SecureHandler, SecureServer, MAX_BODY

class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('kier-sidecar', timeout=2)
        self.path = path
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(2)
        self.sock.connect(self.path)

class Security(unittest.TestCase):
    def handler(self, name, folder):
        tree = ast.parse((Path(__file__).resolve().parents[1] / 'sidecar' / name).read_text())
        handler = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Handler')
        scope = dict(SecureHandler=SecureHandler, json=json, time=time, os=os, MODEL='fixture', NAME='fixture',
                     model=SimpleNamespace(system_one=lambda *_: {'answers': {'owner_task': {'noul': 1}}}),
                     lock=threading.Lock(), KEY='owner', QUESTIONS={}, state=lambda m: m, last=0,
                     now=lambda: 'fixture', turn=lambda **_: contextlib.nullcontext(), SteppedAside=type('SteppedAside', (Exception,), {}),
                     EMBED=folder, embedder=lambda texts, **_: [[1] for _ in texts], seconds=lambda _: 1,
                     chat=lambda _, began=None: iter([('fixture', None), (None, {})]), failed=lambda: None, worked=lambda: None)
        exec(compile(ast.Module(body=[handler], type_ignores=[]), name, 'exec'), scope)
        return scope['Handler'], scope
    def test_actual_handlers(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, '.kier-ready').touch()
            for name, get, posts in [('llm_server.py', '/api/version', [('/api/chat', {'messages': [{}], 'stream': False}), ('/api/embed', {'input': ['fixture']})]),
                                     ('d1_server.py', '/health', [('/decide', {'messages': [{}]}), ('/ask', {'states': [{}], 'questions': {}})])]:
                handler, scope = self.handler(name, folder)
                server = SecureServer(str(Path(folder, name + '.sock')), handler)
                thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
                def request(method, path, body=None, headers=None):
                    conn = UnixConnection(server.server_address)
                    try:
                        try:
                            conn.request(method, path, body=body, headers=headers or {})
                        except BrokenPipeError:
                            # Header rejection can close the socket before the body is sent.
                            # Still require the actual HTTP rejection response below.
                            pass
                        res = conn.getresponse()
                        return res.status, res.read()
                    finally:
                        conn.close()
                auth = {'x-kier-token': 'a' * 64, 'content-type': 'application/json'}
                try:
                    self.assertEqual(request('GET', get)[0], 401)
                    self.assertEqual(request('GET', get, headers=auth)[0], 200)
                    for bad in [{'host': 'example.test'}, {'origin': 'https://example.test'}, {'x-kier-token': 'wrong'}]:
                        self.assertIn(request('GET', get, headers={**auth, **bad})[0], [401, 403])
                    for path, data in posts:
                        self.assertEqual(request('POST', path, json.dumps(data), auth)[0], 200)
                        self.assertEqual(request('POST', path, '{}', {**auth, 'content-type': 'text/plain'})[0], 415)
                        self.assertEqual(request('POST', path, '{PRIVATE_MARKER', auth)[0], 400)
                        self.assertEqual(request('POST', path, '[]', auth)[0], 400)
                        self.assertEqual(request('POST', path, '', {**auth, 'content-length': str(MAX_BODY + 1)})[0], 413)
                    # Request slots bound both slow readers and requests waiting for inference.
                    slots = [server.slots.acquire(timeout=2) for _ in range(4)]
                    self.assertTrue(all(slots)); self.assertFalse(server.slots.acquire(blocking=False))
                    for _ in slots: server.slots.release()
                    def fail(*_): raise ValueError('PRIVATE_MARKER')
                    scope['chat'] = fail
                    scope['model'] = SimpleNamespace(system_one=fail)
                    # The language model's handler counts its failures, so a run of them can start it clean.
                    counted = []
                    scope['failed'] = lambda: counted.append(1)
                    status, body = request('POST', posts[0][0], json.dumps(posts[0][1]), auth)
                    self.assertGreaterEqual(status, 500); self.assertNotIn(b'PRIVATE_MARKER', body)
                    if name == 'llm_server.py': self.assertEqual(len(counted), 1)
                finally:
                    server.shutdown(); server.server_close(); thread.join()

if __name__ == '__main__':
    if '--serve-fixture' in sys.argv:
        with contextlib.nullcontext(os.environ['KIER_DATA_DIR']) as folder:
            Path(folder, '.kier-ready').touch()
            servers = []
            for name, endpoint in [('llm_server.py', 'llm.sock'), ('llm_server.py', 'embed.sock'), ('d1_server.py', 'd1.sock')]:
                handler, _ = Security().handler(name, folder)
                server = SecureServer(str(Path(folder, endpoint)), handler)
                threading.Thread(target=server.serve_forever, daemon=True).start()
                servers.append(server)
            print(json.dumps([s.server_address for s in servers]), flush=True)
            threading.Event().wait()
    else:
        unittest.main()
