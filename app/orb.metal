// Sol's Sealed Sun artwork, sampled from orb.png, with the island's live light and attention effects.
// The sky, sea and outline stay procedural; the ball and its embossed star come from the original image.
#include <metal_stdlib>
#include <SwiftUI/SwiftUI_Metal.h>
using namespace metal;

// Kier's world: a pastel sky over a calm sea, the backdrop of its island and what its chrome reflects, so the glass
// belongs to the place. y is elevation (+1 straight up, 0 the horizon, -1 straight down), x runs along the horizon.
// dusk, twilight and night (0 to 1) turn it to golden hour, a purple twilight and night with getkier.com's own tints
// (Appearance in Setup).
static float3 world(float y, float x, float t, float dusk, float twilight, float night) {
  float3 skyHigh = float3(0.66, 0.73, 0.95);
  float3 skyLow = float3(0.87, 0.83, 0.95);
  float3 glow = float3(1.0, 0.87, 0.80);
  float3 seaNear = float3(0.93, 0.88, 0.92);
  float3 seaMid = float3(0.74, 0.79, 0.95);
  float3 seaDeep = float3(0.50, 0.56, 0.80);
  float3 c;
  if (y >= 0.0) {
    c = mix(glow, skyLow, smoothstep(0.0, 0.22, y));
    c = mix(c, skyHigh, smoothstep(0.22, 0.95, y));
    // Soft clouds drifting along the upper sky.
    float cloud = smoothstep(0.35, 0.95, sin(x * 3.1 + t * 0.05) * sin(x * 7.3 - t * 0.04 + y * 9.0) + 0.35 * sin(x * 13.0 + y * 4.0))
      * smoothstep(0.08, 0.3, y) * (1.0 - smoothstep(0.7, 0.95, y));
    c = mix(c, float3(1.0, 0.97, 0.97), cloud * 0.55);
  } else {
    float d = -y;
    c = mix(seaNear, seaMid, smoothstep(0.0, 0.3, d));
    c = mix(c, seaDeep, smoothstep(0.3, 1.0, d));
    // Gentle bands of light on a calm sea, brightest near the horizon; low frequency, so they never shimmer into noise.
    float wave = (0.5 + 0.5 * sin(d * 22.0 - t * 0.5 + sin(x * 1.3 + t * 0.1) * 1.2)) * (1.0 - smoothstep(0.0, 0.4, d));
    c += wave * float3(1.0, 0.96, 0.94) * 0.07;
  }
  c = mix(c, c * float3(1.0, 0.84, 0.78), dusk * (1.0 - night));
  c = mix(c, c * float3(0.62, 0.44, 0.56), twilight);
  return mix(c, c * float3(0.17, 0.19, 0.33) + float3(0.012, 0.016, 0.045), night);
}

static float hash(float2 p) { return fract(sin(dot(p, float2(127.1, 311.7))) * 43758.5453); }

// Stars over the night sky, a little denser higher up, gently twinkling; the first faint ones at twilight.
static float3 stars(float y, float x, float t, float twilight, float night) {
  float3 c = float3(0.0);
  float starry = max(night, twilight * 0.35);
  if (starry < 0.01 || y < 0.01) return c;
  for (int i = 0; i < 2; i++) {
    float k = i == 0 ? 14.0 : 26.0;
    float2 sp = float2(x, y) * k;
    float2 cell = floor(sp);
    float h = hash(cell + float(i) * 37.0);
    float lit = step(i == 0 ? 0.93 : 0.96, h);
    float2 off = float2(hash(cell + 3.1), hash(cell + 7.7)) * 0.6 + 0.2;
    float dot0 = smoothstep(0.09, 0.0, length(fract(sp) - off));
    float tw = 0.65 + 0.35 * sin(t * (1.5 + h * 3.0) + h * 40.0);
    c += float3(0.88, 0.91, 1.0) * lit * dot0 * tw * starry * smoothstep(0.02, 0.18, y) * (i == 0 ? 0.9 : 0.55);
  }
  return c;
}

