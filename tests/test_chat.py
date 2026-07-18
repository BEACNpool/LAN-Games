import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
from PIL import Image

from core import chatmedia
from core.chat import ChatHub, _uid


def _png(color=(200, 40, 90), size=(48, 32)):
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


# ---------------- chatmedia ----------------

def test_save_valid_png_roundtrips():
    r = chatmedia.save(_png())
    # static images are re-encoded to webp
    assert r["url"].startswith("/chatmedia/") and r["url"].endswith(".webp")
    assert r["w"] == 48 and r["h"] == 32
    assert chatmedia.valid_url(r["url"])
    assert (chatmedia.CHAT_DIR / r["url"].rsplit("/", 1)[1]).is_file()


def test_save_downscales_big_phone_photo():
    # the reported bug: a landscape 12MP photo (4032x3024) used to be rejected
    r = chatmedia.save(_png(size=(4032, 3024)))
    assert chatmedia.valid_url(r["url"])
    assert max(r["w"], r["h"]) <= chatmedia.MAX_DIM     # shrunk to fit
    assert r["w"] == 1600 and r["h"] == 1200            # aspect preserved


def test_save_keeps_animated_gif():
    frames = [Image.new("RGB", (64, 48), c) for c in [(255, 0, 0), (0, 0, 255)]]
    buf = io.BytesIO()
    frames[0].save(buf, "GIF", save_all=True, append_images=frames[1:], duration=120, loop=0)
    r = chatmedia.save(buf.getvalue())
    assert r["url"].endswith(".gif")                    # not re-encoded
    saved = Image.open(chatmedia.CHAT_DIR / r["url"].rsplit("/", 1)[1])
    assert getattr(saved, "is_animated", False) and saved.n_frames == 2


def test_save_is_content_addressed():
    a = chatmedia.save(_png(color=(1, 2, 3)))
    b = chatmedia.save(_png(color=(1, 2, 3)))
    assert a["url"] == b["url"]        # identical bytes dedupe


def test_save_rejects_non_image():
    with pytest.raises(ValueError):
        chatmedia.save(b"definitely not an image")


def test_save_rejects_empty():
    with pytest.raises(ValueError):
        chatmedia.save(b"")


def test_save_rejects_oversize():
    with pytest.raises(ValueError):
        chatmedia.save(b"x" * (chatmedia.MAX_BYTES + 1))


def test_valid_url_guards():
    assert not chatmedia.valid_url("/etc/passwd")
    assert not chatmedia.valid_url("/chatmedia/../secret.png")
    assert not chatmedia.valid_url("/chatmedia/zzz.exe")
    assert not chatmedia.valid_url("/chatmedia/deadbeefdeadbeefdead.png")  # not on disk
    assert not chatmedia.valid_url(None)


# ---------------- chat message building ----------------

def test_build_text_message():
    hub = ChatHub()
    tok = "avatoken0001"
    out = hub._build(tok, _uid(tok), {"name": "Ava", "avatar": "🦊"},
                     {"text": "  hi there  "})
    assert out["text"] == "hi there"        # stripped
    assert out["name"] == "Ava" and out["avatar"] == "🦊"
    assert out["by"] == _uid(tok) and out["img"] is None
    assert isinstance(out["ts"], int)


def test_build_caps_length_and_strips_nul():
    hub = ChatHub()
    out = hub._build("t" * 12, _uid("t" * 12), {"name": "X"},
                     {"text": "a\x00" + "z" * 999})
    assert "\x00" not in out["text"]
    assert len(out["text"]) <= 400


def test_build_empty_is_dropped():
    hub = ChatHub()
    assert hub._build("avatoken0001", "u", {}, {"text": "   "}) is None
    assert hub._build("avatoken0001", "u", {}, {}) is None


def test_build_rejects_forged_img():
    hub = ChatHub()
    # a bogus/forged img url is stripped; with no text the message is dropped
    assert hub._build("avatoken0001", "u", {}, {"img": "/chatmedia/../x.png"}) is None
    out = hub._build("avatoken0001", "u", {}, {"text": "hi", "img": "http://evil/x.gif"})
    assert out is not None and out["img"] is None


def test_build_keeps_real_img():
    hub = ChatHub()
    r = chatmedia.save(_png(color=(9, 9, 9)))
    out = hub._build("avatoken0001", "u", {}, {"text": "", "img": r["url"]})
    assert out is not None and out["img"] == r["url"]
