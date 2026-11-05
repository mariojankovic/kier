"""Kier's own local model runtime: Qwen 3.5 9B (4-bit MLX) behind the part of Ollama's API the daemon uses, so Kier
needs no separate Ollama process. Idle unloading and bounded prompt caches limit memory use.
Owner-only Unix socket and offline. The weights load on the first request and go again once a request's keep_alive
has passed, so between bursts this process holds next to nothing. Every request starts with the same long
instructions and examples; their state is worked out once and reused, and only a few such prefixes are kept."""
import contextlib, copy, ctypes, gc, importlib, json, os, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from secure_http import SecureHandler, SecureServer

import mlx.core as mx
from mlx_lm import load, stream_generate
from mlx_lm.models.cache import make_prompt_cache
from mlx_lm.sample_utils import make_sampler

# MODEL "-" runs search by meaning alone, in its own process (runtime.mjs), so a search never waits for the model.
MODEL, SOCKET = sys.argv[1], sys.argv[2]
# Search by meaning (embedder.py): its own small model, loaded on the first search or indexing batch and gone again
# after its keep_alive, like the 9B. Started isolated (-I), so its folder is added by hand.
EMBED = os.environ.get("KIER_EMBED_MODEL")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# MLX keeps freed buffers for reuse; uncapped that held 2.5 GB on top of the weights in the 399-message run (8.1 GB peak).
mx.set_cache_limit(512 * 1024 * 1024)
NAME = os.environ.get("KIER_MODEL_NAME", "qwen3.5:9b")
# A shared start shorter than this isn't worth keeping: working it out again is as quick as copying it.
MIN_PREFIX = 256
PREFIXES = 3
# Prompts are read this many tokens at a time: one 3,900 token prompt in one go peaked at 6.9 GB, in pieces at 6.05,
# just as quick.
PREFILL = 512

_libc = ctypes.CDLL(None)


def pressure():
    """How short of memory macOS says the Mac is: 1 fine, 2 warning, 4 critical."""
    v, n = ctypes.c_int(1), ctypes.c_size_t(ctypes.sizeof(ctypes.c_int))
    if _libc.sysctlbyname(b"kern.memorystatus_vm_pressure_level", ctypes.byref(v), ctypes.byref(n), None, 0) != 0:
        return 1
    return v.value


# mlx_lm wires the model into memory while it generates, so macOS can't page any of it out. With room to spare that
# keeps it quick; when other processes already consume the available memory it pushed everything else into swap and
# the whole Mac crawled. So it wires only while memory is fine, and otherwise Kier is what waits.
# (The module by name: mlx_lm.generate as an attribute is the function of that name.)
mlx_lm_generate = importlib.import_module("mlx_lm.generate")
_wired_limit = mlx_lm_generate.wired_limit
mlx_lm_generate.wired_limit = lambda model, streams=None: (
    _wired_limit(model, streams) if pressure() == 1 else contextlib.nullcontext())

# One request on the model at a time. Someone waiting (a search, a question to Kier) goes before background reading,
# and background reading holds back for a moment after one, so a search typed in pauses isn't stuck behind a card being
# read: it waited 2 to 4 s for tagging before.
gate = threading.Condition()
busy = False
waiting = 0
last_asked = 0.0
HOLD_BACK = 3.0


@contextlib.contextmanager
def turn(asked=False, timeout=30):
    global busy, waiting, last_asked
    with gate:
        if asked:
            waiting += 1
            ready = gate.wait_for(lambda: not busy, timeout=timeout)
            waiting -= 1
            if not ready:
                raise TimeoutError("SIDECAR_QUEUE_TIMEOUT")
        else:
            deadline = time.monotonic() + timeout
            while busy or waiting or time.monotonic() - last_asked < HOLD_BACK:
                if time.monotonic() >= deadline:
                    raise TimeoutError("SIDECAR_QUEUE_TIMEOUT")
                gate.wait(min(1, deadline - time.monotonic()))
        busy = True
    try:
        yield
    finally:
        with gate:
            busy = False
            if asked:
                last_asked = time.monotonic()
            gate.notify_all()


model = tokenizer = None
until = 0.0
embedder = None
embed_until = 0.0
prefixes = []  # [(tokens, cache)], most recently used last
last_tokens = []


def seconds(keep_alive):
    """Ollama's keep_alive: "1m", "30s", "2h", a number of seconds, 0 to unload now, negative to keep."""
    if keep_alive is None:
        return 300
    if isinstance(keep_alive, (int, float)):
        return float(keep_alive)
    s = str(keep_alive).strip()
    unit = {"s": 1, "m": 60, "h": 3600}.get(s[-1:], None)
    return float(s[:-1]) * unit if unit else float(s)


