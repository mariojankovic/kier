"""form.py against a scripted toy model: one token per character, plus a few longer ones. The "model" wants to write
whatever script(text so far) returns next, with logit 5 on that token and 0 on every other, so every probability
below can be worked out by hand. Needs mlx; form-decoding.test.mjs skips it where there is none."""
import copy, math, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sidecar"))
import mlx.core as mx
import form

CHARS = [chr(c) for c in range(32, 127)] + ["\n"]
EXTRA = ['",', '"}', ' "', "<eos>"]
VOCAB = CHARS + EXTRA
ID = {s: i for i, s in enumerate(VOCAB)}
SIZE = len(VOCAB) + 3  # the model's output is a little wider than the vocabulary, as Qwen's is


class Inner:
    all_special_ids = [ID["<eos>"]]
    def __len__(self): return len(VOCAB)
    def convert_ids_to_tokens(self, ids): return [VOCAB[i] for i in ids]


class Tokenizer:
    _tokenizer = Inner()
    def encode(self, s, add_special_tokens=False): return [ID[c] for c in s]
    def decode(self, ids): return "".join(VOCAB[i] for i in ids)


class History:
    def __init__(self): self.tokens = []


class Model:
    def __init__(self, script): self.script, self.calls = script, 0
    def __call__(self, tokens, cache=None):
        self.calls += 1
        cache[0].tokens.extend(tokens[0].tolist())
        want = self.script("".join(VOCAB[i] for i in cache[0].tokens))
        logits = [0.0] * SIZE
        for token, logit in (want if isinstance(want, dict) else {want: 5.0}).items():
            logits[ID[token]] = logit
        return mx.array(logits)[None, None, :]


def run(script, fields, start="Typed: x"):
    model, cache = Model(script), [History()]
    cache[0].tokens = Tokenizer().encode(start[:-1])
    out = form.fill(model, Tokenizer(), cache, ID[start[-1]], form.check(fields), copy.deepcopy)
    return out, "".join(VOCAB[i] for i in cache[0].tokens), model


def after(text, lead):
    """What has been written of the value that `lead` opened, or None when the model isn't in that value."""
    i = text.rfind(lead)
    return None if i < 0 or '"' in text[i + len(lead):] else text[i + len(lead):]


def continuing(values):
    """A model that means to write values[name] in each field, then close the quote."""
    def script(text):
        for name, value in values.items():
            done = after(text, f'"{name}": "')
            if done is not None:
                return (value + '"')[len(done)] if len(done) <= len(value) else '"'
        return " "
    return script


P = math.exp(5) / (math.exp(5) + 1)  # the wanted one of two tokens
close = lambda a, b: abs(a - b) < 2e-3

# Options that begin alike are told apart further in, and their probabilities multiply out to one.
out, text, _ = run(continuing({"action": "dismiss"}), [{"name": "action", "choices": ["done", "dismiss", "answer"]}])
o = out["confidence"]["action"]["options"]
assert out["values"] == {"action": "dismiss"}, out
assert close(o["dismiss"], P * P) and close(o["done"], P * (1 - P)) and close(o["answer"], 1 - P), o
assert close(sum(o.values()), 1), o
assert close(out["confidence"]["action"]["covered"], (math.exp(5) + 1) / (math.exp(5) + SIZE - 1)), out
assert text.endswith('{"action": "dismiss'), text

# An option that is the start of another ("1" and "12") ends where the quote closes, however the quote is spelled.
for closing in ['"', '",']:
    script = lambda text, closing=closing: (lambda d: None if d is None else "1" if d == "" else closing)(after(text, '"target": "')) or " "
    out, _, _ = run(script, [{"name": "target", "choices": ["1", "12", "13", "none"]}])
    assert out["values"] == {"target": "1"}, (closing, out)
    assert out["confidence"]["target"]["options"]["1"] > 0.95, (closing, out)

# The model wanting something the form doesn't offer shows as low coverage, and still comes out as a listed option.
out, _, _ = run(lambda text: "z", [{"name": "action", "choices": ["done", "answer"]}])
assert out["values"]["action"] in ("done", "answer") and out["confidence"]["action"]["covered"] < 0.05, out

# Text is the model's own words up to the closing quote, in any of its spellings.
for closing in ['"', '",', '"}']:
    script = lambda text, closing=closing: (lambda d: None if d is None else ("Buy milk" + "\0")[len(d)] if len(d) < 8 else closing)(after(text, '"title": "')) or " "
    out, text, _ = run(script, [{"name": "title", "text": 30}])
    assert out["values"] == {"title": "Buy milk"} and out["eval_count"] == 8, (closing, out)
    assert text.endswith('{"title": "Buy milk'), text  # the model's closing token is never fed back

# A line break, a backslash, a quote opening inside, or a special token is never written, even as the model's first choice.
for banned in ["\n", "\\", ' "', "<eos>"]:
    def script(text, banned=banned):
        d = after(text, '"title": "')
        if d is None: return " "
        return {banned: 9.0, "o": 5.0} if d == "" else {banned: 9.0, "k": 5.0} if d == "o" else '"'
    out, _, _ = run(script, [{"name": "title", "text": 30}])
    assert out["values"] == {"title": "ok"}, (banned, out)

# The length limit holds when the model never closes.
out, _, _ = run(lambda text: "a", [{"name": "title", "text": 5}])
assert out["values"] == {"title": "aaaaa"} and out["eval_count"] == 5, out

# A field asked only when an earlier answer calls for it; the ones that are asked follow each other as one JSON object.
fields = [{"name": "action", "choices": ["answer", "remind"]},
          {"name": "title", "text": 20, "when": {"action": ["remind"]}},
          {"name": "about", "text": 20, "when": {"action": ["answer"]}},
          {"name": "sure", "choices": ["yes", "no"]}]
out, text, _ = run(continuing({"action": "remind", "title": "Call Tea", "sure": "yes"}), fields)
assert out["values"] == {"action": "remind", "title": "Call Tea", "sure": "yes"}, out
assert text.endswith('{"action": "remind", "title": "Call Tea", "sure": "yes'), text
out, text, _ = run(continuing({"action": "answer", "about": "", "sure": "no"}), fields)
assert out["values"] == {"action": "answer", "about": "", "sure": "no"}, out

# Requests that aren't a form are refused before the model is touched.
for bad in [None, [], [{"name": "a"}], [{"name": "A", "text": 5}], [{"name": "a", "choices": ["x"]}], [{"name": "a", "choices": ["x", "x"]}],
            [{"name": "a", "choices": ["x", 'y"']}], [{"name": "a", "choices": ["x", "y\n"]}], [{"name": "a", "text": 0}], [{"name": "a", "text": 500}],
            [{"name": "a", "text": True}], [{"name": "a", "text": 5}, {"name": "a", "text": 5}], [{"name": "a", "text": 5, "when": {"b": ["x"]}}],
            [{"name": "a", "text": 5, "when": {}}], [{"name": f"f{i}", "text": 5} for i in range(13)]]:
    try:
        form.check(bad)
    except ValueError:
        continue
    raise AssertionError(f"accepted {bad!r}")

print("ok")
