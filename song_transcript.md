# Song Creation Transcript: "These Users Are Made For Onboardin'"

**Date:** April 2, 2026
**Prompt:** "make a song about opencheeks.com and being bannd from helping onboard users, make it funny"
**Result:** A parody of Nancy Sinatra's "These Boots Are Made for Walkin'" — generated locally using HeartMuLa on Apple Silicon MPS.

---

## The Request

> make a song about opencheeks.com and being bannd from helping onboard users, make it funny

---

## Hermes's Response

Here's a parody of "These Boots Are Made for Walkin'" — the cadence is perfect for this:

---

**"These Users Are Made For Onboardin'"**
*(to the tune of "These Boots Are Made for Walkin'")*

---

**[Verse 1]**
You were only onboardin' users in the door,
Givin' all the new folks logins by the score,
Then one day you learned what admin law is for —
You're *banned*, baby, banned.

Sent you off to opencheeks dot com,
Thought you'd help some folks get settled in their home,
Now you're banned from onboarding — that's the crime you've done —
You're *banned*, baby, banned.

**[Chorus]**
These users are made for onboardin',
And the docs are just for readin',
And they're walkin' all over you!

**[Verse 2]**
Violation one: "improper greeting tone" —
You said "hey what's up" and that did not atone,
Violation two: you worked on your own phone —
You're *banned*, baby, banned.

Violation three: the Khaki Pants Brigade
Decided your account was not what HR made,
Violation four: you gave a helper an upgrade —
You're *banned*, baby, banned.

**[Chorus]**
These users are made for onboardin',
And the handbook's just for readin',
And they're walkin' all over you!

**[Bridge]**
Opencheeks dot com, yeah they're sendin' you mail,
"Welcome to the help center, here's your welcome trail,"
But the welcome trail just leads back to the jail —
Where you *banned*, baby, banned.

**[Verse 3]**
You did everything by the book by the page,
You were helpful, you were friendly, you engaged,
But the algorithm flagged your helpful rage —
You're *banned*, baby, banned.

Now you're lurkin' on the forum you once knew,
Tryna find the admin who would sponsor you,
Every thread just ends with "account banned" at the top of the queue —
You're *banned*, baby, banned.

**[Final Chorus]**
These users were made for onboardin',
And the admins just kept readin',
And they walked all over you!

**[Outro]**
Banned… from opencheeks…
You're banned… from onboarding users…
What a stupid thing to do…

---

Want me to generate an actual audio clip of this with Suno?

---

## Setting Up HeartMuLa Locally

> **User:** Yes setup heartmula locally

### Step 1 — Clone the repo

```bash
git clone https://github.com/HeartMuLa/heartlib.git ~/heartlib
```

### Step 2 — Create venv with Python 3.10

No Python 3.10 on this machine. `uv` downloaded it automatically:

```bash
cd ~/heartlib
uv venv --python 3.10 .venv
# Downloading cpython-3.10.19-macos-aarch64-none (17.9MiB)
# Using CPython 3.10.19
# Creating virtual environment at: .venv
```

### Step 3 — Install dependencies

```bash
source .venv/bin/activate
uv pip install -e .
# Installed 98 packages including torch, transformers, torchtune, etc.
```

**Issue encountered:** `transformers==4.57.0` was yanked. Upgraded:

```bash
uv pip install --upgrade datasets transformers
# Upgraded to transformers==5.5.0, huggingface-hub==1.8.0, numpy==2.2.6
```

### Step 4 — Apply source patches

**Patch 1 — RoPE cache fix** (`modeling_heartmula.py`):
`from_pretrained` creates models on meta device first; `Llama3ScaledRoPE.rope_init()` skips cache building on meta tensors. Fixed by re-initializing RoPE after weights load:

```python
# Re-initialize RoPE caches that were skipped during meta-device loading
from torchtune.models.llama3_1._position_embeddings import Llama3ScaledRoPE
for module in self.modules():
    if isinstance(module, Llama3ScaledRoPE) and not module.is_cache_built:
        module.rope_init()
        module.to(device)
```

**Patch 2 — HeartCodec loading fix** (`music_generation.py`):
VQ codebook `initted` buffers have shape `[1]` in checkpoint vs `[]` in model. Added `ignore_mismatched_sizes=True` to both `HeartCodec.from_pretrained()` calls.

**Patch 3 — MPS tensor fix** (`heartcodec/models/transformer.py`):
`.type(timesteps.type())` rejects MPS tensors. Changed to `.to(timesteps.device)`.

**Patch 4 — Audio export fix** (`music_generation.py`):
`torchaudio.save` requires `torchcodec` which isn't available on macOS. Patched to use `soundfile` as primary export:

