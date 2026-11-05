"""The text half of Google's EmbeddingGemma 2 (Apache 2.0), which turns a message into a 768-number fingerprint of what it
means, so search finds "the chat about poster sizes" without the words matching. Only the text encoder: the model also
reads images and audio, but those weights are never loaded (prepare() saves the text part on its own).

The model code is from mlx-vlm (github.com/Blaizzy/mlx-vlm, MIT, mlx_vlm/models/embedding_gemma2/language.py at
3d87e88), where its MLX support lives only on a development branch; trimmed to text and to what Kier needs."""
import json, os
import mlx.core as mx
import mlx.nn as nn
from tokenizers import Tokenizer

# The model's own task prefixes (config_sentence_transformers.json).
QUERY = 'task: search result | query: '
DOCUMENT = 'title: none | text: '
# Matryoshka: the first 256 of the 768 numbers keep most of the meaning at a third of the size.
DIMS = 256


class Config:
    def __init__(self, d):
        self.vocab_size = d.get('vocab_size', 262144)
        self.hidden_size = d.get('hidden_size', 512)
        self.intermediate_size = d.get('intermediate_size', 2048)
        self.num_hidden_layers = d.get('num_hidden_layers', 24)
        self.num_attention_heads = d.get('num_attention_heads', 4)
        self.num_key_value_heads = d.get('num_key_value_heads', 2)
        self.head_dim = d.get('head_dim', 256)
        self.hidden_size_per_layer_input = d.get('hidden_size_per_layer_input', 512)
        self.embedding_dim = d.get('embedding_dim', 768)
        self.rms_norm_eps = d.get('rms_norm_eps', 1e-6)
        self.sliding_window = d.get('sliding_window', 512)
        self.attention_bias = d.get('attention_bias', False)
        self.pad_token_id = d.get('pad_token_id', 0)
        types = d.get('layer_types') or ['full_attention' if (i + 1) % 6 == 0 else 'sliding_attention' for i in range(self.num_hidden_layers)]
        types = list(types)
        types[-1] = 'full_attention'
        self.layer_types = types
        per = d.get('per_layer_config') or {f'{i:02d}': {'head_dim': 512, 'num_key_value_heads': 1} for i, t in enumerate(types) if t == 'full_attention'}
        self.per_layer_config = {f'{int(i):02d}': v for i, v in per.items()}
        self.rope_parameters = d.get('rope_parameters') or {
            'full_attention': {'rope_theta': 1_000_000.0}, 'sliding_attention': {'rope_theta': 10_000.0}}


class RotaryEmbedding(nn.Module):
    def __init__(self, dims, base):
        super().__init__()
        self._frequencies = 1.0 / (base ** (mx.arange(0, dims, 2, dtype=mx.float32) / dims))

    def __call__(self, x, position_ids):
        angles = position_ids.astype(mx.float32)[..., None] * self._frequencies
        angles = mx.concatenate([angles, angles], axis=-1)[:, None]
        cos, sin = mx.cos(angles).astype(x.dtype), mx.sin(angles).astype(x.dtype)
        half = x.shape[-1] // 2
        return x * cos + mx.concatenate([-x[..., half:], x[..., :half]], axis=-1) * sin


class RMSNormNoScale(nn.Module):
    def __init__(self, dim, eps=1e-6):
        super().__init__()
        self.eps = eps

    def __call__(self, x):
        return mx.fast.rms_norm(x, None, self.eps)


