# Taste Passport Specification

## 1. Purpose

The Taste Passport is a portable, user-owned summary of musical taste encoded as an open JSON document. It decouples the user taste model from any single streaming platform or central database: the user holds their taste representation, while any receiving music service can score and rank its own track catalogue against that representation.

Rather than collapsing diverse listening behavior into a single average centroid, the passport preserves multiple distinct interest clusters, contextual time-of-day preferences, exemplar anchor tracks, and high-level descriptors.

## 2. The Three Portability Layers

Embedding vectors have mathematical meaning only within the specific vector space created by their model. To enable interoperability across platforms with varying machine-learning capabilities, the passport structures taste into three tiers:

1. Named-space vectors: Dense floating-point embeddings tied to explicit, named models (for example, `learned-audio:msd-musicnn-1:200` or `metadata:metadata-ngram-v2:64`). This layer includes long-term taste vectors, negative avoidance vectors, multi-interest centroids, and contextual offsets. It provides the highest ranking fidelity when sender and receiver share the same model.
2. Weighted anchor tracks: High-signal exemplar tracks the user liked or avoided, identified by normalized compound keys formatted as `normalizedArtist::normalizedTrack`. Each entry contains artist name, track title, album, and a normalized relative weight in [0, 1]. A receiving platform running a different embedding model can match or re-embed these anchor tracks in its own catalog space.
3. Descriptors: Coarse genre, mood, and artist affinities with normalized weights summing to 1. This serves as a universal zero-embedding fallback when the receiving platform lacks vector capabilities or shares no catalog tracks with the anchor list.

## 3. File Format

### Field Definitions

Nested fields are listed together, top level first. `name` belongs to `generator`; `id` through `contexts` belong to each entry of `spaces`; `key` through `weight` belong to each anchor; `label` and `vector` belong to interests and descriptors.

| Field | Type | Description |
| --- | --- | --- |
| `schema` | string | Protocol schema identifier, set to `sisic.taste-passport`. |
| `version` | number | Schema version integer (`1`). |
| `createdAt` | string | ISO 8601 UTC timestamp of passport export. |
| `generator` | object | Generating application metadata containing `name`. |
| `name` | string | Application name string. |
| `halfLifeDays` | number | Half-life in days used for recency decay weighting. |
| `stats` | object | Aggregate signal and interaction counts. |
| `sessions` | number | Number of listening sessions observed. |
| `positiveSignals` | number | Count of positive playback events (starts, completions). |
| `negativeSignals` | number | Count of negative playback events (skips, short plays). |
| `explicitSignals` | number | Count of explicit user signals (likes). |
| `librarySongs` | number | Total number of songs in the source library. |
| `spaces` | array | Array of embedding space definitions. |
| `id` | string | Compound space identifier (`${vectorType}:${model}:${dimensions}`). |
| `vectorType` | string | Representation category (`learned-audio` or `metadata`). |
| `model` | string | Model name identifier. |
| `dimensions` | number | Dimensionality of vectors in this space. |
| `interoperable` | boolean | Whether the space uses a public, shared model. |
| `longTerm` | array | Unit-normalized long-term preference vector. |
| `negative` | array \| null | Unit-normalized negative preference vector, or null. |
| `interests` | array | Multi-interest cluster objects. |
| `contexts` | object | Contextual time-of-day vectors (`morning`, `afternoon`, `evening`, `night`). |
| `anchors` | object | Exemplar track lists split into `liked` and `avoided`. |
| `liked` | array | Positive anchor tracks, scaled relative to heaviest anchor. |
| `avoided` | array | Negative anchor tracks to avoid or down-weight. |
| `key` | string | Normalized track identifier (`normalizedArtist::normalizedTrack`). |
| `artist` | string | Artist display name. |
| `title` | string | Track title. |
| `album` | string | Album title. |
| `weight` | number | Normalized weight value. |
| `descriptors` | object | Coarse preference tallies for `genres`, `moods`, and `artists`. |
| `genres` | array | Weighted genre labels. |
| `moods` | array | Weighted mood labels. |
| `artists` | array | Weighted artist labels. |
| `label` | string | Name of descriptor category or interest label. |
| `vector` | array | Array of finite floating-point values normalized to unit length. |

