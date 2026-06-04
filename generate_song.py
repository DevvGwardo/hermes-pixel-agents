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
print("Generated music saved to ./output_banned.mp3")