class Attention(nn.Module):
    def __init__(self, c, i):
        super().__init__()
        o = c.per_layer_config.get(f'{i:02d}', {})
        self.head_dim = o.get('head_dim', c.head_dim)
        self.num_heads = o.get('num_attention_heads', c.num_attention_heads)
        self.num_kv_heads = o.get('num_key_value_heads', c.num_key_value_heads)
        self.q_proj = nn.Linear(c.hidden_size, self.num_heads * self.head_dim, bias=c.attention_bias)
        self.k_proj = nn.Linear(c.hidden_size, self.num_kv_heads * self.head_dim, bias=c.attention_bias)
        self.v_proj = nn.Linear(c.hidden_size, self.num_kv_heads * self.head_dim, bias=c.attention_bias)
        self.o_proj = nn.Linear(self.num_heads * self.head_dim, c.hidden_size, bias=c.attention_bias)
        self.q_norm = nn.RMSNorm(self.head_dim, eps=c.rms_norm_eps)
        self.k_norm = nn.RMSNorm(self.head_dim, eps=c.rms_norm_eps)
        self.v_norm = RMSNormNoScale(self.head_dim, eps=c.rms_norm_eps)
        self.rope = RotaryEmbedding(self.head_dim, base=c.rope_parameters[c.layer_types[i]]['rope_theta'])

    def __call__(self, x, mask, position_ids):
        b, n, _ = x.shape
        q = self.q_norm(self.q_proj(x).reshape(b, n, self.num_heads, -1))
        k = self.k_norm(self.k_proj(x).reshape(b, n, self.num_kv_heads, -1))
        v = self.v_norm(self.v_proj(x).reshape(b, n, self.num_kv_heads, -1))
        q = self.rope(q.transpose(0, 2, 1, 3), position_ids)
        k = self.rope(k.transpose(0, 2, 1, 3), position_ids)
        out = mx.fast.scaled_dot_product_attention(q, k, v.transpose(0, 2, 1, 3), scale=1.0, mask=mask)
        return self.o_proj(out.transpose(0, 2, 1, 3).reshape(b, n, -1))


class MLP(nn.Module):
    def __init__(self, c):
        super().__init__()
        self.gate_proj = nn.Linear(c.hidden_size, c.intermediate_size, bias=False)
        self.up_proj = nn.Linear(c.hidden_size, c.intermediate_size, bias=False)
        self.down_proj = nn.Linear(c.intermediate_size, c.hidden_size, bias=False)

    def __call__(self, x):
        return self.down_proj(nn.gelu_approx(self.gate_proj(x)) * self.up_proj(x))


class PerLayerInputs(nn.Module):
    def __init__(self, c):
        super().__init__()
        self.num_layers, self.width, self.scale = c.num_hidden_layers, c.hidden_size_per_layer_input, c.hidden_size ** -0.5
        self.per_layer_model_projection = nn.Linear(c.hidden_size, self.num_layers * self.width, bias=False)
        self.per_layer_projection_norm = nn.RMSNorm(self.width, eps=c.rms_norm_eps)

    def __call__(self, x):
        p = (self.per_layer_model_projection(x) * self.scale).reshape(*x.shape[:-1], self.num_layers, self.width)
        return self.per_layer_projection_norm(p)


class PerLayerBlock(nn.Module):
    def __init__(self, c):
        super().__init__()
        self.per_layer_input_gate = nn.Linear(c.hidden_size, c.hidden_size_per_layer_input, bias=False)
        self.per_layer_projection = nn.Linear(c.hidden_size_per_layer_input, c.hidden_size, bias=False)
        self.post_per_layer_input_norm = nn.RMSNorm(c.hidden_size, eps=c.rms_norm_eps)

    def __call__(self, x, per_layer_input):
        gate = nn.gelu_approx(self.per_layer_input_gate(x)) * per_layer_input
        return x + self.post_per_layer_input_norm(self.per_layer_projection(gate))


class EncoderLayer(nn.Module):
    def __init__(self, c, i):
        super().__init__()
        self.self_attn = Attention(c, i)
        self.mlp = MLP(c)
        self.input_layernorm = nn.RMSNorm(c.hidden_size, eps=c.rms_norm_eps)
        self.post_attention_layernorm = nn.RMSNorm(c.hidden_size, eps=c.rms_norm_eps)
        self.pre_feedforward_layernorm = nn.RMSNorm(c.hidden_size, eps=c.rms_norm_eps)
        self.post_feedforward_layernorm = nn.RMSNorm(c.hidden_size, eps=c.rms_norm_eps)
        self.ple_block = PerLayerBlock(c) if c.hidden_size_per_layer_input else None
        self.layer_scalar = mx.ones((1,))

    def __call__(self, x, mask, position_ids, per_layer_input=None):
        x = x + self.post_attention_layernorm(self.self_attn(self.input_layernorm(x), mask, position_ids))
        x = x + self.post_feedforward_layernorm(self.mlp(self.pre_feedforward_layernorm(x)))
        if self.ple_block is not None:
            x = self.ple_block(x, per_layer_input)
        return x * self.layer_scalar


