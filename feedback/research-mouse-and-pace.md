**Research brief for Derby Day: mouse handling and game pace**

WebFetch failed in this sandbox (DNS error), so everything below comes from search-result snippets. "[Judgment]" marks my own engineering recommendation with no source behind it. "[Unverified]" marks a figure I could not source.

**1. Click vs hold**
- I found no reliable measured mouse click dwell time (mousedown to mouseup). [Unverified] My recollection is roughly 80–150 ms for a deliberate click.
- Platform long-press timeouts are far longer. Android's default is about 500 ms, and a tap fires at long-press minus 1 ms ([Android](https://developer.android.com/reference/android/view/ViewConfiguration)).
- Trackpad taps need touch-down and touch-up within an implementation-defined timeout, with movement under a threshold ([libinput](https://wayland.freedesktop.org/libinput/doc/latest/tapping.html)). One tool uses 500 ms. [Unverified]
- Recommendations:
  1. [Judgment] Fire the pass on release, never on a timer. A press under about 220–250 ms is a normal click, which gives a flat, well-weighted ground pass. This never misreads a click, and 250 ms leaves margin for slow trackpad taps.
  2. [Judgment] Start the charge indicator at about 250 ms. Reach full loft or power at about 700–900 ms.
  3. [Judgment] Ignore pointer drift of up to roughly 8 px during a hold, and use `pointerType` to apply a slightly longer threshold for touch and trackpad.

**2. Pointer movement**
- Use the "arrive" steering model: full speed beyond a slowing radius, speed scaled by `distance/slowingRadius` inside it, and a small arrival radius that stops jitter ([Reynolds](https://www.red3d.com/cwr/steer/Arrival.html)).
- Smooth velocity by lerping toward the desired velocity each frame.
- For pointer smoothing, use the One Euro filter. Set beta to 0, lower `min_cutoff` until the still pointer is calm, then raise beta until fast moves feel lag-free. The reference default is `min_cutoff` 1.0 ([Casiez](https://gery.casiez.net/1euro/), [tuning recipe](https://animovement.dev/aniprocess/reference/filter_one_euro.html)).
- When only the camera moves, a stored pointer position goes stale. Keep the normalized pointer coordinates and re-raycast against the ground plane every frame after the camera updates ([three.js forum](https://discourse.threejs.org/t/the-mouse-position-in-3d-on-a-plane/47699)).
- Haxball uses per-tick exponential damping. Player damping is 0.96, acceleration 0.1, ball damping 0.99 and kick strength 5 ([haxmods](https://haxmods.com/map/?id=78)). These are community-reported numbers.
- I found no sourced MOBA/RTS or Football Manager dead-zone values.
- Recommendations:
  1. [Judgment] Use a dead zone of about 0.5–1 m around the player.
  2. [Judgment] Ramp speed from jog to sprint over about 3–12 m of pointer distance.
  3. [Judgment] Cap the turn rate lower at sprint than at jog.

**3. Passing assistance and tiki-taka**
- EA recommends the ground pass for nearby teammates and short combinations ([EA](https://help.ea.com/en/articles/ea-sports-fc/how-to-pass/)).
- Assisted passing picks the target for you. Manual passing lets you place the ball on a specific side of the receiver's foot.
- eFootball's pass levels 1–2 add speed assistance, level 3 uses the power gauge for low passes, and level 4 is fully manual ([Konami](https://www.konami.com/efootball/en/page/2023/season2_patch-notes_v2-20)).
- Recommendations:
  1. [Judgment] Make a plain click an assisted pass. Snap to the receiver nearest the pointer inside a cone of about 25–30°. Set speed from distance so the ball arrives in about 0.4–0.8 s. Lead the pass toward the receiver's run, and allow first-time passes.
  2. [Judgment] Keep hold-to-loft and power as the manual layer.
  3. [Judgment] Aim for under 150 ms between a click and the ball leaving the foot.

**4. Pace numbers**
- Speed zones: high-speed running is 5.5–7 m/s and a sprint is 7 m/s or more. Distance per match is 9–11 km, about 1.9 m/s on average ([PMC review](https://pmc.ncbi.nlm.nih.gov/articles/PMC9968809/)). The 1.9 m/s is my arithmetic.
- Acceleration: pro 10 m times are 1.65–1.75 s ([PoinT GO](https://research.poin-t-go.com/en/sports/soccer/sprint-acceleration-testing)). My arithmetic gives about 7 m/s² average from a standing start. Counted high-intensity accelerations start at 2 m/s².
- Peak speed: some athletes exceed 35 km/h (about 9.7 m/s). [Unverified]
- Ball speed: maximal male kicks are about 27.9 m/s instep and 26.9 m/s side-foot ([ScienceDirect](https://www.sciencedirect.com/science/article/pii/S1877705816306634)).
- I found no sourced typical pass speed. [Judgment] Use about 10–15 m/s for short passes, 18–25 m/s for long passes and 25–32 m/s for shots.
- Passing volume: Opta reports an average sequence of 10.4 s and 12.6 m of progress, and 14.4 m for Man City ([Opta](https://theanalyst.com/articles/analysing-premier-league-playing-styles-2024-25)).
- Man City completed 543.7 passes per match ([FotMob](https://www.fotmob.com/leagues/47/stats/season/23685/teams/accurate_pass_team/premier-league-teams)). With about 55 minutes of ball in play ([90min](https://www.90min.com/posts/how-long-is-an-average-premier-league-match)), that is roughly 10 passes per minute, or one every 6 s (my arithmetic).
- Opta defines a long ball as 32 m or more.
- Grass friction: I found no sourced coefficient. DIN 18035-7 measures roll deceleration in m/s² ([ISSS](https://www.isss-sportsurfacescience.org/downloads/documents/ZPKPAJJUWY_Ball_Roll_BehaviorKS.pdf)). [Judgment] Tune by feel so a 20 m/s ground pass keeps about 70% of its speed over 30 m. Use damping proportional to speed plus a small constant drag.
- Recommendation: scale player speed so sprint to jog stays about 2.5:1, and keep the ball clearly faster than any sprinter.

**5. Camera**
- FC guides advise Tele Broadcast at height 10 and zoom 0 for competitive play. Co-Op is the widest option, at height 17–20 with zoom 0–3. They suggest zoom below 5 and height 10–17 ([FC 26 guide](https://fifauteam.com/fc-26-camera/)).
- I found no pitch-visibility percentages and no goal-kick camera behavior.
- Recommendations:
  1. [Judgment] Frame at least 60 m of pitch length along the play axis, and keep every teammate within passing range on screen.
  2. [Judgment] Offer three presets: Tele, Wide and Co-op.
  3. [Judgment] Pull the camera out for goal kicks to show about 75% of the pitch, and ease back in over about 1 s once the ball is played.

**6. Replays**
- FC replays offer a timeline, speed control and a choice of camera. FIFA 21 had nine camera views ([FIFAUTeam](https://fifauteam.com/fc-24-replays-match-highlights/)).
- Skip is both bumpers together, or Left Shift+T on PC ([VideoGamer](https://www.videogamer.com/news/fifa-23-how-to-skip-replays/)).
- I found no replay-length figures. [Unverified]
- A compact way to record is to store the initial state plus the inputs ([Game Developer](https://www.gamedeveloper.com/design/instant-replay-building-a-game-engine-with-reproducible-behavior)).
- Recommendations:
  1. [Judgment] Trigger automatic replays for goals, penalties, red cards, big saves and woodwork.
  2. [Judgment] Make a yellow card an optional replay.
  3. [Judgment] Keep goal replays to 6–10 s with two angles, slow motion at 0.5× on the last 2 s, and skip on any click after 0.4 s.
  4. [Judgment] Keep a ring buffer of about 12 s of positions at 30 Hz.