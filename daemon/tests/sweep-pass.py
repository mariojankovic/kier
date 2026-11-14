"""sweep.py's bookkeeping against a toy model laid out like Qwen 3.5: two kinds of layer, one remembering a running
total (as the linear layers do), one remembering every position (as attention does). What a layer-at-a-time pass says
has to equal running each prompt straight through, whether the shared instructions are read in the pass, read once
and shared, or recalled from the file an earlier pass kept. Needs mlx; sweep-pass.test.mjs skips it where there is none."""
import copy, os, sys, tempfile, types
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sidecar"))
import mlx.core as mx
from mlx_lm.models.cache import ArraysCache, KVCache
import sweep

V, D = 40, 8
mx.random.seed(7)
WEIGHTS = mx.random.normal((V, D))
mx.eval(WEIGHTS)


class Embedding:
    def __call__(self, ids): return WEIGHTS[ids]
    def as_linear(self, x): return x @ WEIGHTS.T


class Running:
    """Each position gets the mean of everything up to it; the total so far is all it carries."""
    is_linear = True
    def __call__(self, x, mask=None, cache=None):
        before = cache[0] if cache is not None and cache[0] is not None else mx.zeros((x.shape[0], 1, D))
        seen = cache[1] if cache is not None and cache[1] is not None else mx.zeros((1,))
        total = mx.cumsum(x, axis=1) + before
        if cache is not None:
            cache[0], cache[1] = total[:, -1:, :], seen + x.shape[1]
        return x + 0.5 * total / (mx.arange(1, x.shape[1] + 1)[None, :, None] + seen)


class Looking:
    """The same mean, worked out by keeping every position, the way attention keeps its keys."""
    is_linear = False
    def __call__(self, x, mask=None, cache=None):
        everything = cache.update_and_fetch(x[:, None], x[:, None])[0][:, 0] if cache is not None else x
        n, t = everything.shape[1], x.shape[1]
        return x + 0.5 * mx.cumsum(everything, axis=1)[:, n - t:, :] / mx.arange(n - t + 1, n + 1)[None, :, None]


made = []


def toy(path=None, lazy=True):
    inner = types.SimpleNamespace(embed_tokens=Embedding(), layers=[Running(), Looking(), Running(), Looking()], norm=lambda x: x)
    lm = types.SimpleNamespace(model=inner, args=types.SimpleNamespace(tie_word_embeddings=True),
                               make_cache=lambda: [ArraysCache(size=2) if l.is_linear else KVCache() for l in inner.layers])
    made.append(inner)
    return types.SimpleNamespace(language_model=lm), {}


sweep.load_model = toy


def _copy(v):
    if isinstance(v, mx.array): return mx.array(v)
    if isinstance(v, (list, tuple)): return type(v)(_copy(x) for x in v)
    return v


def copy_cache(cache):
    out = []
    for c in cache:
        n = copy.copy(c)
        n.state = _copy(c.state)
        out.append(n)
    return out


FIRSTS, CHOICES = [3, 5], ["true", "false"]


def straight(prompt, firsts=FIRSTS, choices=CHOICES):
    """The prompt run through every layer in one go, nothing shared, nothing kept."""
    model, _ = toy()
    lm, inner = sweep.parts(model)
    h = inner.embed_tokens(mx.array(prompt)[None])
    for layer in inner.layers:
        h = layer(h)
    return sweep.decide(lm, inner, h, firsts, choices)["options"][choices[-1]]


def same(got, prompts):
    want = [straight(p) for p in prompts]
    assert all(abs(g["options"]["false"] - w) < 2e-3 for g, w in zip(got, want)), ([g["options"]["false"] for g in got], want)
    assert all(abs(sum(g["options"].values()) - 1) < 1e-3 and 0 <= g["covered"] <= 1.001 for g in got), got


