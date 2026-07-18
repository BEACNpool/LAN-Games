"""DuelSession — shared base for 2-seat board games (chess, checkers,
backgammon, connect four, ...).

On top of GameSession it owns everything identical across board games:
  * seating: 2 seats with per-game colors; extras from the lobby bench and
    watch; a lone ready human gets a bot opponent automatically
  * turn plumbing: subclass exposes current_color(); the base maps color ->
    token, schedules bots/autopilot (disconnected humans), and runs the
    optional per-move timer (0 = untimed, the family default)
  * courtesy actions: resign, draw offers, takeback offers (opponent must
    accept; games opt in via SUPPORTS_TAKEBACK/SUPPORTS_DRAW)
  * result envelope + rematch via the shared game_end phase

Subclass contract:
  SEAT_COLORS   e.g. ("w", "b")  — index 0 moves first
  duel_start()          set up self.d (game position); return fx
  current_color()       whose move it is, or None when finished
  duel_move(token, color, msg)   validate+apply a move; return fx
  duel_auto(color)      make a bot/autopilot move for `color`; return fx
  duel_takeback(color)  undo so `color` is to move again (if supported)
  duel_state(viewer_token)       game-specific state dict (mask if needed)
  finish(winner_color_or_None, why)  helper below — call when the game ends
"""

from __future__ import annotations

import time

from core.session import GameSession

BOT_NAMES = ["MILO", "IRIS", "ODIN", "PIXEL"]


