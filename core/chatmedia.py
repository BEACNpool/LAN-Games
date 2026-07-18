"""Chat media (memes / GIFs) for the hub lobby chat.

Unlike avatars (which re-encode to a square WebP), chat media keeps the
ORIGINAL bytes so animated GIFs stay animated. We still validate that it's a
real, decodable image and cap size/count. Files are content-addressed
(sha256 of the bytes) so identical uploads dedupe. Served static from
/chatmedia; everything is LAN-local, no external hosts.
"""

from __future__ import annotations

import hashlib
import io
from pathlib import Path

from PIL import Image, ImageOps

CHAT_DIR = Path(__file__).parent.parent / "data" / "chatmedia"
MAX_BYTES = 16 * 1024 * 1024        # input cap; big phone photos are downscaled
MAX_DIM = 1600                      # static images are shrunk to fit this box
MAX_FILES = 400                     # prune oldest beyond this
EXT = {"GIF": "gif", "PNG": "png", "JPEG": "jpg", "WEBP": "webp"}


def save(data: bytes) -> dict:
    """Validate + store an uploaded image/GIF. Returns {url, w, h}.

    Static images (phone photos, PNG/JPG memes) are downscaled to fit a 1600px
    box and re-encoded to WebP — so a 4032px camera photo just works, and EXIF
    is stripped. Animated GIFs/WebP are kept byte-for-byte so they stay animated.
    Raises ValueError on anything that isn't a usable image.
    """
    if not data:
        raise ValueError("empty upload")
    if len(data) > MAX_BYTES:
        raise ValueError("image too large (16MB max)")
    try:
        probe = Image.open(io.BytesIO(data))
        probe.verify()                       # integrity check
        img = Image.open(io.BytesIO(data))   # verify() spends the handle
        fmt = img.format
    except Exception:
        raise ValueError("that doesn't look like an image")
    if fmt not in EXT:
        raise ValueError("use a GIF, PNG, JPG or WebP")

    CHAT_DIR.mkdir(parents=True, exist_ok=True)

    if getattr(img, "is_animated", False):
        # keep the animation intact — store the original bytes as-is
        w, h = img.size
        name = "%s.%s" % (hashlib.sha256(data).hexdigest()[:20], EXT[fmt])
        (CHAT_DIR / name).write_bytes(data)
        _prune()
        return {"url": "/chatmedia/" + name, "w": w, "h": h}

    # static: orient, (down)scale, re-encode to WebP
    img = ImageOps.exif_transpose(img)
    img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
    img.thumbnail((MAX_DIM, MAX_DIM))
    out = io.BytesIO()
    img.save(out, "WEBP", quality=85)
    blob = out.getvalue()
    name = "%s.webp" % hashlib.sha256(blob).hexdigest()[:20]
    (CHAT_DIR / name).write_bytes(blob)
    _prune()
    return {"url": "/chatmedia/" + name, "w": img.width, "h": img.height}


def _prune() -> None:
    files = sorted(CHAT_DIR.glob("*.*"), key=lambda p: p.stat().st_mtime)
    for p in files[:-MAX_FILES]:
        try:
            p.unlink()
        except OSError:
            pass


_VALID = __import__("re").compile(r"^/chatmedia/[a-f0-9]{20}\.(gif|png|jpg|webp)$")


def valid_url(url) -> bool:
    """True only for a chatmedia URL we issued that still exists on disk."""
    if not (isinstance(url, str) and _VALID.match(url)):
        return False
    return (CHAT_DIR / url.rsplit("/", 1)[1]).is_file()