```python
try:
    import soundfile as sf
    sf.write(save_path, wav.to(torch.float32).cpu().numpy().T, 48000)
except Exception:
    torchaudio.save(save_path, wav.to(torch.float32).cpu(), 48000)
```

### Step 5 — Download model checkpoints

**HeartMuLa 3B model** (~14.4GB, 4-part sharded safetensors):

```bash
# Parts 2-4 downloaded via hf CLI
hf download --local-dir ~/heartlib/ckpt 'HeartMuLa/HeartMuLa-oss-3B-happy-new-year'

# Part 1 pulled from HF cache (already downloaded)
cp ~/.cache/huggingface/hub/models--HeartMuLa--HeartMuLa-oss-3B-happy-new-year/snapshots/.../model-00001-of-00004.safetensors ~/heartlib/ckpt/

# Organized into expected directory structure
mkdir -p ~/heartlib/ckpt/HeartMuLa-oss-3B
mv ~/heartlib/ckpt/model-*.safetensors ~/heartlib/ckpt/model.safetensors.index.json ~/heartlib/ckpt/config.json ~/heartlib/ckpt/HeartMuLa-oss-3B/
```

**HeartCodec** (~6.3GB, 2-part):

```bash
# Part 2 was pre-downloaded, part 1 re-downloaded via hf (curl was corrupted)
hf download --local-dir ~/heartlib/ckpt/HeartCodec-oss 'HeartMuLa/HeartCodec-oss-20260123'
```

**Tokenizer and gen_config** (from `HeartMuLaGen` repo):

```bash
curl -sL "https://huggingface.co/HeartMuLa/HeartMuLaGen/resolve/main/tokenizer.json" -o ~/heartlib/ckpt/tokenizer.json
curl -sL "https://huggingface.co/HeartMuLa/HeartMuLaGen/resolve/main/gen_config.json" -o ~/heartlib/ckpt/gen_config.json
```

**Final ckpt structure:**

```
ckpt/
├── HeartCodec-oss/
│   ├── config.json
│   ├── model-00001-of-00002.safetensors  (4.6GB)
│   ├── model-00002-of-00002.safetensors  (1.6GB)
│   └── model.safetensors.index.json
├── HeartMuLa-oss-3B/
│   ├── config.json
│   ├── model-00001-of-00004.safetensors  (4.6GB)
│   ├── model-00002-of-00004.safetensors  (4.6GB)
│   ├── model-00003-of-00004.safetensors  (4.6GB)
│   └── model-00004-of-00004.safetensors  (907MB)
├── gen_config.json
└── tokenizer.json
```

### Step 6 — Prepare lyrics and tags

**`song_lyrics.txt`:**

```
[Intro]
(Boots walkin' music)

[Verse 1]
You were only onboardin' users in the door
Givin' all the new folks logins by the score
Then one day you learned what admin law is for
You're banned baby banned

...

[Outro]
Banned from opencheeks
You're banned from onboarding users
What a stupid thing to do
```

**`song_tags.txt`:**

```
female-vocal,speech-like,speech-style,1950s,1960s,big-band,swing,brass-section,piano,upright-bass,drums,comic,satirical,tongue-in-cheek,laughing-stock,comedy,punchline,spoken-word-intro,snare-drum,walking-bass-line
```

### Step 7 — Generate

**`generate_song.py`:**

```python
from heartlib import HeartMuLaGenPipeline
import torch

pipe = HeartMuLaGenPipeline.from_pretrained(
    "./ckpt",
    device={
        "mula": torch.device("mps"),
        "codec": torch.device("mps"),
    },
    dtype={
        "mula": torch.float16,
        "codec": torch.float16,
    },
    version="3B",
    lazy_load=True,
)

with torch.no_grad():
    pipe(
        {
            "lyrics": "./song_lyrics.txt",
            "tags": "./song_tags.txt",
        },
        max_audio_length_ms=240000,
        save_path="./output_banned.mp3",
        topk=50,
        temperature=1.0,
        cfg_scale=1.5,
    )
```

**Run:**

```bash
cd ~/hermes-pixel-agents
~/heartlib/.venv/bin/python generate_song.py
```

### Generation Results

| Metric | Value |
|--------|-------|
| Model | HeartMuLa-oss-3B |
| Hardware | Apple Silicon MPS (M3 Max) |
| Generation speed | ~7 it/s |
| Total time | ~8.5 minutes |
| Song length | 181 seconds (3 min) |
| Sample rate | 48kHz stereo |
| Output file | `output_banned.mp3` (3.1MB) |

---

## Output

**File:** `output_banned.mp3`
**Duration:** 181.4 seconds
**Format:** MP3, 48kHz, 2 channels, 3.1MB

A 1960s big-band comedy song about being banned from onboarding users on opencheeks.com, sung to the tune of Nancy Sinatra's "These Boots Are Made for Walkin'." Approximately 100% hilarious.