class TextModel(nn.Module):
    def __init__(self, c):
        super().__init__()
        self.config = c
        self.embed_tokens = nn.Embedding(c.vocab_size, c.hidden_size)
        self.ple = PerLayerInputs(c) if c.hidden_size_per_layer_input else None
        self.layers = [EncoderLayer(c, i) for i in range(c.num_hidden_layers)]
        self.norm = nn.RMSNorm(c.hidden_size, eps=c.rms_norm_eps)
        self.embedding_projection = nn.Linear(c.hidden_size, c.embedding_dim, bias=False)

    def __call__(self, ids, attention_mask):
        c = self.config
        x = self.embed_tokens(ids)
        x = x * mx.array(c.hidden_size ** 0.5, dtype=x.dtype)
        n = x.shape[1]
        full = attention_mask[:, None, None, :].astype(mx.bool_)
        pos = mx.arange(n)
        sliding = full & (mx.abs(pos[:, None] - pos[None, :]) <= c.sliding_window)
        per_layer = self.ple(x) if self.ple is not None else None
        h = x
        for i, layer in enumerate(self.layers):
            h = layer(h, sliding if c.layer_types[i] == 'sliding_attention' else full, pos[None], None if per_layer is None else per_layer[:, :, i])
        h = self.embedding_projection(self.norm(h))
        # Mean over the real tokens, then unit length.
        m = attention_mask[..., None].astype(mx.float32)
        pooled = (h * m).sum(axis=1) / mx.maximum(m.sum(axis=1), 1e-9)
        return pooled / mx.linalg.norm(pooled, axis=-1, keepdims=True)


def prepare(downloaded, out):
    """From the downloaded model (text, image and audio encoders, 1.1 GB), keep only what text needs, in `out`."""
    os.makedirs(out, exist_ok=True)
    config = json.load(open(os.path.join(downloaded, 'config.json')))
    weights = mx.load(os.path.join(downloaded, 'model.safetensors'))
    text = {k[len('language_model.'):]: v for k, v in weights.items() if k.startswith('language_model.')}
    mx.save_safetensors(os.path.join(out, 'text.safetensors'), text)
    json.dump({'text_config': config['text_config'], 'quantization': config.get('quantization')}, open(os.path.join(out, 'config.json'), 'w'))
    with open(os.path.join(downloaded, 'tokenizer.json'), 'rb') as src, open(os.path.join(out, 'tokenizer.json'), 'wb') as dst:
        dst.write(src.read())


class Embedder:
    def __init__(self, path):
        config = json.load(open(os.path.join(path, 'config.json')))
        self.model = TextModel(Config(config['text_config']))
        weights = mx.load(os.path.join(path, 'text.safetensors'))
        q = config.get('quantization')
        if q:
            nn.quantize(self.model, group_size=q['group_size'], bits=q['bits'], mode=q.get('mode', 'affine'),
                        class_predicate=lambda p, m: hasattr(m, 'to_quantized') and f'{p}.scales' in weights)
        self.model.load_weights(list(weights.items()))
        mx.eval(self.model.parameters())
        self.tokenizer = Tokenizer.from_file(os.path.join(path, 'tokenizer.json'))
        self.tokenizer.enable_truncation(256)
        self.tokenizer.enable_padding(pad_id=self.model.config.pad_token_id)

    def __call__(self, texts, query=False, dims=DIMS):
        """Unit-length fingerprints, `dims` numbers each, for questions (query=True) or for messages."""
        out = []
        prefix = QUERY if query else DOCUMENT
        for i in range(0, len(texts), 16):
            enc = self.tokenizer.encode_batch([prefix + t for t in texts[i:i + 16]])
            ids = mx.array([e.ids for e in enc])
            mask = mx.array([e.attention_mask for e in enc])
            e = self.model(ids, mask)[:, :dims]
            e = e / mx.linalg.norm(e, axis=-1, keepdims=True)
            mx.eval(e)
            out.extend(e.astype(mx.float32).tolist())
        return out