start = [(7 * i + 3) % V for i in range(90)]
prompts = [start + tail for tail in ([1, 2, 3], [9, 8, 7, 6, 5, 4], [11], [20, 21, 22, 23])]
folder = tempfile.mkdtemp()
open(os.path.join(folder, "config.json"), "w").write("{}")
# Kept beside the vault, not among the model's own files (which are part of what it is checked against).
store = os.path.join(tempfile.mkdtemp(), "state.safetensors")

# Nothing in common to share: each prompt read whole.
got, stats = sweep.cold(folder, [prompts[0], [4, 5, 6, 7]], FIRSTS, CHOICES, copy_cache)
assert stats["shared"] == 0 and not stats["recalled"], stats
assert all(layer is None for layer in made[-1].layers), "every layer is let go once it has been used"
same(got, [prompts[0], [4, 5, 6, 7]])

# A common start is read once, and each prompt carries on from its own copy of it.
got, stats = sweep.cold(folder, prompts, FIRSTS, CHOICES, copy_cache)
assert stats["shared"] == len(start) and stats["read"] == len(start) + 3 + 6 + 1 + 4, stats
same(got, prompts)

# With somewhere to keep it, the first pass keeps what the layers made of the instructions, and the next recalls it.
got, stats = sweep.cold(folder, prompts, FIRSTS, CHOICES, copy_cache, start=len(start), store=store)
assert not stats["recalled"] and os.path.exists(store), stats
same(got, prompts)
got, stats = sweep.cold(folder, prompts[::-1], FIRSTS, CHOICES, copy_cache, start=len(start), store=store)
assert stats["recalled"] and stats["read"] == 3 + 6 + 1 + 4, stats
same(got, prompts[::-1])
# One message on its own has nothing to share with, and still starts from what was kept.
got, stats = sweep.cold(folder, prompts[1:2], FIRSTS, CHOICES, copy_cache, start=len(start), store=store)
assert stats["recalled"] and stats["read"] == 6, stats
same(got, prompts[1:2])

# Other instructions, or other weights, are not what was kept: read afresh, and kept in its place.
other = [(5 * i + 1) % V for i in range(90)]
changed = [other + [1, 2, 3], other + [30, 31]]
got, stats = sweep.cold(folder, changed, FIRSTS, CHOICES, copy_cache, start=len(other), store=store)
assert not stats["recalled"], stats
same(got, changed)
assert sweep.cold(folder, changed, FIRSTS, CHOICES, copy_cache, start=len(other), store=store)[1]["recalled"]
open(os.path.join(folder, "model.safetensors"), "w").write("different weights")
assert not sweep.cold(folder, changed, FIRSTS, CHOICES, copy_cache, start=len(other), store=store)[1]["recalled"]
# A kept file that can't be read is ignored and replaced.
open(store, "w").write("not a state file")
got, stats = sweep.cold(folder, changed, FIRSTS, CHOICES, copy_cache, start=len(other), store=store)
assert not stats["recalled"], stats
same(got, changed)
# Told the instructions are longer than what the prompts really share: falls back to what they do share.
got, stats = sweep.cold(folder, [prompts[0], changed[0]], FIRSTS, CHOICES, copy_cache, start=len(start), store=store)
assert stats["shared"] == 0 and not stats["recalled"], stats
same(got, [prompts[0], changed[0]])

# A second question further along the same answer: the first is read where its lead ends, the second at the end, and
# each says what a straight run to that point does. Asked of some prompts and not others, shared, kept or recalled.
SECOND, ANSWERS = [8, 13, 21], ["asks", "tells", "says"]
deep = [start + [1, 2, 3, 30, 31, 32, 33], start + [9, 8, 7], start + [11, 12, 30, 31, 32, 33, 34, 35]]
where = [len(start) + 2, None, len(start) + 1]
for keep_in in (None, store):
    for _ in range(2 if keep_in else 1):
        got, stats = sweep.cold(folder, deep, FIRSTS, CHOICES, copy_cache, start=len(start) if keep_in else 0, store=keep_in, second=([SECOND if w is not None else None for w in where], ANSWERS, where))
        for g, p, w in zip(got, deep, where):
            assert abs(g["options"]["false"] - straight(p if w is None else p[:w + 1])) < 2e-3, (g, w)
            assert ("more" in g) == (w is not None), g
            if w is not None:
                assert abs(g["more"]["options"]["says"] - straight(p, SECOND, ANSWERS)) < 2e-3 and abs(sum(g["more"]["options"].values()) - 1) < 1e-3, g
