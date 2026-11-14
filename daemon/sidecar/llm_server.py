"""Kier's own local model runtime: Qwen 3.5 9B (4-bit MLX) behind the part of Ollama's API the daemon uses, so Kier
needs no separate Ollama process. Idle unloading and bounded prompt caches limit memory use.
Owner-only Unix socket and offline. The weights load on the first request and go again once a request's keep_alive
has passed, so between bursts this process holds next to nothing. Every request starts with the same long
instructions and examples; their state is worked out once and reused, and only a few such prefixes are kept."""
import contextlib, copy, ctypes, gc, importlib, json, os, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from secure_http import REQUEST_SECONDS, SecureHandler, SecureServer

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
    pinned.clear()
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


# The worker is ended REQUEST_SECONDS after a request arrives (secure_http.py), which also loses the loaded model and
# whatever else was waiting. So work that would run into that stops by itself first: an answer being written ends
# where it is, a prompt still being read or a batch gives up. Counted from when the request came in, queue included.
LEAVE_BY = REQUEST_SECONDS - 12
BATCH_LEAVE_BY = REQUEST_SECONDS - 25


def chat(body, began=None):
    """Yields (text piece, None) as it generates, then (None, stats). `began` is when the request came in."""
    global until
    asked = bool(body.get("asked"))
    late = lambda: began is not None and time.monotonic() - began > LEAVE_BY

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
            if late():
                raise SteppedAside("out of time before the answer began")
            model(mx.array(rest[i:min(i + PREFILL, len(rest) - 1)])[None], cache=cache)
            mx.eval([c.state for c in cache])
    temp = float(options.get("temperature", 0.7))
    sampler = make_sampler(temp=temp, top_p=float(options.get("top_p", 0.95)), top_k=int(options.get("top_k", 20))) if temp > 0 else make_sampler(temp=0)
    n_out, t1, cut = 0, time.monotonic(), False
    for r in stream_generate(model, tokenizer, prompt=rest[-1:], max_tokens=int(options.get("num_predict", 1024)) if int(options.get("num_predict", 1024)) > 0 else 1024,
                             sampler=sampler, prompt_cache=cache):
        give_way()
        n_out += 1
        if r.text:
            yield r.text, None
        if late():
            # What is written so far goes back, marked as cut short, instead of the worker being ended mid-answer.
            cut = True
            break
    keep = seconds(body.get("keep_alive"))
    until = time.monotonic() + keep if keep >= 0 else -1
    yield None, {"total_duration": int((time.monotonic() - t0) * 1e9), "load_duration": load_ns,
                 "prompt_eval_count": len(tokens), "eval_count": n_out, "eval_duration": int((time.monotonic() - t1) * 1e9),
                 **({"done_reason": "time"} if cut else {})}


pinned = {}  # a form's instructions, read once and kept while the model is loaded: {tokens: cache}
PINNED = 6


def instructions_read(messages, tokens):
    """A cache already through a form's instructions, and the tokens after them. cache_for only notices a shared
    start when two such prompts come one after the other; a form's long, unchanging instructions arrive between
    other requests, so they are kept by what they are instead. None when the prompt has no such start."""
    system = [m for m in messages if m.get("role") == "system"][:1]
    if not system or os.environ.get("KIER_NO_PREFIX"):
        return None
    text = str(system[0].get("content"))
    if text not in pinned:
        # Where the instructions end: where two prompts that differ only in the question start to differ. (The
        # template won't render instructions on their own.)
        a, b = (list(tokenizer.apply_chat_template(system + [{"role": "user", "content": q}], add_generation_prompt=True,
                                                   enable_thinking=False)) for q in ("a", "b"))
        n = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), 0)
        if n < MIN_PREFIX:
            return None
        while len(pinned) >= PINNED:
            pinned.pop(next(iter(pinned)))
        pinned[text] = (a[:n], prefill(a[:n]))
    head, cache = pinned[text]
    if len(head) >= len(tokens) or tokens[:len(head)] != head:
        return None
    return copy_cache(cache), tokens[len(head):]


