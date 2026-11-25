# Original frog model preservation

The original two-frog asset is preserved byte-for-byte at `web/assets/frogs-original.glb`.

- Original source path before the AFK rigging work: `web/assets/frogs.glb`
- Original Git blob SHA: `455d308063bf89f7646435bb979713bb463ce193`
- Original size: 15,884,880 bytes

Do not overwrite or delete this archived asset. Any AFK-rigged exports must use separate filenames (for example, `frogs-afk.glb`) so the original meshes and existing rig remain available for future custom rigging experiments.

## In use

The game loads `frogs-original.glb` directly (read-only) for its frogs: the detailed meshes,
eyes and textures with the author's Rigify skin weights. `web/src/predators.js` re-rigs them
when they load (each deform bone re-parented to its anatomical parent without moving, eyes
attached to the head) and poses them procedurally. The file itself is never modified.
`frogs-animated.glb` (the AFK rig) is no longer used.
