"""A batch of pick-one judgements in one pass through the model, with one layer in memory at a time.

Writing an answer takes a pass through every layer for every word, so the whole model has to stay loaded. Choosing
between "true" and "false" takes one pass. So each layer is read from disk, used for every message in the batch, and
let go before the next is read: the most memory in use is one layer and the messages' own states, about a fifth of the
loaded model. What comes out is what the loaded model would have written first, to within one rounding step.

The instructions and examples every prompt starts with are the same every time, and most of each prompt. What each layer
makes of them is kept in a file beside the vault (a hundred megabytes or so; it holds the instructions' state, never a
message), so a pass reads only the messages themselves. The file is made on the first pass and again whenever the
instructions or the model change. Nothing else is kept: this is for reading in the background, where nobody is waiting.

Written against the layout of Qwen 3.5 in mlx_lm (language_model.model with embed_tokens, layers and norm); any other
model raises Unsupported and the daemon reads the old way."""
import gc
import hashlib
import json
import os
from pathlib import Path

import mlx.core as mx
import mlx_lm
from mlx_lm.models import base
from mlx_lm.models.cache import load_prompt_cache, save_prompt_cache
from mlx_lm.utils import load_model, load_tokenizer

MAX_PROMPTS, MAX_CHOICES, MAX_LEAD_CHARS = 64, 20, 200
# A shared start shorter than this isn't worth a second set of states.
MIN_SHARED = 64


class Unsupported(Exception):
    """This model isn't laid out the way the layer-by-layer pass needs."""


def tokenizer(path):
    return load_tokenizer(Path(path))


def check(body):
    """(prompts, lead, choices, more) from a request, or ValueError. `more` is a second question for some of the
    prompts, or None: its lead carries the answer on from the first, and its choices are read where that ends. It
    names the prompts in "for" and gives one "lead" for all of them or, in "leads", one each: the same prompt sent
    once per way its first answer could go has the second question read after every one of them, in the one pass."""
    prompts, lead, choices, more = body.get("prompts"), body.get("lead"), body.get("choices"), body.get("more")
    if (not isinstance(prompts, list) or not 1 <= len(prompts) <= MAX_PROMPTS
            or not all(isinstance(p, list) and p and all(isinstance(m, dict) for m in p) for p in prompts)):
        raise ValueError("prompts")
    if not isinstance(lead, str) or not 0 < len(lead) <= MAX_LEAD_CHARS:
        raise ValueError("lead")
    if (not isinstance(choices, list) or not 2 <= len(choices) <= MAX_CHOICES or len(set(choices)) != len(choices)
            or not all(isinstance(c, str) and 0 < len(c) <= 40 for c in choices)):
        raise ValueError("choices")
    if more is not None:
        if not isinstance(more, dict):
            raise ValueError("more")
        which, one, each, picks = more.get("for"), more.get("lead"), more.get("leads"), more.get("choices")
        led = lambda s: isinstance(s, str) and 0 < len(s) <= MAX_LEAD_CHARS
        if (not isinstance(which, list) or not all(isinstance(k, int) and not isinstance(k, bool) and 0 <= k < len(prompts) for k in which)
                or not isinstance(picks, list) or not 1 <= len(picks) <= MAX_CHOICES or len(set(picks)) != len(picks)
                or not all(isinstance(c, str) and 0 < len(c) <= 40 for c in picks)):
            raise ValueError("more")
        if each is None:
            if not led(one):
                raise ValueError("more")
            leads = {k: one for k in which}
        else:
            if not isinstance(each, list) or len(each) != len(which) or len(set(which)) != len(which) or not all(led(s) for s in each):
                raise ValueError("more")
            leads = dict(zip(which, each))
        more = {"leads": leads, "choices": picks}
    return prompts, lead, choices, more


def instructions(tok, prompt):
    """How many of this prompt's tokens come before its last message: the instructions and examples. Found as where two
    prompts that differ only in that message start to differ (the template won't render them on their own)."""
    if prompt[-1].get("role") != "user":
        return 0
    a, b = (list(tok.apply_chat_template(prompt[:-1] + [{"role": "user", "content": q}], add_generation_prompt=True,
                                         enable_thinking=False)) for q in ("a", "b"))
    return next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), 0)


def begins(tok, lead, choices):
    """The lead as tokens, and the token that begins each choice after it."""
    start = tok.encode(lead, add_special_tokens=False)
    firsts = []
    for c in choices:
        whole = tok.encode(lead + c, add_special_tokens=False)
        # The lead has to read the same with and without the choice after it, or the pass isn't the model's own.
        if whole[:len(start)] != start or len(whole) <= len(start):
            raise ValueError("choices")
        firsts.append(whole[len(start)])
    if len(set(firsts)) != len(firsts):
        raise ValueError("choices")
    return start, firsts


def tokens(tok, prompts, lead, choices, more=None):
    """Each prompt as tokens ending in the lead its answer starts with, the token that begins each choice, and for a
    second question: for each prompt that has it the tokens that begin its choices and where the first lead ends
    (None for the rest). Both questions are read off the one pass, at two places in the same answer."""
    start, firsts = begins(tok, lead, choices)
    out, where, seconds, read, carried = [], [], [], {}, {}
    for k, p in enumerate(prompts):
        # The same prompt sent several times (once per lead) is rendered once.
        key = json.dumps(p, sort_keys=True)
        if key not in read:
            read[key] = list(tok.apply_chat_template(p, add_generation_prompt=True, enable_thinking=False))
        asked, on = read[key], (more["leads"].get(k) if more else None)
        if on is None:
            out.append(asked + start); where.append(None); seconds.append(None)
            continue
        if on not in carried:
            longer, begin = begins(tok, lead + on, more["choices"])
            if longer[:len(start)] != start or len(longer) <= len(start):
                raise ValueError("more")
            carried[on] = (longer, begin)
        longer, begin = carried[on]
        out.append(asked + longer); where.append(len(asked) + len(start) - 1); seconds.append(begin)
    return out, firsts, ((seconds, more["choices"], where) if more else None)


