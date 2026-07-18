"""Custom profile pictures, shared by every game in the hub.

A pfp belongs to a TOKEN (the per-device secret): the filename is a hash of
the token, so the public URL never leaks the secret and can't be guessed to
overwrite someone else's picture. Uploads are re-encoded through Pillow
(center-crop square, 128px WebP) which also strips EXIF/location data.
"""

from __future__ import annotations

import hashlib
import io
from pathlib import Path

from PIL import Image, ImageOps

AVATAR_DIR = Path(__file__).parent.parent / "data" / "avatars"
SIZE = 256          # larger than the old 128 so faces stay crisp when shown big
MAX_BYTES = 8 * 1024 * 1024


def _key(token: str) -> str:
    return hashlib.sha256(("pfp:" + token).encode()).hexdigest()[:20]


def url_for(token) -> str | None:
    """Public URL of this token's pfp, or None. mtime busts stale caches."""
    if not isinstance(token, str) or not token:
        return None
    p = AVATAR_DIR / (_key(token) + ".webp")
    if p.is_file():
        return "/avatars/%s.webp?v=%d" % (_key(token), int(p.stat().st_mtime))
    return None


def save(token: str, data: bytes) -> str:
    """Validate + normalize an uploaded image; returns the new URL.
    Raises ValueError on anything that isn't a usable image."""
    if len(data) > MAX_BYTES:
        raise ValueError("image too large (4MB max)")
    try:
        probe = Image.open(io.BytesIO(data))
        probe.verify()                      # cheap integrity check
        img = Image.open(io.BytesIO(data))  # verify() invalidates the handle
        img = ImageOps.exif_transpose(img).convert("RGB")
        img = ImageOps.fit(img, (SIZE, SIZE))
    except ValueError:
        raise
    except Exception:
        raise ValueError("that doesn't look like an image")
    AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    img.save(AVATAR_DIR / (_key(token) + ".webp"), "WEBP", quality=86)
    return url_for(token)


def remove(token: str) -> None:
    """Delete this token's pfp if it exists (idempotent)."""
    if not isinstance(token, str) or not token:
        return
    try:
        (AVATAR_DIR / (_key(token) + ".webp")).unlink()
    except FileNotFoundError:
        pass