### Example JSON Document

```json
{
  "schema": "sisic.taste-passport",
  "version": 1,
  "createdAt": "2026-09-30T12:00:00.000Z",
  "generator": { "name": "Sisic Music" },
  "halfLifeDays": 30,
  "stats": {
    "sessions": 45,
    "positiveSignals": 160,
    "negativeSignals": 14,
    "explicitSignals": 12,
    "librarySongs": 240
  },
  "spaces": [
    {
      "id": "learned-audio:msd-musicnn-1:200",
      "vectorType": "learned-audio",
      "model": "msd-musicnn-1",
      "dimensions": 200,
      "interoperable": true,
      "longTerm": [0.071, -0.042, 0.015],
      "negative": null,
      "interests": [
        { "weight": 0.62, "label": "Rock", "vector": [0.082, -0.038, 0.012] },
        { "weight": 0.38, "label": "Jazz", "vector": [-0.011, 0.074, 0.028] }
      ],
      "contexts": {
        "evening": { "sessions": 18, "vector": [0.065, -0.045, 0.019] }
      }
    }
  ],
  "anchors": {
    "liked": [
      {
        "key": "radiohead::karma police",
        "artist": "Radiohead",
        "title": "Karma Police",
        "album": "OK Computer",
        "weight": 1.0
      }
    ],
    "avoided": []
  },
  "descriptors": {
    "genres": [{ "label": "Alternative", "weight": 0.55 }, { "label": "Post-Bop", "weight": 0.45 }],
    "moods": [{ "label": "Melancholic", "weight": 0.6 }, { "label": "Complex", "weight": 0.4 }],
    "artists": [{ "label": "Radiohead", "weight": 0.6 }, { "label": "Miles Davis", "weight": 0.4 }]
  }
}
```

## 4. How a Platform Consumes It

When scoring a candidate library against an imported passport, a platform selects the highest compatible layer available:

1. Same embedding space: If the platform supports an identical space present in the passport (such as `msd-musicnn-1` audio embeddings or matching metadata embeddings), candidate tracks are scored directly against the passport vectors. The vector component contributes 85% of candidate scoring, plus 15% descriptor affinity and a small bonus (0.1 times the anchor weight) when the track is itself an anchor.
2. Different embedding space: If vector spaces do not align, the platform falls back to anchor tracks. It locates known anchor tracks within its own catalogue using compound track keys, extracts their local embedding vectors, and computes fresh interest centroids (or a unit mean) in its local space. Candidate songs are scored against these re-embedded anchor clusters (60% vector affinity, 40% descriptors, plus the same anchor bonus).
3. No audio or embeddings: If the platform lacks vector capability or finds no matching anchor tracks, it ranks purely using descriptor weights. Track scores are calculated as a linear combination of genre fit (40%), mood fit (30%), and primary artist fit (30%).
4. No shared signals: If a passport contains no compatible spaces, no overlapping anchors, and no matching descriptors, scoring declines cleanly by returning mode `none` and an empty song list.

## 5. Multi-Interest Ranking

Musical taste is multimodal: averaging disparate preferences (for example, heavy metal and acoustic jazz) yields a central vector that satisfies neither genre. The ranking pipeline handles multiple interests through explicit clustering, scoring, and slot allocation:

