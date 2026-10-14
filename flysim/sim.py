"""Closed loop: world -> sensory neurons -> whole-CNS spiking network -> descending neurons -> body."""
from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import data, model
from .body import Fly, World
from .interface import Interface


@dataclass
class Simulation:
    world: World
    fly: Fly = field(default_factory=Fly)
    preset: str = "realistic"
    odor: str = "vinegar"
    step_ms: float = 20.0       # brain/body exchange interval
    smooth_ms: float = 60.0     # motor rate smoothing time constant
    seed: int = 0
    connectome: data.Connectome | None = None
    io_kwargs: dict = field(default_factory=dict)  # overrides for Interface gains

    def __post_init__(self):
        c = self.connectome or data.load()
        self.io = Interface(c, odor=self.odor, **self.io_kwargs)
        sensory = np.concatenate([*self.io.orn.values(), *self.io.loom.values(), self.io.grn])
        self.brain = model.make_brain(c, self.preset, seed=self.seed,
                                      monitor=np.concatenate([sensory, self.io.readout]))
        self.rng = np.random.default_rng(self.seed)
        self.log = []
        self._smooth = None
        self._loom_onsets = {}

    def run(self, seconds: float, progress: bool = True) -> pd.DataFrame:
        dt = self.step_ms * 1e-3
        n = int(round(seconds / dt))
        t_wall = time.time()
        for k in range(n):
            t = self.brain.time_ms * 1e-3
            sense = self.fly.sense(self.world, t, self._loom_onsets)
            self.brain.clear_rates()
            for idx, hz in self.io.sensory_rates(sense):
                if len(idx) and hz > 0:
                    self.brain.set_rates(idx, hz)
            counts = self.brain.run(self.step_ms)
            m = self.io.motor_rates(counts, self.step_ms)
            a = min(1.0, self.step_ms / self.smooth_ms)
            if self._smooth is None:
                self._smooth = m
            else:
                self._smooth = {g: {s: (1 - a) * self._smooth[g][s] + a * m[g][s] for s in "LR"} for g in m}
            threat = next(iter(self._loom_onsets.values()), None)
            state = self.fly.act(self._smooth, dt, self.world, self.rng, threat_az=threat)
            self.log.append({
                "t": t + dt, "x": self.fly.x, "y": self.fly.y, "heading": self.fly.heading,
                "speed": self.fly.speed, "state": state, "food_s": self.fly.food_eaten,
                "odor_L": sense["odor"]["L"], "odor_R": sense["odor"]["R"],
                "loom_L": sense["loom"]["L"], "loom_R": sense["loom"]["R"], "taste": sense["taste"],
                "active_neurons": int((counts > 0).sum()),
                **{f"{g}_{s}": self._smooth[g][s] for g in self._smooth for s in "LR"},
            })
            if progress and (k + 1) % max(1, n // 10) == 0:
                el = time.time() - t_wall
                print(f"  t={t + dt:5.2f}s  wall={el:6.1f}s  ({el / (t + dt):.1f}x real time)  state={state}")
        return pd.DataFrame(self.log)

    def spikes(self) -> pd.DataFrame:
        t, i = self.brain.spike_events()
        nn = self.brain.c.neurons
        return pd.DataFrame({"t_ms": t, "idx": i, "type": nn["type"].values[i], "side": nn["side"].values[i]})