def ensure_loaded():
    global model, tokenizer
    if model is None:
        model, tokenizer = load(MODEL)
        print(f"loaded {NAME}", flush=True)
        return True
    return False


def unload():
    global model, tokenizer, prefixes, last_tokens
    model = tokenizer = None
    prefixes, last_tokens = [], []
    gc.collect()
    mx.clear_cache()
    print("unloaded", flush=True)


def unload_when_idle():
    global embedder
    while True:
        time.sleep(2)
        # In its own turn, so it never unloads in the middle of a request.
        with turn(timeout=24 * 3600):
            # Short of memory, nothing is kept for later: the next request loads again.
            tight = pressure() > 1
            if model is not None and (tight or (until >= 0 and time.monotonic() > until)):
                unload()
            if embedder is not None and (tight or time.monotonic() > embed_until):
                embedder = None
                gc.collect()
                mx.clear_cache()
                print("unloaded search", flush=True)


threading.Thread(target=unload_when_idle, daemon=True).start()


def copy_cache(cache):
    """Each layer's cache with its own copy of the arrays, so generating from it leaves the kept prefix as it was.
    Qwen 3.5 mixes attention layers (KVCache) with linear ones (ArraysCache); both take their state back this way."""
    out = []
    for c in cache:
        n = copy.copy(c)
        n.state = _copy(c.state)
        out.append(n)
    return out


def _copy(v):
    # ArraysCache's state is (list of arrays, None, None); KVCache's is (keys, values, offset).
    if isinstance(v, mx.array):
        return mx.array(v)
    if isinstance(v, (list, tuple)):
        return type(v)(_copy(x) for x in v)
    return v


def prefill(tokens):
    """A cache holding `tokens`, and how many of them it already covers."""
    cache = make_prompt_cache(model)
    for i in range(0, len(tokens), PREFILL):
        model(mx.array(tokens[i:i + PREFILL])[None], cache=cache)
        mx.eval([c.state for c in cache])
    return cache


def cache_for(tokens):
    """A fresh cache for this prompt, already through as much of its start as an earlier prompt shared, and the
    tokens still to process (at least the last one, which generation starts from)."""
    global last_tokens
    if os.environ.get("KIER_NO_PREFIX"):
        return make_prompt_cache(model), tokens
    for i in range(len(prefixes) - 1, -1, -1):
        p, cache = prefixes[i]
        if len(p) < len(tokens) and tokens[:len(p)] == p:
            prefixes.append(prefixes.pop(i))
            last_tokens = tokens
            return copy_cache(cache), tokens[len(p):]
    # A start this prompt shares with the one before it: worked out once, kept for the next ones.
    shared = 0
    for a, b in zip(tokens, last_tokens):
        if a != b:
            break
        shared += 1
    last_tokens = tokens
    shared = min(shared, len(tokens) - 1)
    if shared >= MIN_PREFIX:
        cache = prefill(tokens[:shared])
        prefixes.append((tokens[:shared], cache))
        del prefixes[:-PREFIXES]
        return copy_cache(cache), tokens[shared:]
    return make_prompt_cache(model), tokens


class SteppedAside(Exception):
    """Background reading gave way to someone waiting; the daemon asks again on its next pass."""


