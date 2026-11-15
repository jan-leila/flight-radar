#include "radar_label.h"
#include <stdlib.h>

#define EDGE 2             // boxes keep this far from the screen edge
#define FALLBACK_DX 10
#define FALLBACK_DY (-8)
#define NUDGE 4            // step towards the centre of a round screen
#define NUDGE_LIMIT 30

// Candidate positions, best first. x > 0: the box starts that far right of the aircraft; x < 0: it ends that far
// left of it; x == 0: centred on it. y is the offset of the box's top edge.
static const RadarPoint CANDIDATES[] = {
  {10, -8}, {10, 6}, {-10, -8}, {-10, 6}, {0, -28}, {0, 16},
  {30, -20}, {-30, -20}, {30, 20}, {-30, 20}, {0, -50}, {0, 40},
};

static bool contains(RadarBox box, int x, int y) {
  return x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
}

bool radar_label_segment_hits(RadarPoint a, RadarPoint b, RadarBox box) {
  int max_x = a.x > b.x ? a.x : b.x, min_x = a.x < b.x ? a.x : b.x;
  int max_y = a.y > b.y ? a.y : b.y, min_y = a.y < b.y ? a.y : b.y;
  if (max_x < box.x || min_x > box.x + box.w || max_y < box.y || min_y > box.y + box.h) return false;
  if (contains(box, a.x, a.y) || contains(box, b.x, b.y)) return true;
  int dx = b.x - a.x, dy = b.y - a.y;
  int longest = abs(dx) > abs(dy) ? abs(dx) : abs(dy);
  int steps = longest < 10 ? 2 : longest / 5;
  for (int i = 1; i < steps; i++) {
    if (contains(box, a.x + i * dx / steps, a.y + i * dy / steps)) return true;
  }
  return false;
}

bool radar_label_fits_round(RadarBox box, int screen_w, int screen_h) {
  int r = (screen_w < screen_h ? screen_w : screen_h) / 2 - EDGE;
  for (int corner = 0; corner < 4; corner++) {
    int dx = box.x + ((corner & 1) ? box.w : 0) - screen_w / 2;
    int dy = box.y + ((corner & 2) ? box.h : 0) - screen_h / 2;
    if (dx * dx + dy * dy > r * r) return false;
  }
  return true;
}

static bool path_hits(RadarBox box, RadarPoint anchor, RadarPoint origin, const RadarPoint *trail, int trail_n) {
  if (!trail || trail_n == 0) return false;
  RadarPoint from = {(int16_t)(trail[0].x + origin.x), (int16_t)(trail[0].y + origin.y)};
  for (int k = 1; k < trail_n; k++) {
    RadarPoint to = {(int16_t)(trail[k].x + origin.x), (int16_t)(trail[k].y + origin.y)};
    if (radar_label_segment_hits(from, to, box)) return true;
    from = to;
  }
  return radar_label_segment_hits(from, anchor, box);
}

RadarPoint radar_label_place(RadarPoint anchor, int w, int h, RadarScreen screen,
                             RadarPoint origin, const RadarPoint *trail, int trail_n) {
  for (size_t i = 0; i < sizeof(CANDIDATES) / sizeof(CANDIDATES[0]); i++) {
    int dx = CANDIDATES[i].x;
    int x = anchor.x + (dx < 0 ? dx - w : dx == 0 ? -(w / 2) : dx);
    int y = anchor.y + CANDIDATES[i].y;
    if (x < EDGE || x + w >= screen.width - 1 || y < EDGE || y + h >= screen.height - 1) continue;
    RadarBox box = {(int16_t)x, (int16_t)y, (int16_t)w, (int16_t)h};
    if (screen.round && !radar_label_fits_round(box, screen.width, screen.height)) continue;
    if (path_hits(box, anchor, origin, trail, trail_n)) continue;
    return (RadarPoint){(int16_t)x, (int16_t)y};
  }

  int x = anchor.x + FALLBACK_DX;
  int y = anchor.y + FALLBACK_DY;
  if (x + w >= screen.width - 1) x = screen.width - EDGE - w;
  if (x < EDGE) x = EDGE;
  if (y + h >= screen.height - 1) y = screen.height - EDGE - h;
  if (y < EDGE) y = EDGE;
  if (screen.round) {
    // Walk towards the centre, along the axis that is further off, until the box is inside the circle.
    for (int tries = 0; tries < NUDGE_LIMIT; tries++) {
      RadarBox box = {(int16_t)x, (int16_t)y, (int16_t)w, (int16_t)h};
      if (radar_label_fits_round(box, screen.width, screen.height)) break;
      int off_x = screen.width / 2 - (x + w / 2);
      int off_y = screen.height / 2 - (y + h / 2);
      if (off_x == 0 && off_y == 0) break;
      if (off_x != 0 && abs(off_x) > abs(off_y)) {
        x += off_x < 0 ? -NUDGE : NUDGE;
      } else {
        y += off_y < 0 ? -NUDGE : NUDGE;
      }
    }
  }
  return (RadarPoint){(int16_t)x, (int16_t)y};
}
