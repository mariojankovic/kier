"""Filling in a form instead of writing free text: the model's answer is a JSON object whose shape Kier fixes.
The braces, field names and quotes are put there by Kier, never asked of the model. A choice field can only come out
as one of its listed options, and comes with how likely the model held each one, so the daemon can ask instead of
guess when two are close. A text field is the model's own words up to the closing quote, on one line, within a
length limit. Nothing here can be malformed, and nothing needs fishing out of a reply afterwards.

fill() is given a model that has read the prompt up to its last token; llm_server.py does the reading and the
caching, the same way it does for chat."""
import json
import re

import mlx.core as mx

NAME = re.compile(r"[a-z][a-z0-9_]{0,23}")
MAX_FIELDS, MAX_CHOICES, MAX_CHOICE_CHARS, MAX_TEXT_TOKENS = 12, 40, 80, 120

_masks = {}


def check(fields):
    """The fields as fill() takes them, or ValueError saying what is wrong with the request."""
    if not isinstance(fields, list) or not 1 <= len(fields) <= MAX_FIELDS:
        raise ValueError("fields")
    seen, out = set(), []
    for f in fields:
        if not isinstance(f, dict) or not isinstance(f.get("name"), str) or not NAME.fullmatch(f["name"]) or f["name"] in seen:
            raise ValueError("field name")
        field = {"name": f["name"]}
        if "choices" in f:
            c = f["choices"]
            if (not isinstance(c, list) or not 2 <= len(c) <= MAX_CHOICES or len(set(c)) != len(c)
                    or not all(isinstance(x, str) and 0 < len(x) <= MAX_CHOICE_CHARS and not re.search(r'["\\\n\r]', x) for x in c)):
                raise ValueError("choices")
            field["choices"] = c
        elif isinstance(f.get("text"), int) and not isinstance(f["text"], bool) and 1 <= f["text"] <= MAX_TEXT_TOKENS:
            field["text"] = f["text"]
        else:
            raise ValueError("field kind")
        # Only asked when earlier answers call for it: {"action": ["rename", "remind"]}.
        when = f.get("when")
        if when is not None:
            if (not isinstance(when, dict) or not when or not all(k in seen and isinstance(v, list) and v
                                                                   and all(isinstance(x, str) for x in v) for k, v in when.items())):
                raise ValueError("when")
            field["when"] = when
        seen.add(f["name"])
        out.append(field)
    return out


def masks(tokenizer, size):
    """Which tokens end a text value (they start with the closing quote), and which may not appear inside one:
    a quote further in, a backslash, a line break, anything special, anything past the vocabulary."""
    key = (id(tokenizer), size)
    if key not in _masks:
        inner = getattr(tokenizer, "_tokenizer", tokenizer)
        pieces = inner.convert_ids_to_tokens(list(range(len(inner))))
        close, banned = [], set(inner.all_special_ids) | set(range(len(pieces), size))
        for i, s in enumerate(pieces):
            if s is None or i >= size:
                banned.add(i)
            elif s.startswith('"'):
                close.append(i)
            # Byte-level vocabularies write a line feed as Ċ and a carriage return as č; real letters never
            # appear as those two.
            elif '"' in s or "\\" in s or "Ċ" in s or "č" in s or "\n" in s or "\r" in s:
                banned.add(i)
        barred = mx.zeros((size,))
        barred[mx.array(sorted(banned | set(close)))] = -float("inf")
        # Worked out now, by the request that made it: it is kept for every later one.
        mx.eval(barred)
        _masks.clear()
        _masks[key] = (mx.array(close), barred)
    return _masks[key]


class Reading:
    """A model part-way through its answer: what it has read, and what it expects next."""

    def __init__(self, model, cache, copy_cache, logits=None):
        self.model, self.cache, self.copy_cache, self.logits = model, cache, copy_cache, logits

    def feed(self, tokens):
        # Half precision is too coarse to add probabilities up in.
        self.logits = self.model(mx.array(tokens)[None], cache=self.cache)[0, -1, :].astype(mx.float32)
        mx.eval(self.logits)
        return self

    def fork(self):
        return Reading(self.model, self.copy_cache(self.cache), self.copy_cache, self.logits)

    def logprobs(self):
        return self.logits - mx.logsumexp(self.logits)


END = -1


def spread(reading, options, close, depth=0):
    """How likely each option is, as {index: probability} over `options` (index, tokens), all of which share their
    first `depth` tokens, already read. Also how much of everything the model might have said next was a start of
    one of them: low means it wanted to say something the form doesn't offer."""
    groups = {}
    for i, tokens in options:
        groups.setdefault(tokens[depth] if depth < len(tokens) else END, []).append((i, tokens))
    lp = reading.logprobs()
    keys = list(groups)
    # An option that ends here is followed by the closing quote, however that is spelled.
    scores = mx.stack([mx.logsumexp(lp[close]) if k == END else lp[k] for k in keys])
    share = mx.softmax(scores).tolist()
    mass = float(mx.exp(mx.logsumexp(scores)).item())
    out = {}
    for k, p in zip(keys, share):
        members = groups[k]
        if len(members) == 1:
            out[members[0][0]] = p
            continue
        # Options that begin alike ("1" and "12") are told apart one token further in, on a copy.
        inner, _ = spread(reading.fork().feed([k]), members, close, depth + 1)
        for i, q in inner.items():
            out[i] = p * q
    return out, mass


def write(reading, limit, close, barred):
    """The model's own words for a text value, greedily, until it would close the quote."""
    out = []
    while len(out) < limit:
        p = mx.softmax(reading.logits)
        token = int(mx.argmax(reading.logits + barred).item())
        # The closing quote has several spellings ('"', '",', '"}'); together they count as one choice.
        if float(p[close].sum().item()) >= float(p[token].item()):
            break
        out.append(token)
        reading.feed([token])
    return out


def fill(model, tokenizer, cache, last, fields, copy_cache, give_way=lambda: None):
    """`cache` holds the prompt but for its last token `last`. Returns the values, and for each choice field the
    probability of every option and how much of the model's expectation the options covered."""
    reading = Reading(model, cache, copy_cache).feed([last])
    encode = lambda s: tokenizer.encode(s, add_special_tokens=False)
    close, barred = masks(tokenizer, reading.logits.shape[-1])
    values, confidence, written, opened = {}, {}, 0, False
    for f in fields:
        if any(values.get(k) not in v for k, v in (f.get("when") or {}).items()):
            continue
        give_way()
        # The value's opening quote belongs to this lead, and the one before it is closed here too.
        reading.feed(encode(('", ' if opened else "{") + json.dumps(f["name"]) + ': "'))
        opened = True
        if "choices" in f:
            options = [(i, encode(c)) for i, c in enumerate(f["choices"])]
            if not all(tokens for _, tokens in options):
                raise ValueError("choices")
            probs, mass = spread(reading, options, close)
            best = max(probs, key=probs.get)
            reading.feed(options[best][1])
            values[f["name"]] = f["choices"][best]
            confidence[f["name"]] = {"options": {f["choices"][i]: round(p, 4) for i, p in probs.items()}, "covered": round(mass, 4)}
        else:
            tokens = write(reading, f["text"], close, barred)
            written += len(tokens)
            values[f["name"]] = tokenizer.decode(tokens).strip()
    return {"values": values, "confidence": confidence, "eval_count": written}