def fill_form(body, began=None):
    """A form filled in (form.py) rather than a reply written: the prompt is read and cached as for chat, and the
    form's own instructions are kept read between requests."""
    global until
    import form
    fields = form.check(body.get("fields"))
    asked = bool(body.get("asked"))

    def give_way():
        if not asked and waiting:
            raise SteppedAside("stepped aside for a question")
        if began is not None and time.monotonic() - began > LEAVE_BY:
            raise SteppedAside("out of time")

    t0 = time.monotonic()
    loaded = ensure_loaded()
    load_ns = int((time.monotonic() - t0) * 1e9) if loaded else 0
    tokens = list(tokenizer.apply_chat_template(body["messages"], add_generation_prompt=True, enable_thinking=False))
    cache, rest = instructions_read(body["messages"], tokens) or cache_for(tokens)
    with mlx_lm_generate.wired_limit(model):
        for i in range(0, len(rest) - 1, PREFILL):
            give_way()
            model(mx.array(rest[i:min(i + PREFILL, len(rest) - 1)])[None], cache=cache)
            mx.eval([c.state for c in cache])
        out = form.fill(model, tokenizer, cache, rest[-1], fields, copy_cache, give_way)
    keep = seconds(body.get("keep_alive"))
    until = time.monotonic() + keep if keep >= 0 else -1
    return {"model": NAME, **out, "done": True, "total_duration": int((time.monotonic() - t0) * 1e9),
            "load_duration": load_ns, "prompt_eval_count": len(tokens), "prompt_read_count": len(rest)}


def sweep_batch(body, began=None):
    """Pick-one judgements for a batch of prompts (sweep.py). With the model in memory already, it answers from
    there and how long it stays is left alone. Otherwise the batch goes through one layer at a time and the model
    is never loaded: reading in the background costs a fifth of the memory.

    "share": "all" is for prompts that are one text asked several ways (the same mail, once per way its first
    answer could go): everything they have in common is read once, and nothing is kept on disk. Without it the
    prompts share their instructions, whose state is kept beside the vault for the next batch."""
    import sweep
    prompts, lead, choices, more = sweep.check(body)
    asked = bool(body.get("asked"))
    together = body.get("share") == "all"
    t0 = time.monotonic()
    began = t0 if began is None else began

    def give_way():
        if not asked and waiting:
            raise SteppedAside("stepped aside for a question")
        # A batch that won't finish before the worker is ended stops here, and the daemon reads the usual way.
        if time.monotonic() - began > BATCH_LEAVE_BY:
            raise SteppedAside("batch too slow")

    mx.reset_peak_memory()
    if model is not None:
        toks, firsts, second = sweep.tokens(tokenizer, prompts, lead, choices, more)
        lm, inner = sweep.parts(model)
        # Where each first answer is read: the end, or where the first lead ends when a second one follows.
        ats = [len(t) - 1 if not second or second[2][k] is None else second[2][k] for k, t in enumerate(toks)]
        out = []
        with mlx_lm_generate.wired_limit(model):
            n = min(sweep.shared(toks), min(ats)) if together else 0
            head = None
            for i in range(0, n, PREFILL):
                give_way()
                head = head or make_prompt_cache(model)
                model(mx.array(toks[0][i:min(i + PREFILL, n)])[None], cache=head)
                mx.eval([c.state for c in head])
            for k, t in enumerate(toks):
                give_way()
                at = ats[k]
                if head is not None:
                    cache, rest = copy_cache(head), t[n:]
                else:
                    cache, rest = cache_for(t)
                    if len(t) - len(rest) > at:
                        cache, rest = make_prompt_cache(model), t
                upto = at - (len(t) - len(rest))
                for i in range(0, upto, PREFILL):
                    model(mx.array(rest[i:min(i + PREFILL, upto)])[None], cache=cache)
                    mx.eval([c.state for c in cache])
                hidden = inner(mx.array(rest[upto:])[None], cache=cache)
                first = sweep.decide(lm, inner, hidden[:, :1, :], firsts, choices)
                if at != len(t) - 1:
                    first["more"] = sweep.decide(lm, inner, hidden[:, -1:, :], second[0][k], second[1])
                out.append(first)
        stats = {"streamed": False}
    else:
        tok = sweep.tokenizer(MODEL)
        toks, firsts, second = sweep.tokens(tok, prompts, lead, choices, more)
        out, stats = sweep.cold(MODEL, toks, firsts, choices, copy_cache, give_way, start=0 if together else sweep.instructions(tok, prompts[0]),
                                store=None if together else os.path.join(os.path.dirname(os.path.abspath(SOCKET)), "first-word-state.safetensors"), second=second)
        stats["streamed"] = True
    return {"model": NAME, "results": out, **stats, "done": True, "peak_bytes": mx.get_peak_memory(),
            "total_duration": int((time.monotonic() - t0) * 1e9)}


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# One failed call is a slip. Several in a row mean something kept in memory is broken (seen once: every form failed
# from the moment the graphics processor was overrun, until the process was restarted). So after a few, everything
# kept goes, the model with it, and the next request starts clean; if that doesn't help, the process ends and the
# daemon starts a fresh one. Called inside a request's turn, so nothing else is using what it clears.
failures = 0
START_CLEAN, START_AGAIN = 3, 6