// The island's backdrop: the world seen head on, horizon a little below the middle.
static float3 sky_pixel(float2 position, float2 size, float time, float dusk, float twilight, float night) {
  float2 uv = position / size;
  float y = (0.56 - uv.y) * 2.2;
  float x = (uv.x - 0.5) * 2.4 + time * 0.01;
  return world(y, x, time, dusk, twilight, night) + stars(y, x, time, twilight, night);
}

// Image grading and light overlays use the same palette as the island.
static float sq(float x) { return x * x; }

// The same ordered appearance operations as world(), with day an identity.
static float3 world_tint(float3 c, float dusk, float twilight, float night) {
  c = mix(c, c * float3(1.0, 0.84, 0.78), dusk * (1.0 - night));
  c = mix(c, c * float3(0.62, 0.44, 0.56), twilight);
  return mix(c, c * float3(0.17, 0.19, 0.33) + float3(0.012, 0.016, 0.045), night);
}

static float3 icon_glow(float2 p, float px, float t) {
  float2 sp = p - float2(-0.008, 0.055);
  float rr = dot(sp, sp);
  // The star twinkles: every few seconds its light reaches out along the blades and across the chrome, and the halo
  // swells, then settles. The heart is white either way, so the reach is what you see move.
  float shine = smoothstep(0.0, 1.0, 0.5 + 0.5 * sin(t * 1.7));
  float core = exp(-rr / sq(0.024 + 0.008 * shine)) * 0.80;
  float bloom = exp(-rr / sq(0.12 + 0.03 * shine)) * (0.14 + 0.14 * shine) + exp(-rr / sq(0.29)) * (0.18 + 0.12 * shine);
  float x = abs(sp.x), y = abs(sp.y);
  float rays = (exp(-sq(x / 0.012)) * exp(-y / (0.16 + 0.34 * shine)) + exp(-sq(y / 0.010)) * exp(-x / (0.17 + 0.36 * shine)))
               * (0.08 + 0.22 * shine);
  return (core + bloom + rays) * float3(1.0, 0.91, 0.76);
}

// Light follows the eight embossed blades. The cutout still owns the edge, even when the points wake.
static float hover_blades(float2 p, float px, float extension, float age) {
  float2 s = p - float2(-0.008, 0.055);
  float r = length(s), sector = 0.78539816;
  float turn = atan2(s.y, s.x) / sector;
  float off = abs(fract(turn + 0.5) - 0.5) * sector;
  int axis = int(round(turn + 8.0)) % 8;
  bool diagonal = axis % 2 == 1;
  float reach = (diagonal ? 0.42 : axis == 6 ? 0.5 : 0.85)
              + extension * (diagonal ? 0.14 : axis == 6 ? 0.09 : 0.07);
  float width = (diagonal ? 0.022 : 0.032) * (1.0 - smoothstep(0.0, reach, r) * 0.85);
  float across = r * sin(off);
  float taper = 1.0 - smoothstep(reach * 0.62, reach, r);
  float ray = exp(-sq(across / (width + px * 0.24))) * taper;
  float bloom = exp(-sq(across / (width * 2.0 + px * 0.8))) * taper * 0.19;
  float twinkle = 0.91 + 0.09 * sin(age * 2.0 + float(axis) * 0.7);
  return (ray + bloom) * smoothstep(0.09, 0.20, r) * twinkle;
}