- Spherical k-means clustering: Listening history is partitioned using spherical weighted k-means with cosine distance and weighted k-means++ seeding. Centroids are unit-normalized weighted sums.
- Interest selection: The builder tries k from 2 to 4 clusters (an imported passport may carry up to 8 interests per space). A split is adopted only if every resulting interest represents at least 12% of weighted listening and produces a substantial reduction in clustering cost (at least 4% absolute and 30% relative gain).
- Scoring against closest interest: When evaluating a candidate song vector, affinity is computed against the closest interest cluster. Positive similarity is mildly discounted according to the cluster's relative listening share, ensuring minor interests remain viable without artificially rewarding poor matches.
- D'Hondt slot allocation: Candidate songs are assigned to their nearest interest. Mix slots are allocated across interests proportionally using the D'Hondt method (priority quotient = weight / (slots + 1), where weight is the interest weight and slots is the count of items already chosen for that interest). This prevents a dominant preference from monopolizing initial playlist slots, which is especially important when blending two listeners.
- Artist capping: To prevent playlist repetition, no artist may occupy more than 2 slots whenever the candidate pool exceeds the target playlist size.

## 6. Privacy and Validation

### Privacy Guarantees

The Taste Passport is an aggregated profile, not an event ledger. It never contains or leaks:
- Raw playback event streams or session logs.
- Timestamps of individual play, skip, or like events.
- Google Drive file identifiers (`driveFileId`), URLs, local file paths, or storage filenames.
- Personal identity data or account credentials.

### Import Validation Rules

Any imported JSON document is treated as untrusted user input and subjected to strict sanitization:
- Size limit: Payloads exceeding 2 MB (`TASTE_PASSPORT_MAX_BYTES`) are rejected immediately before JSON parsing.
- Safe parsing: Parsing is wrapped in defensive error handling that never throws uncaught exceptions on malformed input.
- Structural schema verification: The schema identifier must equal `sisic.taste-passport`, and version must be an integer less than or equal to `TASTE_PASSPORT_VERSION` (version 1).
- Vector dimension and value checks: Every vector must be an array matching its declared dimension count. All entries must be finite numbers (`Number.isFinite`); any `NaN`, `null`, or `Infinity` causes the vector to be rejected.
- Field whitelisting: Only recognized properties are copied into internal structures. Unknown properties, prototype pollution attempts (`__proto__`, `constructor`), and payload injection keys are stripped.
- Quantitative boundaries: Maximum caps are enforced for spaces (6), interests (8), contexts (4), liked anchors (200), avoided anchors (100), descriptors (30), and string lengths (80 to 160 characters).

## 7. Research Grounding

The architecture builds directly upon six core concepts in recommendation research:

- CoSeRNN, Hansen et al., RecSys 2020: Informs decoupling user taste embeddings from track embeddings, and representing user preference as a long-term taste vector paired with contextual offsets.
- PinnerSage, Pal et al., KDD 2020: Inspires clustering user interaction history into multiple distinct interest representations rather than a single centroid, and interleaving multi-interest candidates into feeds.
- MIND, Li et al., CIKM 2019: Informs multi-interest vector representations for capturing diverse facets of user preference.
- Hu, Koren, Volinsky, ICDM 2008: Informs implicit-feedback confidence weighting, converting playback starts, completions, and skips into positive and negative preference signals.
- MMR, Carbonell & Goldstein, SIGIR 1998: Informs diversity ranking and item deduplication via multi-interest slot interleaving and per-artist frequency caps.
- musicnn, Pons & Serra, ISMIR 2019: Defines the learned audio embedding space (`msd-musicnn-1` 200-D).

## 8. Honest Limits

The implementation carries several practical constraints:

- App-private metadata space: The current in-app metadata space (`metadata-ngram-v2`) is an app-private character n-gram hashing scheme. Vectors inside this space are not portable.
- Anchors are the portable layer today: Because metadata vectors are app-private and external sound models differ, weighted anchor tracks identified by `normalizedArtist::normalizedTrack` are the portable layer today.
- Audio embedding worker pipeline not connected: The audio-embedding space needs the Mac worker to compute learned embeddings, and that is not wired up yet.
- Summary, not a guarantee: A passport is a taste summary, not a guarantee of recommendation quality across unfamiliar libraries.
- No real-user evaluation: No offline or online evaluation has been run against real users to measure ranking accuracy or cluster stability.