class DuelSession(GameSession):
    MIN_PLAYERS = 1            # one human + a bot is a real game
    MAX_HUMANS = 8             # 2 seats; the rest spectate
    SEAT_COLORS = ("w", "b")
    SUPPORTS_TAKEBACK = True
    SUPPORTS_DRAW = True
    DEFAULT_SETTINGS = {"difficulty": "sharp", "turn_seconds": 0}

    def __init__(self, rng=None):
        super().__init__(rng)
        self.g = None          # base bookkeeping
        self.d = None          # subclass position state

    def validate_settings(self, patch):
        ok = {}
        if patch.get("difficulty") in ("rookie", "sharp"):
            ok["difficulty"] = patch["difficulty"]
        ts = patch.get("turn_seconds")
        if isinstance(ts, int) and not isinstance(ts, bool) \
                and ts in (0, 30, 60, 120):
            ok["turn_seconds"] = ts
        return ok

    # ---------------- lifecycle ----------------

    def game_start(self):
        humans = self.participants[:2]
        benched = self.participants[2:]
        self.participants = list(humans)
        fx = [self.fx("toast", to=t, icon="🪑",
                      msg="Two seats — you're watching this one")
              for t in benched]
        if len(humans) == 1:
            bot = self.add_bot("BOT %s" % BOT_NAMES[self.rng.randrange(len(BOT_NAMES))])
            self.participants.append(bot.token)
        seats_tokens = list(self.participants)
        self.rng.shuffle(seats_tokens)
        self.g = {
            "seats": dict(zip(self.SEAT_COLORS, seats_tokens)),
            "draw_offer": None,      # color that offered
            "takeback_offer": None,  # color that asked
            "result": None,          # {"winner": color|None, "why": str}
        }
        names = {c: self.players[t].name for c, t in self.g["seats"].items()}
        fx.append(self.fx("toast", icon="⚔️",
                          msg="%s vs %s" % (names[self.SEAT_COLORS[0]],
                                            names[self.SEAT_COLORS[1]])))
        self.phase = "playing"
        fx.extend(self.duel_start())
        self._arm_turn()
        return fx

    def _arm_turn(self):
        secs = self.settings["turn_seconds"]
        if self.phase == "playing" and secs > 0:
            self._bump(time.time() + secs)
        else:
            self._bump(None)

    def color_of(self, token):
        for c, t in self.g["seats"].items():
            if t == token:
                return c
        return None

    def token_of(self, color):
        return self.g["seats"].get(color)

    def other(self, color):
        a, b = self.SEAT_COLORS
        return b if color == a else a

    def finish(self, winner_color, why):
        """Subclasses call this exactly once when the game is decided."""
        self.g["result"] = {"winner": winner_color, "why": why}
        fx = [self.fx("game_over", winner=winner_color, why=why)]
        fx.extend(self.end_game())
        return fx

    # ---------------- actions ----------------

    def game_action(self, token, msg):
        self.seq += 1
        if self.phase != "playing" or self.g is None:
            return [self.fx("invalid", to=token, msg="No game in progress")]
        color = self.color_of(token)
        if color is None:
            return [self.fx("invalid", to=token, msg="You're watching this one")]
        t = msg.get("t")
        if t == "move":
            if self.current_color() != color:
                return [self.fx("invalid", to=token, msg="Not your turn")]
            self.g["draw_offer"] = None
            self.g["takeback_offer"] = None
            fx = self.duel_move(token, color, msg)
            if self.phase == "playing":
                self._arm_turn()
            return fx
        if t == "resign":
            p = self.players[token]
            fx = [self.fx("toast", icon="🏳️", msg="%s resigns" % p.name)]
            fx.extend(self.finish(self.other(color), "resignation"))
            return fx
        if t == "draw_offer" and self.SUPPORTS_DRAW:
            if self.g["draw_offer"] == self.other(color):
                fx = [self.fx("toast", icon="🤝", msg="Draw agreed")]
                fx.extend(self.finish(None, "agreement"))
                return fx
            self.g["draw_offer"] = color
            return [self.fx("offer", what="draw", by=self.players[token].pid)]
        if t == "draw_decline" and self.SUPPORTS_DRAW:
            self.g["draw_offer"] = None
            return [self.fx("toast", msg="Draw declined")]
        if t == "takeback_offer" and self.SUPPORTS_TAKEBACK:
            self.g["takeback_offer"] = color
            return [self.fx("offer", what="takeback", by=self.players[token].pid)]
        if t == "takeback_accept" and self.SUPPORTS_TAKEBACK:
            asked = self.g["takeback_offer"]
            if asked is None or asked == color:
                return [self.fx("invalid", to=token, msg="No takeback to accept")]
            self.g["takeback_offer"] = None
            fx = self.duel_takeback(asked)
            self._arm_turn()
            return fx
        if t == "takeback_decline" and self.SUPPORTS_TAKEBACK:
            self.g["takeback_offer"] = None
            return [self.fx("toast", msg="Takeback declined")]
        return [self.fx("invalid", to=token, msg="Unknown action")]

    # a bot opponent auto-answers offers so a solo game never hangs
    def _bot_answers(self, fx):
        return fx

    # ---------------- timers & bots ----------------

    def game_tick(self):
        if self.phase != "playing" or self.g is None:
            return []
        color = self.current_color()
        if color is None:
            return []
        tok = self.token_of(color)
        p = self.players.get(tok)
        fx = []
        if p is not None and not p.is_bot and p.connected:
            fx.append(self.fx("toast", icon="⏱",
                              msg="%s ran out of time — autopilot moves" % p.name))
        fx.extend(self.duel_auto(color))
        if self.phase == "playing":
            self._arm_turn()
        return fx

    def next_bot_action(self):
        if self.phase != "playing" or self.g is None:
            return None
        color = self.current_color()
        if color is None:
            return None
        tok = self.token_of(color)
        p = self.players.get(tok)
        if p is None or p.is_bot or not p.connected:
            return (0.8 + self.rng.random() * 0.9, tok)
        # bots also clear pending offers aimed at them
        return None

    def run_bot(self, bot_token):
        if self.phase != "playing" or self.g is None:
            return []
        color = self.current_color()
        if color is None or self.token_of(color) != bot_token:
            return []
        p = self.players.get(bot_token)
        if p is not None and not p.is_bot and p.connected:
            return []
        self.seq += 1
        # a bot summarily declines takebacks?  no — bots are gracious:
        if p is not None and p.is_bot and self.g["takeback_offer"] \
                and self.g["takeback_offer"] != color:
            asked = self.g["takeback_offer"]
            self.g["takeback_offer"] = None
            fx = [self.fx("toast", icon="🤖", msg="%s allows the takeback" % p.name)]
            fx.extend(self.duel_takeback(asked))
            self._arm_turn()
            return fx
        fx = self.duel_auto(color)
        if self.phase == "playing":
            self._arm_turn()
        return fx

    # ---------------- connection events ----------------

    def game_player_left(self, token):
        if self.g and self.color_of(token) and self.phase == "playing":
            p = self.players[token]
            return [self.fx("toast", icon="🛰",
                            msg="%s dropped — autopilot holds their seat" % p.name)]
        return []

    def game_player_back(self, token):
        if self.g and self.color_of(token):
            p = self.players[token]
            return [self.fx("toast", icon=p.avatar, msg="%s is back" % p.name)]
        return []

    # ---------------- serialization ----------------

    def game_state(self, viewer_token):
        g = self.g
        if g is None:
            return None
        seats = {}
        for c, t in g["seats"].items():
            p = self.players.get(t)
            seats[c] = {
                "pid": p.pid if p else None,
                "auto": p is None or p.is_bot or not p.connected,
            }
        my_color = self.color_of(viewer_token) if viewer_token else None
        st = {
            "stage": self.phase,
            "seats": seats,
            "my_color": my_color,
            "turn": self.current_color() if self.phase == "playing" else None,
            "turn_seconds": self.settings["turn_seconds"],
            "draw_offer": g["draw_offer"],
            "takeback_offer": g["takeback_offer"],
            "supports": {"takeback": self.SUPPORTS_TAKEBACK,
                         "draw": self.SUPPORTS_DRAW},
            "result": g["result"],
        }
        st.update(self.duel_state(viewer_token))
        return st

    # ---------------- subclass contract ----------------

    def duel_start(self):
        raise NotImplementedError

    def current_color(self):
        raise NotImplementedError

    def duel_move(self, token, color, msg):
        raise NotImplementedError

    def duel_auto(self, color):
        raise NotImplementedError

    def duel_takeback(self, color):
        return [self.fx("toast", msg="Takeback not supported")]

    def duel_state(self, viewer_token):
        return {}