// The orb in a box of `size` points, premultiplied, as the island's layer draws it (kierIsland). Kier's windows show the
// white mark instead (KierMark in Orb.swift).
static float4 orb_pixel(float2 position, float2 size, float time, float2 mouse, float attention,
                        float dusk, float twilight, float night, float working, float pixelScale,
                        float4 hover, texture2d<float> artwork) {
  float side = min(size.x, size.y);
  float radius = side * 0.39 * (1.0 + 0.012 * sin(time * 1.3));
  float2 p = (position - size * 0.5) / radius;
  // The PNG's first row is its top. Light coordinates keep positive y pointing up.
  float2 uv = p * 0.5 + 0.5;
  p.y = -p.y;
  if (any(uv < 0.0) || any(uv > 1.0)) return float4(0.0);
  constexpr sampler imageSampler(coord::normalized, address::clamp_to_zero, filter::linear, mip_filter::linear);
  // Explicit LOD stays stable at the island's clipped edge, where neighboring fragments may skip this function.
  float lod = max(0.0, log2(float(artwork.get_width()) / (2.0 * radius * pixelScale)));
  float4 image = artwork.sample(imageSampler, uv, level(lod));
  if (image.a <= 0.0) return float4(0.0);
  int variant = int(hover.x);
  float amount = clamp(hover.y, 0.0, 1.0), age = max(hover.z, 0.0), press = clamp(hover.w, 0.0, 1.0);
  float2 pointer = clamp(mouse * 7.0, -1.0, 1.0);
  float2 artP = p;
  // How far the ball is turned, for the reflection that dresses its edge while it turns.
  float turned = 0.0;
  // Pearl rim (4, shipped) also tilts, a little harder than the tilt prototype alone.
  bool tilts = variant == 2 || variant == 4;
  float lean = variant == 4 ? 1.6 : 1.0;
  if (variant == 4 && amount > 0.0) {
    // Rotate the painted sphere with the pointer so details compress toward its edge.
    // Fade the turn near the stationary chrome rim to avoid stretching the artwork.
    float2 roll = pointer * amount * 0.32 * (1.0 - smoothstep(0.80, 0.985, length(p)));
    turned = length(pointer * amount * 0.32);
    float3 v = float3(p, sqrt(max(0.0, 1.0 - dot(p, p))));
    v = float3(v.x * cos(roll.x) - v.z * sin(roll.x), v.y, v.x * sin(roll.x) + v.z * cos(roll.x));
    v = float3(v.x, v.y * cos(roll.y) - v.z * sin(roll.y), v.y * sin(roll.y) + v.z * cos(roll.y));
    // Past the limb there is no painting to show; hold its edge.
    artP = v.z >= 0.0 ? v.xy : normalize(v.xy) * 0.995;
    float4 rolled = artwork.sample(imageSampler, artP * float2(0.5, -0.5) + 0.5, level(lod));
    image.rgb = rolled.rgb / max(rolled.a, 0.0001) * image.a;
  } else if (tilts && amount > 0.0) {
    // A shallow spherical tilt: the reflection travels farther than the raised silver relief.
    // One warped sample avoids a doubled star. The original alpha keeps every edge pixel unchanged.
    float2 s = p - float2(-0.008, 0.055);
    float sr = length(s), sector = 0.78539816;
    float turn = atan2(s.y, s.x) / sector;
    float across = sr * sin(abs(fract(turn + 0.5) - 0.5) * sector);
    int axis = int(round(turn + 8.0)) % 8;
    float reach = axis % 2 == 1 ? 0.47 : axis == 6 ? 0.55 : 0.90;
    float relief = (1.0 - smoothstep(0.025, 0.11, across)) * (1.0 - smoothstep(reach * 0.7, reach, sr));
    relief = max(relief, 1.0 - smoothstep(0.12, 0.24, sr));
    float anchor = sq(max(0.0, 1.0 - dot(p, p)));
    artP -= pointer * mix(0.045, 0.014, relief) * anchor * amount * lean;
    float4 tilted = artwork.sample(imageSampler, artP * float2(0.5, -0.5) + 0.5, level(lod));
    image.rgb = tilted.rgb / max(tilted.a, 0.0001) * image.a;
  }
  float r = length(p), px = 1.0 / radius;
  float z = sqrt(max(0.0, 1.0 - r * r));
  float3 n = float3(p, z);
  // Mips contain premultiplied color, so transparent padding cannot bleed a dark fringe into the rim.
  float3 raw = image.rgb / max(image.a, 0.0001);
  float3 c = world_tint(raw, dusk, twilight, night);
  // The grade darkens everything alike, so at twilight and night the silver star sank into the dark ball. Its
  // bright, neutral metal keeps a cool moonlit light instead; the bluish painted sky reflection still goes dark.
  float lum = dot(raw, float3(0.2126, 0.7152, 0.0722));
  float neutral = 1.0 - smoothstep(0.04, 0.16, raw.b - raw.r);
  // Only on the star's eight points (centered as icon_glow), so the painted sea along the bottom stays dark.
  float2 sp = artP - float2(-0.008, 0.055);
  float sr = length(sp);
  float sector = 0.78539816;
  float turn = atan2(sp.y, sp.x) / sector;
  float off = abs(fract(turn + 0.5) - 0.5) * sector;
  // The four long points reach the rim; the diagonals are short and thin, and stop before the painted sea.
  int axis = int(round(turn + 8.0)) % 8;
  bool diagonal = axis % 2 == 1;
  // The lower point crosses the painted sea, so it stops where the water starts.
  float reach = diagonal ? 0.42 : axis == 6 ? 0.5 : 0.85;
  // Tapered like the blades, so a point never ends in a blunt stub.
  float width = (diagonal ? 0.035 : 0.075) * (1.0 - smoothstep(0.0, reach, sr) * 0.85);
  float blade = (1.0 - smoothstep(width * 0.4, width, sr * sin(off))) * (1.0 - smoothstep(reach * 0.6, reach, sr));
  float points = max(blade, 1.0 - smoothstep(0.10, 0.18, sr));
  float metal = smoothstep(0.42, 0.85, lum) * neutral * points;
  float low = clamp(night + twilight * 0.7, 0.0, 1.0);
  float3 moonlit = raw * mix(float3(0.80, 0.70, 0.78), float3(0.60, 0.66, 0.84), night);
  c = mix(c, max(c, moonlit), metal * low);
  if (variant == 3 && amount > 0.0) {
    // Let the relief read without reducing the existing moonlit star or the later status lights.
    c *= 1.0 - 0.10 * amount * (1.0 - points);
  }
  float3 reflected = 2.0 * n.z * n - float3(0, 0, 1);
  // Keep Sol's painted reflection and relief. Only the sky's movement is added, with no replacement sphere or star.
  float3 drift = world(reflected.y, reflected.x, time, dusk, twilight, night)
               - world(reflected.y, reflected.x, 0.0, dusk, twilight, night);
  c += drift * 0.18;
  // While it turns, the rim mirrors the island's live sky, brightest at grazing angles as on real chrome. The sky moves
  // with the pointer a little, so the edge reads as a reflection rather than paint.
  if (turned > 0.0) {
    float3 bent = normalize(reflected + float3(clamp(mouse * 7.0, -1.0, 1.0) * 0.25, 0.0));
    float3 sky = world(bent.y, bent.x, time, dusk, twilight, night);
    float fres = pow(1.0 - z, 2.2) * smoothstep(0.55, 0.95, r);
    c = mix(c, sky * 1.05 + 0.04, clamp(fres * smoothstep(0.0, 0.12, turned) * 0.75, 0.0, 1.0));
  }
  float2 m = clamp(mouse, -1.0, 1.0);
  float3 light = normalize(float3(-0.30 + m.x * 0.04, 0.32 + m.y * 0.04, -0.90));
  float3 reflectedLight = -light + 2.0 * dot(light, n) * n;
  c += pow(max(reflectedLight.z, 0.0), 110.0) * 0.25 * float3(1.0, 0.87, 0.73);
  // The artwork already has a bright star by day. Keep the original luminous twinkle as the image darkens at night.
  c += icon_glow(artP, px, time) * mix(0.28, 1.0, max(twilight, night));
  // Thinking sweeps light over the original relief, leaving the artwork's orientation and silhouette intact.
  float sweepAt = sin(time * 2.2) * 0.95;
  float sweep = exp(-sq((p.x + p.y * 0.28 - sweepAt) / 0.16)) * (0.35 + 0.65 * z);
  c += world_tint(float3(0.30, 0.35, 0.42), dusk, twilight, night) * sweep * working;
  // A faint rainbow where the chrome turns away, like oil on metal, always slowly shifting: the edge light the orb
  // had before the icon's look came in, softer so the polished reflection still leads.
  float fres = pow(1.0 - z, 3.0);
  float3 irid = 0.5 + 0.5 * cos(6.2831 * (fres * 1.3 + float3(0.0, 0.33, 0.67)) + time * 0.2);
  c = mix(c, c * 0.75 + irid * 0.32, fres * 0.28);

  if (variant > 0 && amount > 0.0) {
    // Warm silver by day, cooler pearl at night. These are light overlays on Sol's original painting.
    float3 pearl = mix(float3(1.0, 0.94, 0.84), float3(0.78, 0.87, 1.0), max(twilight * 0.55, night));
    if (variant == 1) {
      // One pass on entry, then a brief response from the blades. No repeating hover sweep.
      float at = mix(-1.25, 1.25, smoothstep(0.0, 0.46, age));
      float sweepGate = smoothstep(0.0, 0.055, age) * (1.0 - smoothstep(0.35, 0.48, age));
      float line = p.x + p.y * 0.30 + p.y * p.y * 0.22 - at;
      float shimmer = exp(-sq(line / 0.070)) + exp(-sq(line / 0.16)) * 0.15;
      c += pearl * shimmer * sweepGate * amount * (0.15 + 0.33 * z) * (1.0 - 0.60 * working);
      float flare = smoothstep(0.25, 0.36, age) * (1.0 - smoothstep(0.38, 0.73, age));
      c += pearl * hover_blades(artP, px, 0.45, age) * flare * amount * 0.34;
    }
    if (variant == 4) {
      // The light stays where it is while the ball rolls under it, and the limb deepens a touch, so it reads round.
      c *= 1.0 - 0.16 * amount * smoothstep(0.55, 1.0, r);
      float3 key = normalize(float3(-0.36, 0.48, 1.0));
      c += pearl * pow(max(0.0, dot(n, key)), 90.0) * amount * 0.30;
    } else if (tilts) {
      // The tilt's highlight rides the ball toward the pointer.
      float3 tiltedNormal = normalize(n + float3(pointer * amount * 0.09 * lean, 0.0));
      float3 key = normalize(float3(-0.36 + pointer.x * 0.22 * lean, 0.48 + pointer.y * 0.22 * lean, 1.0));
      float sheen = pow(max(0.0, dot(tiltedNormal, key)), 72.0);
      c += pearl * sheen * amount * 0.22 * lean;
    }
    if (variant == 3) {
      // All eight points breathe slowly, with more reach and a small bloom along the existing metal.
      float breathe = 0.88 + 0.12 * sin(age * 2.0);
      c += pearl * hover_blades(artP, px, amount, age) * amount * breathe * 0.43;
    } else if (variant == 4) {
      // A directional pearl edge rolls into place and follows the hand. No orbit or rainbow cycle.
      float2 direction = normalize(float2(-0.60, 0.80) + pointer * 0.55);
      float facing = dot(p / max(r, 0.0001), direction);
      float arc = pow(max(0.0, facing), 3.0) + 0.20 * pow(max(0.0, -facing), 5.0);
      // A click tightens the edge a touch inward and brightens it, then lets go with the press squash.
      float at = mix(0.88, 0.955, smoothstep(0.0, 0.42, age)) - press * 0.03;
      float rim = exp(-sq((r - at) / (0.018 * (1.0 - press * 0.35) + px * 0.48)));
      float3 edgePearl = mix(float3(0.76, 0.86, 1.0), pearl, facing * 0.5 + 0.5);
      c += edgePearl * rim * mix(arc, max(arc, 0.35), press) * amount * 0.52 * (1.0 + press * 0.9) * (1.0 - min(attention, 1.0) * 0.8);
    }
  }

  // When something needs you: a thin arc of light travels round the rim, tinted like oil on chrome. No halo.
  // attention above 1 means something new just came in: two fast arcs whirl the other way and fade as it settles.
  float calm = min(attention, 1.0);
  float wild = clamp(attention - 1.0, 0.0, 1.5);
  float ang = atan2(p.y, p.x);
  // A long arc, about a third of the way round, and a fainter one opposite it (longer and softer).
  float orbit = pow(max(0.0, cos(ang - time * 1.15)), 7.0) + 0.45 * pow(max(0.0, cos(ang - time * 1.15 + 3.14159)), 12.0);
  float fast = pow(max(0.0, cos(ang + time * 3.7)), 10.0) + pow(max(0.0, cos(ang + time * 2.9 + 2.1)), 14.0);
  float band = smoothstep(0.84, 0.985, r) * smoothstep(1.0 + px, 1.0 - px * 1.5, r);
  float wide = smoothstep(0.78, 0.985, r) * smoothstep(1.0 + px, 1.0 - px * 1.5, r);
  float3 tint = 0.84 + 0.16 * cos(6.2831 * (ang / 6.2831 + float3(0.0, 0.33, 0.67)) + time * 0.6);
  c += tint * (orbit * band * calm * 1.5 + fast * wide * wild * 2.0);

  // The cutout owns the silhouette, including its fine rim and antialiased alpha.
  return float4(clamp(c, 0.0, 1.0) * image.a, image.a);
}

