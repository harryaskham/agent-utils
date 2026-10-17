"""Inline SVG figures for the Agent Utils site.

Authored near the width they render (700 for the text column) and styled by classes in
site/assets/site.css. Colour roles follow the label-maker tapes: speech (red), screens
(blue), sessions (black), fleet (green), web (yellow), plus plain and ink.

FIGURES maps a name to a function returning one <svg>.
"""

from __future__ import annotations

from html import escape

ROLES = ("speech", "screens", "sessions", "fleet", "web", "ink")
W_BOLD = 8.0
W_BODY = 6.6
W_MONO = 7.2


class Svg:
    def __init__(self, name: str, w: int, h: int, title: str, desc: str):
        self.name, self.w, self.h, self.title, self.desc = name, w, h, title, desc
        self.parts: list[str] = []

    def add(self, s: str) -> None:
        self.parts.append(s)

    def text(self, x, y, s, cls="f-s", anchor="start") -> None:
        a = "" if anchor == "start" else f' text-anchor="{anchor}"'
        if s.startswith(" ") or "  " in s:
            a += ' xml:space="preserve"'
        self.add(f'<text x="{x}" y="{y}" class="{cls}"{a}>{escape(s)}</text>')

    def rect(self, x, y, w, h, cls, r=6) -> None:
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" class="{cls}"/>')

    def wire(self, pts, role="ink", arrow=True, dashed=False) -> None:
        d = "M" + " L".join(f"{x} {y}" for x, y in pts)
        m = f' marker-end="url(#{self.name}-a-{role})"' if arrow else ""
        self.add(f'<path d="{d}" class="wire s-{role}{" dash" if dashed else ""}"{m}/>')

    def curve(self, x1, y1, x2, y2, role="ink", arrow=True, dashed=False) -> None:
        mx = (x1 + x2) / 2
        m = f' marker-end="url(#{self.name}-a-{role})"' if arrow else ""
        self.add(f'<path d="M{x1} {y1} C{mx} {y1} {mx} {y2} {x2} {y2}" class="wire s-{role}{" dash" if dashed else ""}"{m}/>')

    def box(self, x, y, w, h, role, title, sub=(), mono=False) -> None:
        self.rect(x, y, w, h, f"b-{role}", 8)
        lines = [sub] if isinstance(sub, str) else list(sub)
        total = 16 + 16 * len(lines)
        ty = y + (h - total) / 2 + 13
        self.text(x + 12, ty, title, "f-t")
        for i, s in enumerate(lines):
            self.text(x + 12, ty + 18 + 16 * i, s, "f-m" if mono else "f-s")

    def label(self, x, y, s, cls="f-xs", anchor="middle", per=6.4) -> None:
        w = len(s) * per + 10
        x0 = x - w / 2 if anchor == "middle" else (x - 5 if anchor == "start" else x - w + 5)
        self.rect(round(x0, 1), y - 13, round(w, 1), 18, "labbg", 3)
        self.text(x, y, s, cls, anchor)

    def tapelabel(self, x, y, s, role) -> float:
        """A label-maker tape with notched ends; returns its width."""
        w = len(s) * 10.4 + 26
        pts = f"{x},{y} {x + w},{y} {x + w - 6},{y + 13} {x + w},{y + 26} {x},{y + 26} {x + 6},{y + 13}"
        self.add(f'<polygon points="{pts}" class="m-{role}"/>')
        self.text(x + w / 2, y + 18, s, "f-d" if role != "web" else "f-d f-ink", "middle")
        return w

    def svg(self) -> str:
        n = self.name
        marks = "".join(
            f'<marker id="{n}-a-{r}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
            f'orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="m-{r}"/></marker>' for r in ROLES)
        return (f'<svg class="f" viewBox="0 0 {self.w} {self.h}" width="{self.w}" height="{self.h}" role="img" '
                f'aria-labelledby="{n}-t {n}-d"><title id="{n}-t">{escape(self.title)}</title>'
                f'<desc id="{n}-d">{escape(self.desc)}</desc><defs>{marks}</defs>\n' + "\n".join(self.parts) + "\n</svg>")


# ============================================================================ speech

