"""Command line: python -m flysim <scenario> [options]."""
from __future__ import annotations

import argparse
from pathlib import Path

from . import data, viz
from .body import Fly, Food, Looming, OdorSource, World
from .sim import Simulation

SCENARIOS = {
    "forage": lambda: (World(odors=[OdorSource(40, 30, sigma=25)], food=[Food(40, 30, r=5)]), Fly(x=-30, y=-20)),
    "escape": lambda: (World(looms=[Looming(t_start=0.5, azimuth=60)]), Fly()),
    "feed": lambda: (World(food=[Food(0, 0, r=8)]), Fly()),
    "explore": lambda: (World(), Fly()),
}


def main():
    ap = argparse.ArgumentParser(description="Closed-loop whole-CNS fruit fly simulation (MaleCNS v1.0).")
    ap.add_argument("scenario", nargs="?", default="forage", choices=[*SCENARIOS, "download"])
    ap.add_argument("--seconds", type=float, default=5.0)
    ap.add_argument("--preset", default="realistic", choices=["realistic", "shiu2024"])
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default="results")
    ap.add_argument("--gif", action="store_true", help="also write an animation")
    a = ap.parse_args()

    if a.scenario == "download":
        data.load()
        return
    world, fly = SCENARIOS[a.scenario]()
    print(f"Loading connectome and building '{a.preset}' brain...")
    sim = Simulation(world, fly, preset=a.preset, seed=a.seed)
    print(f"{sim.brain.n:,} neurons, {sim.brain.c.n_edges:,} connections. Running {a.seconds}s of '{a.scenario}'.")
    log = sim.run(a.seconds)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    stem = out / f"{a.scenario}-{a.preset}"
    log.to_csv(f"{stem}.csv", index=False)
    viz.summary(sim, log, sim.spikes(), f"{stem}.png")
    if a.gif:
        viz.animate(sim, log, f"{stem}.gif")
    counts = log.state.value_counts().to_dict()
    print(f"States (steps): {counts}; time feeding: {fly.food_eaten:.2f}s")
    print(f"Wrote {stem}.csv and {stem}.png" + (f" and {stem}.gif" if a.gif else ""))


if __name__ == "__main__":
    main()