assert stats["recalled"], stats
# Two prompts alike right up to where the first is read: what is shared stops short of that place.
twins = [start + [1, 2, 3, 30, 31], start + [1, 2, 3, 30, 32]]
got, stats = sweep.cold(folder, twins, FIRSTS, CHOICES, copy_cache, second=([SECOND, SECOND], ANSWERS, [len(start) + 2, len(start) + 2]))
assert stats["shared"] == len(start) + 2, stats
assert all(abs(g["options"]["false"] - straight(p[:len(start) + 3])) < 2e-3 and abs(g["more"]["options"]["says"] - straight(p, SECOND, ANSWERS)) < 2e-3 for g, p in zip(got, twins)), got
# One text asked once per way its first answer could go: read once up to the first answer, then each carries on its
# own way, and each second answer is read against the tokens its own lead ends in.
ways = [start + [1, 2, 3] + tail for tail in ([30, 31], [32, 33, 34], [35])]
began = [SECOND, [9, 14, 22], SECOND]
got, stats = sweep.cold(folder, ways, FIRSTS, CHOICES, copy_cache, second=(began, ANSWERS, [len(start) + 2] * 3))
assert stats["shared"] == len(start) + 2 and stats["read"] == len(start) + 2 + 3 + 4 + 2, stats
for g, p, b in zip(got, ways, began):
    assert abs(g["options"]["false"] - straight(p[:len(start) + 3])) < 2e-3, g
    assert abs(g["more"]["options"]["says"] - straight(p, b, ANSWERS)) < 2e-3, g
assert len({round(g["options"]["false"], 4) for g in got}) == 1, "the first answer is the same whichever way it is carried on"

assert sweep.shared([[1] * 70 + [2], [1] * 70 + [3]]) == 70 and sweep.shared([[1] * 70, [1] * 70]) == 69
assert sweep.shared([[1] * 10 + [2], [1] * 10 + [3]]) == 0 and sweep.shared([[1] * 70 + [2]]) == 0


class Tokenizer:
    """One token per character, except that a colon and a t after it make one token of their own."""
    def encode(self, s, add_special_tokens=False):
        out, i = [], 0
        while i < len(s):
            if s[i:i + 2] == ":t":
                out.append(1000); i += 2
            else:
                out.append(ord(s[i])); i += 1
        return out
    def apply_chat_template(self, messages, add_generation_prompt=True, enable_thinking=False):
        return [1] * 70 + self.encode(messages[-1]["content"]) + [2]


ask = [[{"role": "system", "content": "s"}, {"role": "user", "content": "hello"}]]
toks, firsts, second = sweep.tokens(Tokenizer(), ask, 'x": ', ["true", "false"])
assert toks[0][-4:] == [ord(c) for c in 'x": '] and firsts == [ord("t"), ord("f")] and second is None, (toks, firsts, second)
two = ask + [[{"role": "user", "content": "bye"}]]
more = {"leads": {1: 'false, "y": "Sam '}, "choices": ["asks", "tells"]}
toks, firsts, second = sweep.tokens(Tokenizer(), two, 'x": ', ["true", "false"], more)
assert second[0] == [None, [ord("a"), ord("t")]] and second[1] == ["asks", "tells"] and second[2] == [None, 70 + 3 + 1 + 4 - 1], second
assert toks[0][-4:] == [ord(c) for c in 'x": '] and "".join(chr(t) for t in toks[1][-len('x": false, "y": "Sam '):]) == 'x": false, "y": "Sam ', toks
try:
    sweep.tokens(Tokenizer(), two, 'x": ', ["true", "false"], {"leads": {0: "x"}, "choices": [" asks", " also"]})
    raise AssertionError("two choices beginning alike were accepted")
