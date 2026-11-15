// Pure-C placement of the text box next to an aircraft (no pebble.h; host-tested, CONTRACTS.md §8).
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "radar_model.h"

typedef struct {
  int16_t x, y, w, h;
} RadarBox;

// The screen an aircraft's box has to stay on. On a round screen the box has to fit inside the circle.
typedef struct {
  int16_t width, height;
  bool round;
} RadarScreen;

// Where the box of size w x h goes for an aircraft drawn at `anchor`: the first of twelve positions around the
// aircraft that is on screen and, when `trail` is given, not crossed by the flight path; otherwise up and to the
// right of the aircraft, pushed back on screen. The path is `trail[0..trail_n)` (offsets from `origin`) followed by
// the aircraft itself. Returns the top-left corner.
RadarPoint radar_label_place(RadarPoint anchor, int w, int h, RadarScreen screen,
                             RadarPoint origin, const RadarPoint *trail, int trail_n);

// True when the segment a-b touches the box (tested at its ends and at points about 5 px apart along it).
bool radar_label_segment_hits(RadarPoint a, RadarPoint b, RadarBox box);

// True when all four corners of the box are inside the round screen, 2 px in from its edge.
bool radar_label_fits_round(RadarBox box, int screen_w, int screen_h);
