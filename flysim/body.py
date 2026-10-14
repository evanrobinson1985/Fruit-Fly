"""A walking fly in a 2D arena, with odor sources, food patches and looming threats.

Units: mm, s, degrees. The body is kinematic: descending-neuron rates set
walking speed and turn rate directly, scaled to measured fly kinematics
(walking up to ~30 mm/s, saccadic turns up to ~500 deg/s; Strauss & Heisenberg 1990,
Geurten et al. 2014). Without descending commands the fly keeps exploring with a
slow random walk, standing in for the VNC's own locomotor pattern generators,
which are outside what this model drives.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class OdorSource:
    x: float
    y: float
    strength: float = 1.0
    sigma: float = 15.0  # plume width, mm

    def conc(self, x, y):
        return self.strength * np.exp(-((x - self.x) ** 2 + (y - self.y) ** 2) / (2 * self.sigma ** 2))


@dataclass
class Food:
    x: float
    y: float
    r: float = 3.0


@dataclass
class Looming:
    """A dark disc approaching the fly at constant speed (like a predator or swatter)."""
    t_start: float           # s
    azimuth: float           # deg, relative to the fly's heading at onset; + is left
    radius: float = 5.0      # mm
    speed: float = 500.0     # mm/s
    d0: float = 300.0        # start distance, mm

    def state(self, t):
        """Angular size (deg) and expansion rate (deg/s) at time t, or None."""
        if t < self.t_start:
            return None
        d = self.d0 - self.speed * (t - self.t_start)
        if d <= self.radius:
            return None
        theta = 2 * np.degrees(np.arctan(self.radius / d))
        dtheta = 2 * np.degrees(self.radius * self.speed / (d ** 2 + self.radius ** 2))
        return theta, dtheta


@dataclass
class World:
    size: float = 200.0
    odors: list = field(default_factory=list)
    food: list = field(default_factory=list)
    looms: list = field(default_factory=list)

    def conc(self, x, y):
        return sum(o.conc(x, y) for o in self.odors)

    def on_food(self, x, y):
        return any((x - f.x) ** 2 + (y - f.y) ** 2 < f.r ** 2 for f in self.food)


@dataclass
class Fly:
    x: float = 0.0
    y: float = 0.0
    heading: float = 0.0     # deg, 0 = +x, counter-clockwise positive
    speed: float = 0.0       # mm/s
    turn: float = 0.0        # deg/s
    airborne: float = 0.0    # remaining flight time after a takeoff, s
    feeding: bool = False
    food_eaten: float = 0.0  # s spent feeding
    antenna_sep: float = 0.4 # mm between antennae

    # Kinematic gains: DN rate (Hz) -> movement.
    base_speed: float = 5.0          # exploratory walking, mm/s
    max_speed: float = 30.0
    fwd_gain: float = 0.25           # mm/s per Hz of P9 rate
    back_gain: float = 0.3           # mm/s per Hz of MDN rate
    turn_gain: float = 4.0           # deg/s per Hz of left-right DNa difference
    explore_turn_sd: float = 120.0   # deg/s, random-walk turning
    escape_hz: float = 50.0          # Giant Fiber rate that triggers takeoff
    feed_hz: float = 20.0            # MN9 rate that counts as proboscis extension
    feed_bout: float = 1.0           # s; a proboscis extension starts a feeding bout this long
    bout_left: float = 0.0

    def antennae(self):
        h = np.radians(self.heading)
        fx, fy = self.x + 1.2 * np.cos(h), self.y + 1.2 * np.sin(h)
        lx, ly = -np.sin(h), np.cos(h)
        s = self.antenna_sep / 2
        return {"L": (fx + s * lx, fy + s * ly), "R": (fx - s * lx, fy - s * ly)}

    def sense(self, world: World, t: float, loom_onsets: dict) -> dict:
        odor = {s: world.conc(*p) for s, p in self.antennae().items()}
        loom = {"L": 0.0, "R": 0.0}
        for i, lo in enumerate(world.looms):
            st = lo.state(t)
            if st is None:
                continue
            az = loom_onsets.setdefault(i, self.heading + lo.azimuth) - self.heading
            az = (az + 180) % 360 - 180
            # Each eye sees its own side plus ~20 deg of frontal binocular overlap.
            if az > -20:
                loom["L"] += st[1]
            if az < 20:
                loom["R"] += st[1]
        return {"odor": odor, "loom": loom, "taste": world.on_food(self.x, self.y)}

    def act(self, m: dict, dt: float, world: World, rng: np.random.Generator, threat_az=None):
        """Advance the body by dt seconds given motor-group rates `m` (Hz)."""
        gf = max(m["escape"]["L"], m["escape"]["R"])
        if self.airborne > 0:
            self.airborne -= dt
            self.x += np.cos(np.radians(self.heading)) * 200 * dt
            self.y += np.sin(np.radians(self.heading)) * 200 * dt
            self._clip(world)
            return "flying"
        if gf > self.escape_hz:
            # Takeoff directed away from the threat (Card & Dickinson 2008).
            if threat_az is not None:
                self.heading = threat_az + 180
            self.airborne = 0.1
            self.feeding = False
            return "takeoff"
        on_food = world.on_food(self.x, self.y)
        if on_food and max(m["feed"]["L"], m["feed"]["R"]) > self.feed_hz:
            self.bout_left = self.feed_bout
        self.bout_left = max(0.0, self.bout_left - dt) if on_food else 0.0
        self.feeding = self.bout_left > 0
        if self.feeding:
            self.speed = 0.0
            self.food_eaten += dt
            return "feeding"
        fwd = np.mean([m["forward"]["L"], m["forward"]["R"]])
        back = np.mean([m["backward"]["L"], m["backward"]["R"]])
        target = np.clip(self.base_speed + self.fwd_gain * fwd - self.back_gain * back, -10, self.max_speed)
        self.speed += (target - self.speed) * min(1.0, dt / 0.1)
        turn_cmd = self.turn_gain * (m["turn"]["L"] - m["turn"]["R"])
        self.turn = turn_cmd + rng.normal(0, self.explore_turn_sd)
        self.heading = (self.heading + self.turn * dt) % 360
        h = np.radians(self.heading)
        self.x += self.speed * np.cos(h) * dt
        self.y += self.speed * np.sin(h) * dt
        self._clip(world)
        return "walking" if target >= 0 else "backing"

    def _clip(self, world: World):
        half = world.size / 2
        if abs(self.x) > half or abs(self.y) > half:
            self.x, self.y = np.clip(self.x, -half, half), np.clip(self.y, -half, half)
            self.heading = (self.heading + 180) % 360  # arena wall: turn back
