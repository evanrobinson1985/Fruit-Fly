"""Plots and animation for a finished simulation."""
from __future__ import annotations

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.animation import FuncAnimation, PillowWriter

STATE_COLORS = {"walking": "#3b6ea8", "backing": "#8a5cc2", "feeding": "#2e9e5b",
                "takeoff": "#d1495b", "flying": "#d1495b"}


def _arena(ax, world):
    h = world.size / 2
    if world.odors:
        g = np.linspace(-h, h, 200)
        X, Y = np.meshgrid(g, g)
        ax.imshow(world.conc(X, Y), extent=(-h, h, -h, h), origin="lower", cmap="Oranges", alpha=0.6)
    for f in world.food:
        ax.add_patch(plt.Circle((f.x, f.y), f.r, color="#2e9e5b", alpha=0.6))
    ax.set_xlim(-h, h)
    ax.set_ylim(-h, h)
    ax.set_aspect("equal")
    ax.set_xlabel("mm")


def summary(sim, log, spikes, path):
    groups = ["forward", "backward", "turn", "escape", "feed"]
    fig = plt.figure(figsize=(14, 8))
    gs = fig.add_gridspec(3, 2, width_ratios=[1, 1.4])
    ax = fig.add_subplot(gs[:, 0])
    _arena(ax, sim.world)
    for st, col in STATE_COLORS.items():
        d = log[log.state == st]
        ax.scatter(d.x, d.y, s=3, color=col, label=st)
    ax.plot(log.x.iloc[0], log.y.iloc[0], "k^", ms=8, label="start")
    ax.legend(loc="upper right", fontsize=8, markerscale=3)
    ax.set_title("Trajectory")

    ax = fig.add_subplot(gs[0, 1])
    ax.plot(log.t, log.odor_L, label="odor L")
    ax.plot(log.t, log.odor_R, label="odor R")
    lmax = max(1.0, log.loom_L.max(), log.loom_R.max())
    ax.plot(log.t, log.loom_L / lmax, label="loom L (norm)")
    ax.plot(log.t, log.loom_R / lmax, label="loom R (norm)")
    ax.plot(log.t, log.taste.astype(float), label="taste")
    ax.legend(fontsize=8, ncol=4)
    ax.set_title("Sensory input")

    ax = fig.add_subplot(gs[1, 1], sharex=ax)
    for g in groups:
        ax.plot(log.t, (log[f"{g}_L"] + log[f"{g}_R"]) / 2, label=g)
    ax.set_ylabel("Hz")
    ax.legend(fontsize=8, ncol=5)
    ax.set_title("Motor neuron groups (smoothed rate)")

    ax = fig.add_subplot(gs[2, 1], sharex=ax)
    types = list(dict.fromkeys(spikes.type))
    ymap = {t: k for k, t in enumerate(types)}
    ax.scatter(spikes.t_ms * 1e-3, spikes.type.map(ymap) + np.random.uniform(-0.35, 0.35, len(spikes)),
               s=0.3, color="k")
    ax.set_yticks(range(len(types)), types, fontsize=7)
    ax.set_xlabel("time (s)")
    ax.set_title("Spike raster (sensory and motor types)")
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)


def animate(sim, log, path, fps=25):
    stride = max(1, int(round(1 / (fps * (log.t.iloc[1] - log.t.iloc[0])))))
    frames = log.iloc[::stride].reset_index(drop=True)
    fig, ax = plt.subplots(figsize=(6, 6))
    _arena(ax, sim.world)
    trail, = ax.plot([], [], "-", color="#3b6ea8", lw=1)
    body, = ax.plot([], [], "o", color="k", ms=6)
    head, = ax.plot([], [], "-", color="k", lw=2)
    txt = ax.text(0.02, 0.97, "", transform=ax.transAxes, va="top", fontsize=9, family="monospace")

    def draw(k):
        r = frames.iloc[k]
        trail.set_data(log.x[log.t <= r.t], log.y[log.t <= r.t])
        body.set_data([r.x], [r.y])
        h = np.radians(r.heading)
        head.set_data([r.x, r.x + 6 * np.cos(h)], [r.y, r.y + 6 * np.sin(h)])
        body.set_color(STATE_COLORS.get(r.state, "k"))
        txt.set_text(f"t={r.t:5.2f}s {r.state}\nP9={(r.forward_L + r.forward_R) / 2:5.1f}Hz "
                     f"GF={max(r.escape_L, r.escape_R):5.1f}Hz MN9={max(r.feed_L, r.feed_R):5.1f}Hz")
        return trail, body, head, txt

    anim = FuncAnimation(fig, draw, frames=len(frames), blit=True)
    anim.save(path, writer=PillowWriter(fps=fps))
    plt.close(fig)