// The whole island, drawn by its own Metal layer on its own thread (Island.swift), so hovering it never waits on the
// app's main thread: the sky inside the island's outline, the green ripple and the orb over it, the hairline round it,
// and the light that runs down a tucked notch's edge while something waits. Everything is in points, as SwiftUI drew it.
struct IslandUniforms {
  float width, height, scale, time;                // the window in points, pixels per point, seconds
  float islandWidth, islandHeight, fillet, radius; // the outline, as IslandShape draws it, right-aligned and centred
  float orbX, orbY, orbScale, orbAlpha;            // where the orb is, how big, and how faded as it tucks away
  float ringX, ringY, ringScale, cheer;            // the ripple when something is done
  float mouseX, mouseY, attention, glow;           // the highlight's lean, the rim light, a breathing notch
  float dusk, twilight, night, edge;               // the hour's light; the light down a tucked notch's edge
  float working, hoverVariant, hoverAmount, hoverAge; // 0 none, 1 shimmer, 2 tilt, 3 star wakes, 4 pearl rim (shipped)
  float press, unused0, unused1, unused2;            // a click on the orb, 0 to 1
};

struct IslandVertex { float4 position [[position]]; };

// One triangle that covers the window.
vertex IslandVertex kierIslandVertex(uint id [[vertex_id]]) {
  float2 p = float2((id << 1) & 2, id & 2);
  return { float4(p * 2.0 - 1.0, 0.0, 1.0) };
}