def chat(body):
    """Yields (text piece, None) as it generates, then (None, stats)."""
    global until
    asked = bool(body.get("asked"))

    # A search queued behind a card being read waited out the whole read: background reading checks between
    # pieces of the prompt and between words of the answer, and stops when someone is waiting.
    def give_way():
        if not asked and waiting:
            raise SteppedAside("stepped aside for a question")

    t0 = time.monotonic()
    loaded = ensure_loaded()
    load_ns = int((time.monotonic() - t0) * 1e9) if loaded else 0
    options = body.get("options") or {}
    tokens = tokenizer.apply_chat_template(body["messages"], add_generation_prompt=True,
                                           enable_thinking=bool(body.get("think", False)))
    cache, rest = cache_for(list(tokens))
    # The prompt is read here, a piece at a time, rather than inside stream_generate, so it can stop between pieces.
    with mlx_lm_generate.wired_limit(model):
        for i in range(0, len(rest) - 1, PREFILL):
            give_way()
            model(mx.array(rest[i:min(i + PREFILL, len(rest) - 1)])[None], cache=cache)
            mx.eval([c.state for c in cache])
    temp = float(options.get("temperature", 0.7))
    sampler = make_sampler(temp=temp, top_p=float(options.get("top_p", 0.95)), top_k=int(options.get("top_k", 20))) if temp > 0 else make_sampler(temp=0)
    n_out, t1 = 0, time.monotonic()
    for r in stream_generate(model, tokenizer, prompt=rest[-1:], max_tokens=int(options.get("num_predict", 1024)) if int(options.get("num_predict", 1024)) > 0 else 1024,
                             sampler=sampler, prompt_cache=cache):
        give_way()
        n_out += 1
        if r.text:
            yield r.text, None
    keep = seconds(body.get("keep_alive"))
    until = time.monotonic() + keep if keep >= 0 else -1
    yield None, {"total_duration": int((time.monotonic() - t0) * 1e9), "load_duration": load_ns,
                 "prompt_eval_count": len(tokens), "eval_count": n_out, "eval_duration": int((time.monotonic() - t1) * 1e9)}


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class Handler(SecureHandler):
    protocol_version = "HTTP/1.1"

    def get(self):
        if self.path == "/api/version":
            return self.reply(200, {"version": "kier-mlx"})
        if self.path in ("/api/tags", "/api/ps"):
            return self.reply(200, {"models": [{"name": NAME, "model": NAME}] if self.path == "/api/tags" or model is not None else []})
        self.reply(404, {"error": "not found"})

    def embed(self, body):
        """Ollama's /api/embed, plus kind ("query" for a question, "document" for a message) and dims."""
        global embedder, embed_until
        if not EMBED or not os.path.exists(os.path.join(EMBED, ".kier-ready")):
            return self.reply(404, {"error": "search by meaning isn't installed"})
        texts = body.get("input") or []
        texts = [texts] if isinstance(texts, str) else [str(t) for t in texts][:256]
        with turn(asked=body.get("kind") == "query"):
            try:
                if embedder is None:
                    import embedder as e
                    embedder = e.Embedder(EMBED)
                    print("loaded search", flush=True)
                out = embedder(texts, query=body.get("kind") == "query", dims=int(body.get("dims") or 256))
                embed_until = time.monotonic() + seconds(body.get("keep_alive", "1m"))
            except Exception as e:
                print('{"code":"SIDECAR_MODEL_FAILED"}', flush=True)
                return self.reply(500, {"error": "SIDECAR_MODEL_FAILED"})
        self.reply(200, {"model": "embeddinggemma-2", "embeddings": out})

    def post(self):
        if self.path == "/api/embed":
            return self.embed(self.body)
        if self.path != "/api/chat" or MODEL == "-":
            return self.reply(404, {"error": "not found"})
        body = self.body
        if not body.get("messages"):
            return self.reply(400, {"error": "no messages"})
        with turn(asked=bool(body.get("asked"))):
            started = False
            try:
                if body.get("stream", True):
                    started = True
                    self.send_response(200)
                    self.send_header("content-type", "application/x-ndjson")
                    self.send_header("transfer-encoding", "chunked")
                    self.end_headers()
                    def send(obj):
                        data = (json.dumps(obj) + "\n").encode()
                        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
                        self.wfile.flush()
                    for piece, stats in chat(body):
                        if piece is not None:
                            send({"model": NAME, "created_at": now(), "message": {"role": "assistant", "content": piece}, "done": False})
                        else:
                            send({"model": NAME, "created_at": now(), "message": {"role": "assistant", "content": ""}, "done": True, "done_reason": "stop", **stats})
                    self.wfile.write(b"0\r\n\r\n")
                    return
                text, stats = "", {}
                for piece, s in chat(body):
                    if piece is not None:
                        text += piece
                    else:
                        stats = s
                self.reply(200, {"model": NAME, "created_at": now(), "message": {"role": "assistant", "content": text}, "done": True, "done_reason": "stop", **stats})
            except Exception as e:
                if not isinstance(e, SteppedAside):
                    print('{"code":"SIDECAR_MODEL_FAILED"}', flush=True)
                try:
                    if started:
                        # Mid-stream the status is already sent: the error goes as the last line, as Ollama does.
                        data = (json.dumps({"error": "SIDECAR_MODEL_FAILED", "done": True}) + "\n").encode()
                        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n0\r\n\r\n")
                    else:
                        self.reply(503 if isinstance(e, SteppedAside) else 500, {"error": "SIDECAR_MODEL_FAILED"})
                except Exception:
                    pass

    def log_message(self, *args):
        pass


print(f"{'search' if MODEL == '-' else 'local model'} ready on private socket", flush=True)
SecureServer(SOCKET, Handler).serve_forever()