def failed():
    global failures
    failures += 1
    if failures == START_CLEAN:
        unload()
        form = sys.modules.get("form")
        if form is not None:
            form._masks.clear()
    elif failures >= START_AGAIN:
        print('{"code":"SIDECAR_MODEL_BROKEN"}', flush=True)
        os._exit(71)


def worked():
    global failures
    failures = 0


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

    def form(self, body):
        if not body.get("messages"):
            return self.reply(400, {"error": "no messages"})
        with turn(asked=bool(body.get("asked"))):
            try:
                out = fill_form(body, self.began)
                worked()
                self.reply(200, out)
            except ValueError:
                self.reply(400, {"error": "SIDECAR_FORM_INVALID"})
            except SteppedAside:
                self.reply(503, {"error": "SIDECAR_MODEL_FAILED"})
            except Exception as e:
                print('{"code":"SIDECAR_MODEL_FAILED"}', flush=True)
                failed()
                # The kind of failure only, never its message: enough to tell out-of-memory from a slip in form.py.
                self.reply(500, {"error": "SIDECAR_MODEL_FAILED", "kind": type(e).__name__})

    def sweep(self, body):
        with turn(asked=bool(body.get("asked"))):
            try:
                out = sweep_batch(body, self.began)
                worked()
                self.reply(200, out)
            except ValueError:
                self.reply(400, {"error": "SIDECAR_SWEEP_INVALID"})
            except SteppedAside:
                self.reply(503, {"error": "SIDECAR_MODEL_FAILED"})
            except Exception as e:
                print('{"code":"SIDECAR_MODEL_FAILED"}', flush=True)
                # A model laid out another way is a fact about the model, not a failure of this process.
                if type(e).__name__ != "Unsupported":
                    failed()
                self.reply(501 if type(e).__name__ == "Unsupported" else 500, {"error": "SIDECAR_MODEL_FAILED", "kind": type(e).__name__})

    def post(self):
        if self.path == "/api/embed":
            return self.embed(self.body)
        if self.path == "/api/form" and MODEL != "-":
            return self.form(self.body)
        if self.path == "/api/sweep" and MODEL != "-":
            return self.sweep(self.body)
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
                    for piece, stats in chat(body, self.began):
                        if piece is not None:
                            send({"model": NAME, "created_at": now(), "message": {"role": "assistant", "content": piece}, "done": False})
                        else:
                            send({"model": NAME, "created_at": now(), "message": {"role": "assistant", "content": ""}, "done": True, "done_reason": "stop", **stats})
                    worked()
                    self.wfile.write(b"0\r\n\r\n")
                    return
                text, stats = "", {}
                for piece, s in chat(body, self.began):
                    if piece is not None:
                        text += piece
                    else:
                        stats = s
                worked()
                self.reply(200, {"model": NAME, "created_at": now(), "message": {"role": "assistant", "content": text}, "done": True, "done_reason": "stop", **stats})
            except Exception as e:
                if not isinstance(e, SteppedAside):
                    print('{"code":"SIDECAR_MODEL_FAILED"}', flush=True)
                    # Whoever asked going away mid-answer says nothing about the model.
                    if not isinstance(e, ConnectionError):
                        failed()
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