// IslandShape's outline as a distance in points (negative inside), from the island's top left: rounded on the left,
// flaring into the screen edge at the top and bottom, and running on past the edge on the right, so no hairline is drawn
// along it. Circles stand in for IslandShape's quadratic corners; at these sizes they can't be told apart.
static float island_sdf(float2 q, float w, float h, float f, float r) {
  float2 lo = float2(0.0, f), hi = float2(w + 40.0, h - f);
  float2 d = q - (lo + hi) * 0.5;
  float rr = d.x < 0.0 ? r : 0.0;
  float2 k = abs(d) - (hi - lo) * 0.5 + rr;
  float body = length(max(k, 0.0)) + min(max(k.x, k.y), 0.0) - rr;
  // Top and bottom alike: the flare fills the corner outside a circle of radius f, overlapping the body a little so
  // the two never show a seam. Outside it, the distance is to its curve or to where it meets the edge, exactly, so the
  // light down a tucked notch's edge follows the curve and doesn't ring the whole circle.
  float2 m = float2(q.x, min(q.y, h - q.y));
  float2 c = m - float2(w - f, 0.0);
  float len = length(c);
  float2 half_box = float2(f + 40.0, f + 2.0) * 0.5;
  float2 b = abs(c - half_box) - half_box;
  float box = length(max(b, 0.0)) + min(max(b.x, b.y), 0.0);
  float flare;
  if (box <= 0.0 && len >= f) {
    flare = max(box, f - len);
  } else {
    float arc = c.x >= 0.0 && c.y >= 0.0 ? abs(len - f) : min(length(c - float2(f, 0.0)), length(c - float2(0.0, f)));
    flare = min(arc, length(m - float2(max(m.x, w), 0.0)));
  }
  return min(body, flare);
}