except ValueError:
    pass
assert sweep.instructions(Tokenizer(), ask[0]) == 70
for lead, choices in [('x":', ["true", "false"]), ('x": ', ["true", "trouble"])]:
    try:
        sweep.tokens(Tokenizer(), ask, lead, choices)
    except ValueError:
        continue
    raise AssertionError(f"accepted {lead!r} {choices!r}")
for bad in [{}, {"prompts": [], "lead": "x", "choices": ["a", "b"]}, {"prompts": ask, "lead": "", "choices": ["a", "b"]},
            {"prompts": ask, "lead": "x", "choices": ["a"]}, {"prompts": ask, "lead": "x", "choices": ["a", "a"]},
            {"prompts": [[]], "lead": "x", "choices": ["a", "b"]}, {"prompts": ask * 65, "lead": "x", "choices": ["a", "b"]},
            {"prompts": ask, "lead": "x", "choices": ["a", "b"], "more": {"lead": "y", "choices": ["c"], "for": [1]}},
            {"prompts": ask, "lead": "x", "choices": ["a", "b"], "more": {"lead": "", "choices": ["c"], "for": [0]}},
            {"prompts": ask, "lead": "x", "choices": ["a", "b"], "more": {"lead": "y", "choices": [], "for": [0]}},
            {"prompts": ask, "lead": "x", "choices": ["a", "b"], "more": "y"}]:
    try:
        sweep.check(bad)
    except ValueError:
        continue
    raise AssertionError(f"accepted {bad!r}")
assert sweep.check({"prompts": ask, "lead": "x", "choices": ["a", "b"], "more": {"lead": "y", "choices": ["c"], "for": [0]}})[3]["leads"] == {0: "y"}
# The same prompt once per way its first answer could go, each with its own lead for the second question.
thrice = {"prompts": ask * 3, "lead": 'x": ', "choices": ["true", "false"], "more": {"leads": ['true, "y": "', 'false, "y": "'], "choices": ["asks", "tells"], "for": [0, 2]}}
_, _, _, each = sweep.check(thrice)
assert each["leads"] == {0: 'true, "y": "', 2: 'false, "y": "'}, each
toks, firsts, second = sweep.tokens(Tokenizer(), ask * 3, 'x": ', ["true", "false"], each)
assert second[2] == [70 + 5 + 1 + 4 - 1, None, 70 + 5 + 1 + 4 - 1] and second[0][1] is None and second[0][0] == second[0][2] == [ord("a"), ord("t")], second
assert "".join(chr(t) for t in toks[0][-len('x": true, "y": "'):]) == 'x": true, "y": "' and "".join(chr(t) for t in toks[2][-len('x": false, "y": "'):]) == 'x": false, "y": "', toks
assert toks[0][:76] == toks[1][:76] == toks[2][:76]
for bad in [{"leads": ["y"], "choices": ["c"], "for": [0, 1]}, {"leads": ["y", "z"], "choices": ["c"], "for": [0, 0]}, {"leads": ["y", ""], "choices": ["c"], "for": [0, 1]},
            {"leads": "y", "choices": ["c"], "for": [0]}, {"choices": ["c"], "for": [0]}]:
    try:
        sweep.check({"prompts": ask * 2, "lead": "x", "choices": ["a", "b"], "more": bad})
    except ValueError:
        continue
    raise AssertionError(f"accepted {bad!r}")
assert len(sweep.check({"prompts": ask, "lead": "x", "choices": [chr(65 + i) for i in range(20)]})[2]) == 20
try:
    sweep.parts(types.SimpleNamespace())
    raise AssertionError("a model laid out differently was accepted")
except sweep.Unsupported:
    pass

print("ok")