def parts(model):
    lm = getattr(model, "language_model", None)
    inner = getattr(lm, "model", None)
    if inner is None or not all(hasattr(inner, a) for a in ("embed_tokens", "layers", "norm")) or not hasattr(lm, "make_cache"):
        raise Unsupported()
    return lm, inner


def decide(lm, inner, hidden, firsts, choices):
    """From the last position's state, how likely each choice is, and how much of everything the model might have
    written next was one of them. The last step is done in 32 bits: at the model's own 16, scores land on a grid an
    eighth apart, which moves a probability by up to three points."""
    last = hidden[:, -1:, :].astype(mx.float32)
    logits = (inner.embed_tokens.as_linear(last) if lm.args.tie_word_embeddings else lm.lm_head(last))[0, -1, :]
    lp = logits - mx.logsumexp(logits)
    picked = lp[mx.array(firsts)]
    share = mx.softmax(picked).tolist()
    return {"options": {c: round(p, 4) for c, p in zip(choices, share)}, "covered": round(float(mx.exp(mx.logsumexp(picked)).item()), 4)}


def shared(prompts):
    """How many tokens every prompt starts with, leaving each at least one of its own."""
    n = min(len(p) for p in prompts) - 1
    first = prompts[0]
    for p in prompts[1:]:
        k = 0
        while k < n and p[k] == first[k]:
            k += 1
        n = k
    return n if len(prompts) > 1 and n >= MIN_SHARED else 0


def fingerprint(path, start):
    """What the kept state was made from: these tokens, these weights, this version of the runtime."""
    made = os.stat(Path(path) / "config.json")
    weights = sorted((f.name, f.stat().st_size, f.stat().st_mtime_ns) for f in Path(path).glob("*.safetensors"))
    return hashlib.sha256(json.dumps([start, weights, made.st_mtime_ns, mlx_lm.__version__]).encode()).hexdigest()


def recall(store, key):
    """Each layer's state after the instructions, as kept by an earlier pass, or None when there is none for these."""
    try:
        kept, about = load_prompt_cache(store, return_metadata=True)
        return kept if about.get("key") == key else None
    except Exception:
        return None


def keep(store, key, kept):
    try:
        beside = store[:-len(".safetensors")] + ".next.safetensors"
        save_prompt_cache(beside, kept, {"key": key})
        os.replace(beside, store)
    except Exception:
        pass  # the next pass makes it again


def cold(path, prompts, firsts, choices, copy_cache, give_way=lambda: None, start=0, store=None, second=None):
    """The pass itself. `prompts` are token lists, of which the first `start` tokens are the instructions when every
    prompt has the same ones; `second` is tokens()'s third value. Returns one decide() result per prompt, with the
    second question's under "more" where it was asked, and what the pass took."""
    model, _ = load_model(Path(path), lazy=True)
    lm, inner = parts(model)
    # Where each prompt's first answer is read: the end, or where its first lead ends when a second one follows.
    at = [len(p) - 1 if not second or second[2][k] is None else second[2][k] for k, p in enumerate(prompts)]
    same = start >= MIN_SHARED and start <= min(at) and all(len(p) > start and p[:start] == prompts[0][:start] for p in prompts)
    n = start if same else min(shared(prompts), min(at))
    key = fingerprint(path, prompts[0][:n]) if same and store and store.endswith(".safetensors") else None
    known = recall(store, key) if key else None
    if known is not None and len(known) != len(inner.layers):
        known = None
    fresh = [] if key and known is None else None
    caches = lm.make_cache()
    head = inner.embed_tokens(mx.array(prompts[0][:n])[None]) if n and known is None else None
    states = [inner.embed_tokens(mx.array(p[n:])[None]) for p in prompts]
    mx.eval(states, head)
    for i in range(len(inner.layers)):
        give_way()
        layer, kept = inner.layers[i], (known[i] if known is not None else caches[i])
        mask = base.create_ssm_mask if layer.is_linear else base.create_attention_mask
        if head is not None:
            head = layer(head, mask=mask(head, kept), cache=kept)
            mx.eval(head, kept.state)
        if fresh is not None:
            fresh.append(kept)
        for k, h in enumerate(states):
            # Each message carries on from the shared start on its own copy of this layer's memory of it.
            own = copy_cache([kept])[0] if n else None
            states[k] = layer(h, mask=mask(h, own), cache=own)
            mx.eval(states[k])
            del own
        # This layer has done its work for every message: let it go before the next one is read.
        inner.layers[i] = caches[i] = None
        if known is not None:
            known[i] = None
        del layer, kept
        gc.collect()
        mx.clear_cache()
    out = []
    for k, h in enumerate(states):
        first = decide(lm, inner, inner.norm(h[:, at[k] - n:at[k] - n + 1, :]), firsts, choices)
        if at[k] != len(prompts[k]) - 1:
            first["more"] = decide(lm, inner, inner.norm(h[:, -1:, :]), second[0][k], second[1])
        out.append(first)
    if fresh is not None:
        keep(store, key, fresh)
    recalled = known is not None
    read = sum(len(p) - n for p in prompts) + (0 if recalled else n)
    del model, lm, inner, states, head, caches, known, fresh
    gc.collect()
    mx.clear_cache()
    return out, {"shared": n, "read": read, "recalled": recalled}