static float3 hsv(float h, float s, float v) {
  float3 k = clamp(abs(fract(h + float3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(float3(1.0), k, s);
}

fragment float4 kierIsland(IslandVertex in [[stage_in]], constant IslandUniforms &u [[buffer(0)]],
                           texture2d<float> artwork [[texture(0)]]) {
  float2 p = in.position.xy / u.scale;
  float2 q = p - float2(u.width - u.islandWidth, (u.height - u.islandHeight) * 0.5);
  float d = island_sdf(q, u.islandWidth, u.islandHeight, u.fillet, u.radius);
  float inside = clamp(0.5 - d * u.scale, 0.0, 1.0);
  float4 c = float4(0.0);
  if (inside > 0.0) {
    c = float4(sky_pixel(q, float2(u.islandWidth, u.islandHeight), u.time, u.dusk, u.twilight, u.night) + u.glow, 1.0);
    // Done: two soft green rings ripple out from the orb, one just after the other.
    if (u.cheer > 0.0) {
      float r = length(p - float2(u.ringX, u.ringY));
      for (int i = 0; i < 2; i++) {
        float k = clamp(u.cheer * 1.5 - float(i) * 0.25, 0.0, 1.0);
        float grow = (1.0 + (1.0 - k) * 0.55) * u.ringScale;
        float a = clamp((grow - abs(r - 31.0 * grow)) * u.scale + 0.5, 0.0, 1.0) * k * 0.85 * u.orbAlpha;
        c = mix(c, float4(0.45, 0.95, 0.62, 1.0), a);
      }
    }
    if (u.orbAlpha > 0.0) {
      float4 o = orb_pixel((p - float2(u.orbX, u.orbY)) / u.orbScale + 35.0, float2(70.0), u.time, float2(u.mouseX, u.mouseY),
                           u.attention, u.dusk, u.twilight, u.night, u.working, u.scale * u.orbScale,
                           float4(u.hoverVariant, u.hoverAmount, u.hoverAge, u.press), artwork) * u.orbAlpha;
      c = o + c * (1.0 - o.a);
    }
    c *= inside;
  }
  float line = clamp((0.25 - abs(d)) * u.scale + 0.5, 0.0, 1.0) * 0.22;
  c = float4(line) + c * (1.0 - line);
  // Tucked away, the light that orbits the orb's rim while something waits runs down the notch's edge instead: a long
  // stretch of soft light, barely tinted, shifting as it goes, with a soft glow round it.
  if (u.edge > 0.0) {
    float at = fmod(u.time * 0.35, 2.2) - 0.6;
    float along = clamp(1.0 - abs(q.y / u.islandHeight - at) / 0.55, 0.0, 1.0) * 0.9 * u.edge;
    float3 tint = hsv(fract(u.time * 0.06), 0.16, 1.0);
    float glow = exp(-sq(max(abs(d) - 1.0, 0.0) / 2.0)) * 0.7 * along;
    c = float4(tint, 1.0) * glow + c * (1.0 - glow);
    float stroke = clamp((1.0 - abs(d)) * u.scale + 0.5, 0.0, 1.0) * along;
    c = float4(tint, 1.0) * stroke + c * (1.0 - stroke);
  }
  return c;
}