def speech() -> str:
    s = Svg(
        "speech", 700, 400, "From words to a speaker",
        "On the left, four sources of speech: read-aloud of what you send, verbatim spoken replies, one-line narration "
        "around tool batches, and spoken choices. Each goes to a configured audio provider, Azure, OpenAI, a speech "
        "daemon or a local command. Synthesised audio joins one machine-wide playback queue shared by every Pi "
        "session: a spool with atomic directory locks, one clip at a time with a two-second overlap. From the queue, "
        "audio plays through PulseAudio, where focus and solo routing can redirect it. Every request is also written "
        "to a durable speech feed that ag tts tail follows across the fleet. A mute policy per kind, with epochs, "
        "stops muted speech and keeps queued speech from replaying after an unmute.",
    )
    srcs = [(20, "/read", "what you send"), (80, "/tts", "assistant replies"), (140, "/narrate", "tool-batch lines"), (200, "choices", "spoken questions")]
    for y, t, sub in srcs:
        s.box(0, y, 150, 50, "speech", t, sub)
        s.curve(152, y + 25, 196, 135, "speech")
    s.box(200, 96, 140, 78, "plain", "provider", ("azure · openai", "daemon · command"))
    s.wire([(342, 135), (380, 135)], "speech")
    s.rect(384, 70, 150, 130, "b-sessions", 6)
    s.text(398, 94, "playback queue", "f-t")
    s.text(398, 114, "machine-wide", "f-s")
    s.text(398, 132, "atomic dir locks", "f-s")
    s.text(398, 150, "1 at a time", "f-s")
    s.text(398, 168, "2 s overlap", "f-s")
    s.text(398, 186, "1 GiB spool cap", "f-s")
    s.curve(536, 110, 560, 60, "speech")
    s.box(562, 30, 138, 60, "speech", "PulseAudio", ("focus · solo", "routing"))
    s.curve(536, 160, 560, 200, "fleet")
    s.box(562, 172, 138, 60, "fleet", "speech feed", ("every request,", "played or not"))
    s.rect(200, 290, 334, 92, "b-plain", 6)
    s.text(214, 314, "mute policy, per kind", "f-t")
    s.text(214, 334, "read · tts · narrate · choices", "f-m")
    s.text(214, 354, "each mute advances an epoch;", "f-s")
    s.text(214, 372, "queued speech from an old epoch never plays", "f-s")
    s.wire([(458, 288), (458, 204)], "ink", dashed=True)
    return s.svg()


# ============================================================================ sessions

def choices() -> str:
    s = Svg(
        "choices", 700, 340, "One question, many ways to answer",
        "An agent asks a question with interactive_choice, which blocks, or async_choice, which returns at once. "
        "The question enters one choice state machine in Pi. Answers can come from many inputs: the keyboard with "
        "arrows, j and k, numbers and Enter; push-to-talk speech; an Omni keystroke cast from another device; a ring "
        "controller; any Agent Host Protocol client such as a phone app; and the agent orchestrator's mobile decision "
        "queue. Whichever answers first settles the question exactly once, and the answer returns to the agent, as "
        "the tool result for a blocking choice or as a steering message for an async one.",
    )
    s.box(0, 130, 150, 70, "sessions", "agent", ("interactive_choice", "async_choice"))
    s.wire([(152, 165), (246, 165)], "sessions")
    s.rect(250, 110, 180, 110, "b-sessions", 8)
    s.text(264, 136, "choice state", "f-t")
    s.text(264, 156, "one per question", "f-s")
    s.text(264, 176, "settles exactly once", "f-s")
    s.text(264, 196, "survives reload", "f-s")
    ins = [(10, "keyboard", "arrows · 1–9 · Enter"), (64, "push-to-talk", "spoken answer"), (118, "Omni", "cast from a device"),
           (172, "ring", "gesture controller"), (226, "AHP clients", "phone, web"), (280, "orchestrator", "mobile decisions")]
    for y, t, sub in ins:
        s.box(520, y, 180, 46, "plain", t, sub)
        s.curve(518, y + 23, 434, 165, "screens")
    s.text(0, 240, "the answer returns as the tool result,", "f-xs")
    s.text(0, 258, "or as a steering message for async", "f-xs")
    return s.svg()


# ============================================================================ fleet

def agfan() -> str:
    s = Svg(
        "agfan", 700, 350, "ag across the fleet",
        "On the left, one ag command on a laptop. It reaches every enabled node concurrently over SSH. Each node "
        "keeps durable local archives: a speech feed, shared images with checksum sidecars, shared audio, and a "
        "Paratenic host with pending questions. ag tails and mutes speech, pulls images and audio incrementally with "
        "rsync into a private local cache and gallery, lists and answers questions, and checks each node's health. "
        "ag dash serves all of it as one live local web page.",
    )
    s.box(0, 120, 160, 80, "fleet", "ag", ("tts · image · audio", "choices · doctor · dash"))
    for i, y in enumerate([20, 120, 220]):
        s.curve(162, 160, 290, y + 40, "fleet")
        s.rect(294, y, 220, 84, "b-plain", 6)
        s.text(308, y + 22, f"node {chr(97 + i)}", "f-t")
        s.text(308, y + 42, "speech feed · images", "f-s")
        s.text(308, y + 60, "shared audio · Paratenic", "f-s")
    s.text(80, 222, "SSH, concurrent", "f-xs", "middle")
    s.box(560, 120, 140, 80, "web", "ag dash", ("one live page", "on localhost"))
    s.wire([(120, 230), (120, 330), (630, 330), (630, 204)], "fleet", dashed=True)
    s.label(400, 334, "local cache, gallery, player", "f-xs", per=8.4)
    return s.svg()


FIGURES = {
    "speech": speech,
    "choices": choices,
    "agfan": agfan,
}
